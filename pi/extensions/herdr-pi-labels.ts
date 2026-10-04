// Keep Herdr workspace labels at repo · worktree and pane labels at process or Pi session title.
// This makes Herdr's goto picker (prefix+g) useful across existing and newly created worktrees.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";

const STATE_PATH = join(homedir(), ".pi", "agent", "config", "herdr-pi-labels.json");
const STATE_LIMIT = 100;
const LOCK_PATH = `${STATE_PATH}.lock`;
const HERDR_COMMAND_TIMEOUT_MS = 2_000;
const PROCESS_LABEL_SYNC_INTERVAL_MS = 5_000;
const INTERPRETER_NAMES = new Set([
  "node",
  "ruby",
  "python",
  "python2",
  "python3",
  "perl",
  "php",
  "bun",
  "deno",
]);

type LabelState = {
  panes?: Record<string, string>;
  tabs?: Record<string, string>;
  workspaces?: Record<string, string>;
};

type Pane = {
  pane_id?: unknown;
  agent?: unknown;
  label?: unknown;
  cwd?: unknown;
  foreground_cwd?: unknown;
  terminal_title_stripped?: unknown;
  terminal_title?: unknown;
  focused?: unknown;
};

type ForegroundProcess = {
  argv?: unknown;
  argv0?: unknown;
  name?: unknown;
  pid?: unknown;
};

type ProcessInfo = {
  foreground_processes?: ForegroundProcess[];
  foreground_process_group_id?: unknown;
  shell_pid?: unknown;
};

type Workspace = {
  workspace_id?: unknown;
  label?: unknown;
  worktree?: {
    repo_name?: unknown;
    repo_root?: unknown;
    checkout_path?: unknown;
    is_linked_worktree?: unknown;
  };
};

type HerdrResponse = {
  result?: {
    pane?: Pane;
    panes?: Pane[];
    tab?: { label?: unknown };
    workspaces?: Workspace[];
    process_info?: ProcessInfo;
  };
};

type SyncRequest = {
  label: string | null;
  cwd: string;
  paneId: string;
  tabId?: string;
  generation: number;
};

type LabelRuntime = {
  stopped: boolean;
  generation: number;
  commands?: string[];
  preferredCommand?: string;
  interval?: ReturnType<typeof setInterval>;
  running?: Promise<void>;
  pending?: SyncRequest;
  cancelCommand?: () => void;
  shutdown?: Promise<void>;
};

function executable(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveHerdrCommands(): string[] {
  const candidates: Array<{ path: string; version?: string }> = [];
  const override = process.env.PI_CODE_HERDR_BIN ?? process.env.HERDR_BIN;
  if (override) candidates.push({ path: override });

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "herdr");
    if (executable(candidate)) candidates.push({ path: candidate });
  }

  try {
    candidates.push(
      ...fs
        .readdirSync("/nix/store")
        .map((entry) => {
          const match = /^[a-z0-9]+-herdr-(\d.*)$/.exec(entry);
          return match ? { path: join("/nix/store", entry, "bin", "herdr"), version: match[1] } : null;
        })
        .filter((candidate): candidate is { path: string; version: string } => Boolean(candidate && executable(candidate.path)))
        .sort((left, right) =>
          right.version.localeCompare(left.version, undefined, { numeric: true, sensitivity: "base" }),
        ),
    );
  } catch {
    // Non-Nix environments use the override or PATH candidates.
  }

  const commands = [...new Set(candidates.map((candidate) => candidate.path))];
  return commands.length > 0 ? commands : ["herdr"];
}

function enabled(): boolean {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
}

function isActive(runtime: LabelRuntime, request: SyncRequest): boolean {
  return !runtime.stopped && runtime.generation === request.generation && enabled();
}

function runHerdrCommand(runtime: LabelRuntime, command: string, args: string[]): Promise<HerdrResponse | null> {
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    function finish(stdout?: string): void {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (runtime.cancelCommand === cancel) runtime.cancelCommand = undefined;
      try {
        const parsed = JSON.parse(stdout ?? "") as HerdrResponse | null;
        resolve(parsed?.result ? parsed : null);
      } catch {
        resolve(null);
      }
    }

    function cancel(): void {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Still close output streams and let the completion deadline settle the request.
      }
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }

    try {
      child = execFile(command, args, { timeout: HERDR_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" }, (_error, stdout) => {
        finish(String(stdout));
      });
      runtime.cancelCommand = cancel;
      // Also bound completion if a descendant holds the CLI's output streams open.
      deadline = setTimeout(() => {
        cancel();
        finish();
      }, HERDR_COMMAND_TIMEOUT_MS + 500);
    } catch {
      cancel();
      finish();
    }
  });
}

async function execHerdr(runtime: LabelRuntime, request: SyncRequest, args: string[]): Promise<HerdrResponse | null> {
  if (!isActive(runtime, request)) return null;

  const candidates = runtime.commands ??= resolveHerdrCommands();
  const commands = runtime.preferredCommand
    ? [runtime.preferredCommand, ...candidates.filter((command) => command !== runtime.preferredCommand)]
    : candidates;

  for (const command of commands) {
    if (!isActive(runtime, request)) return null;
    const response = await runHerdrCommand(runtime, command, args);
    if (!isActive(runtime, request)) return null;
    if (response) {
      runtime.preferredCommand = command;
      return response;
    }
  }

  runtime.preferredCommand = undefined;
  return null;
}

function readState(): LabelState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return {
      panes: cleanRecord(parsed.panes),
      tabs: cleanRecord(parsed.tabs),
      workspaces: cleanRecord(parsed.workspaces),
    };
  } catch {
    return {};
  }
}

function cleanRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function prune(record: Record<string, string>): Record<string, string> {
  const entries = Object.entries(record);
  return entries.length <= STATE_LIMIT ? record : Object.fromEntries(entries.slice(-STATE_LIMIT));
}

function removeLockOwner(directory: string, owner: string): void {
  try {
    fs.unlinkSync(join(directory, owner));
  } catch {
    return;
  }
  try {
    // A new owner is published as a nonempty directory, so rmdir cannot remove it.
    fs.rmdirSync(directory);
  } catch {
    // Another owner may already have replaced the empty directory.
  }
}

function recoverDeadLock(): void {
  try {
    const owners = fs.readdirSync(LOCK_PATH);
    if (owners.length !== 1) return;
    const match = /^([1-9]\d*)-[a-f0-9-]{36}$/.exec(owners[0]);
    if (!match) return;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) return;
    try {
      process.kill(pid, 0);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
    }
    removeLockOwner(LOCK_PATH, owners[0]);
  } catch {
    // Unknown owners and permission errors are contention, not permission to steal.
  }
}

function acquireStateLock(): string | null {
  const owner = `${process.pid}-${randomUUID()}`;
  const staging = `${LOCK_PATH}.${owner}`;
  try {
    fs.mkdirSync(dirname(STATE_PATH), { recursive: true });
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.writeFileSync(join(staging, owner), "", { flag: "wx", mode: 0o600 });
    try {
      fs.renameSync(staging, LOCK_PATH);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      recoverDeadLock();
      fs.renameSync(staging, LOCK_PATH);
    }
    return owner;
  } catch {
    return null;
  } finally {
    removeLockOwner(staging, owner);
    try {
      fs.rmdirSync(staging);
    } catch {
      // Clean up even when creating the staged owner marker failed.
    }
  }
}

function serializeState(state: LabelState): string {
  return `${JSON.stringify(
    {
      panes: prune(state.panes ?? {}),
      tabs: prune(state.tabs ?? {}),
      workspaces: prune(state.workspaces ?? {}),
    },
    null,
    2,
  )}\n`;
}

function writeState(state: LabelState, previous: LabelState): void {
  const contents = serializeState(state);
  if (contents === serializeState(previous)) return;
  const temporary = `${STATE_PATH}.${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, STATE_PATH);
  } catch {
    // Best effort only; Herdr labels should never affect Pi itself.
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Successful replacement has already removed the temporary pathname.
    }
  }
}

function sanitizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label ? label.slice(0, 80) : null;
}

function labelFromSessionName(name: unknown): string | null {
  return sanitizeLabel(name);
}

function basenameOf(value: unknown): string | null {
  return typeof value === "string" && value ? basename(value).toLowerCase() : null;
}

function isAutoishLabel(current: string | null, candidates: Array<string | null | undefined>): boolean {
  if (!current) return true;

  const normalized = current.trim().toLowerCase();
  if (!normalized || /^\d+$/.test(normalized)) return true;
  if (/^pane\s+\d+$/.test(normalized)) return true;
  if (["pi", "src", "bash", "zsh", "fish", "shell"].includes(normalized)) return true;

  return candidates.some((candidate) => candidate && candidate.toLowerCase() === normalized);
}

function commandNameFromPath(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const command = basename(value).replace(/^-+/, "").replace(/\.(?:c?m?js|ts|rb|py|sh|bash|zsh|fish|pl|php)$/i, "");
  return sanitizeLabel(command)?.toLowerCase() ?? null;
}

function interpreterOptionHasValue(arg: string, interpreter: string): boolean {
  if (/^python[23]?$/.test(interpreter)) return ["-W", "-X"].includes(arg);
  if (["node", "bun"].includes(interpreter)) {
    return ["-r", "--require", "--import", "--loader", "--experimental-loader", "--conditions", "--input-type"].includes(arg);
  }
  if (interpreter === "ruby") return ["-I", "-r", "-C", "-F", "-E", "--encoding"].includes(arg);
  if (interpreter === "perl") return ["-I", "-M", "-F"].includes(arg);
  return false;
}

function scriptArg(argv: unknown[], interpreter: string): string | null {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== "string" || !arg) continue;
    if (/^-(?:e|c)/.test(arg) || /^--(?:eval|print)(?:=|$)/.test(arg)) return null;
    if (/^python[23]?$/.test(interpreter) && /^-[bBdEhiIOqRsSuvV]*c/.test(arg)) return null;
    if (["ruby", "perl"].includes(interpreter) && /^-[0-9aAnlpwW]*e/.test(arg)) return null;
    if (interpreter === "perl" && /^-[0-9aAnlpwW]*E/.test(arg)) return null;
    if (["node", "bun"].includes(interpreter) && /^-p/.test(arg)) return null;
    if (interpreter === "php" && /^-[n]*r/.test(arg)) return null;
    if (arg === "--") {
      const script = argv[index + 1];
      return typeof script === "string" ? script : null;
    }
    if (arg === "-m") {
      const moduleName = argv[index + 1];
      return typeof moduleName === "string" ? sanitizeLabel(moduleName) : null;
    }
    if (interpreterOptionHasValue(arg, interpreter)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function processLabel(process: ForegroundProcess | undefined): string | null {
  const argv: unknown[] = Array.isArray(process?.argv) ? process.argv : [];
  const primary = commandNameFromPath(process?.argv0) ?? commandNameFromPath(process?.name);
  if (!primary) return null;

  if (INTERPRETER_NAMES.has(primary)) {
    const script = scriptArg(argv, primary);
    const scriptName = commandNameFromPath(script);
    if (scriptName) return scriptName;
  }

  return sanitizeLabel(primary);
}

function labelFromPiPane(pane: Pane): string | null {
  const title = sanitizeLabel(pane?.terminal_title_stripped ?? pane?.terminal_title);
  if (!title?.startsWith("π ")) return null;

  const body = title.slice(2);
  if (body.startsWith("— ")) return sanitizeLabel(body.slice(2));

  const separator = body.indexOf(" — ");
  const tree = worldTreeName(pane?.foreground_cwd) ?? worldTreeName(pane?.cwd);
  const isWorldContext = (value: string) => Boolean(tree && (value === tree || value.startsWith(`${tree} //`)));

  if (separator < 0) return isWorldContext(body) ? null : sanitizeLabel(body);

  const left = body.slice(0, separator);
  const right = body.slice(separator + 3);
  if (isWorldContext(right)) return sanitizeLabel(left);
  return sanitizeLabel(right);
}

function labelFromProcessInfo(processInfo: ProcessInfo | undefined): string | null {
  const processes = Array.isArray(processInfo?.foreground_processes) ? processInfo.foreground_processes : [];
  if (processes.length === 0) return null;

  const foregroundGroupId = processInfo?.foreground_process_group_id;
  const shellPid = processInfo?.shell_pid;
  const selected =
    processes.find((process) => process?.pid === foregroundGroupId) ??
    processes.find((process) => process?.pid !== shellPid) ??
    processes[0];

  return processLabel(selected);
}

function worldTreeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/\/world\/trees\/([^/]+)\/src(?:\/|$)/);
  return sanitizeLabel(match?.[1]);
}

function worldRepoName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.match(/\/(world)\/trees\/[^/]+\/src(?:\/|$)/) ? "world" : null;
}

function workspaceRepoName(workspace: Workspace, pathCandidates: unknown[]): string | null {
  const worldRepo = pathCandidates.map(worldRepoName).find(Boolean);
  if (worldRepo) return worldRepo;

  const reported = sanitizeLabel(workspace?.worktree?.repo_name);
  if (reported && reported.toLowerCase() !== "git") return reported;

  return basenameOf(workspace?.worktree?.repo_root) ?? basenameOf(workspace?.worktree?.checkout_path);
}

function workspaceLabel(workspace: Workspace, panes: Pane[]): string | null {
  const pathCandidates = [
    ...(Array.isArray(panes) ? panes.flatMap((pane) => [pane?.foreground_cwd, pane?.cwd]) : []),
    workspace?.worktree?.checkout_path,
    workspace?.worktree?.repo_root,
  ];

  const repo = workspaceRepoName(workspace, pathCandidates);
  if (!repo) return null;

  const tree =
    pathCandidates.map(worldTreeName).find(Boolean) ??
    (workspace?.worktree?.is_linked_worktree ? basenameOf(workspace?.worktree?.checkout_path) : null);

  return tree ? `${repo} · ${tree}` : repo;
}

function shouldRename(
  current: string | null,
  next: string,
  remembered: string | undefined,
  autoishCandidates: Array<string | null | undefined>,
): boolean {
  if (current === next) return true;
  if (remembered && current === remembered) return true;
  return isAutoishLabel(current, autoishCandidates);
}

async function syncOwnedLabel(
  runtime: LabelRuntime,
  request: SyncRequest,
  state: LabelState,
  kind: "pane" | "tab" | "workspace",
  id: string,
  current: string | null,
  next: string,
  autoish: Array<string | null | undefined>,
): Promise<boolean> {
  if (!isActive(runtime, request)) return false;
  const key = `${kind}s` as keyof LabelState;
  if (!shouldRename(current, next, state[key]?.[id], autoish)) return false;

  if (current !== next) {
    const renamed = await execHerdr(runtime, request, [kind, "rename", id, next]);
    if (!renamed || !isActive(runtime, request)) return false;
  }

  if (state[key]?.[id] === next) return false;
  state[key] = { ...(state[key] ?? {}), [id]: next };
  return true;
}

async function syncProcessPaneLabels(runtime: LabelRuntime, request: SyncRequest, state: LabelState): Promise<boolean> {
  const paneList = await execHerdr(runtime, request, ["pane", "list"]);
  const panes = Array.isArray(paneList?.result?.panes) ? paneList.result.panes : [];
  let changed = false;

  for (const pane of panes) {
    if (!isActive(runtime, request)) break;
    const paneId = pane?.pane_id;
    if (typeof paneId !== "string" || !paneId || paneId === request.paneId) continue;

    let label: string | null;
    if (pane.agent === "pi") {
      label = labelFromPiPane(pane) ?? "pi";
    } else {
      const processInfoResponse = await execHerdr(runtime, request, ["pane", "process-info", "--pane", paneId]);
      label = labelFromProcessInfo(processInfoResponse?.result?.process_info);
    }
    if (!label) continue;

    const current = sanitizeLabel(pane?.label);
    const autoish = [basenameOf(request.cwd), basenameOf(pane?.cwd), basenameOf(pane?.foreground_cwd)];
    if (await syncOwnedLabel(runtime, request, state, "pane", paneId, current, label, autoish)) changed = true;
  }

  return changed;
}

async function syncWorkspaceLabels(runtime: LabelRuntime, request: SyncRequest, state: LabelState): Promise<boolean> {
  const workspaceList = await execHerdr(runtime, request, ["workspace", "list"]);
  const workspaces = Array.isArray(workspaceList?.result?.workspaces) ? workspaceList.result.workspaces : [];
  let changed = false;

  for (const workspace of workspaces) {
    if (!isActive(runtime, request)) break;
    const workspaceId = workspace?.workspace_id;
    if (typeof workspaceId !== "string" || !workspaceId) continue;

    const workspacePanesResponse = await execHerdr(runtime, request, ["pane", "list", "--workspace", workspaceId]);
    const workspacePanes = Array.isArray(workspacePanesResponse?.result?.panes) ? workspacePanesResponse.result.panes : [];
    const nextWorkspaceLabel = workspaceLabel(workspace, workspacePanes);
    if (!nextWorkspaceLabel) continue;

    const currentWorkspaceLabel = sanitizeLabel(workspace?.label);
    const workspaceAutoish = [
      basenameOf(workspace?.worktree?.checkout_path),
      basenameOf(workspace?.worktree?.repo_root),
    ];

    if (await syncOwnedLabel(runtime, request, state, "workspace", workspaceId, currentWorkspaceLabel, nextWorkspaceLabel, workspaceAutoish)) {
      changed = true;
    }
  }

  return changed;
}

async function syncLabels(runtime: LabelRuntime, request: SyncRequest): Promise<void> {
  if (!isActive(runtime, request)) return;
  const owner = acquireStateLock();
  if (!owner) return;

  try {
    const state = readState();
    const previous = { ...state };
    let changed = false;
    const { paneId, tabId, label } = request;

    const paneInfo = await execHerdr(runtime, request, ["pane", "get", paneId]);
    const pane = paneInfo?.result?.pane;
    const paneLabel = sanitizeLabel(pane?.label);
    const paneAutoish = [basenameOf(request.cwd), basenameOf(pane?.cwd), basenameOf(pane?.foreground_cwd)];

    if (pane && (label || isAutoishLabel(paneLabel, paneAutoish))) {
      if (await syncOwnedLabel(runtime, request, state, "pane", paneId, paneLabel, label ?? "pi", paneAutoish)) changed = true;
    }

    if (tabId && label && pane?.focused) {
      const tabInfo = await execHerdr(runtime, request, ["tab", "get", tabId]);
      const tab = tabInfo?.result?.tab;
      if (tab && await syncOwnedLabel(runtime, request, state, "tab", tabId, sanitizeLabel(tab.label), label, [])) changed = true;
    }

    if (await syncWorkspaceLabels(runtime, request, state)) changed = true;
    if (await syncProcessPaneLabels(runtime, request, state)) changed = true;

    if (changed && isActive(runtime, request)) writeState(state, previous);
  } finally {
    removeLockOwner(LOCK_PATH, owner);
  }
}

async function drainSyncs(runtime: LabelRuntime): Promise<void> {
  while (!runtime.stopped && runtime.pending) {
    const request = runtime.pending;
    runtime.pending = undefined;
    if (isActive(runtime, request)) await syncLabels(runtime, request);
  }
}

function startSync(runtime: LabelRuntime): void {
  if (runtime.running || runtime.stopped) return;
  runtime.running = drainSyncs(runtime)
    .catch(() => {
      // Polling is best effort; always handle the final rejection, including the last request.
    })
    .then(() => {
      runtime.running = undefined;
      if (runtime.pending && !runtime.stopped) startSync(runtime);
    });
}

function enqueueSync(runtime: LabelRuntime, label: string | null, cwd: string): void {
  const paneId = process.env.HERDR_PANE_ID;
  if (runtime.stopped || !enabled() || !paneId) return;
  runtime.pending = { label, cwd, paneId, tabId: process.env.HERDR_TAB_ID, generation: runtime.generation };
  startSync(runtime);
}

function shutdownRuntime(runtime: LabelRuntime): Promise<void> {
  if (runtime.shutdown) return runtime.shutdown;
  runtime.stopped = true;
  runtime.generation += 1;
  runtime.pending = undefined;
  if (runtime.interval) clearInterval(runtime.interval);
  runtime.interval = undefined;
  runtime.cancelCommand?.();
  runtime.shutdown = (runtime.running ?? Promise.resolve()).then(() => {
    runtime.commands = undefined;
    runtime.preferredCommand = undefined;
    runtime.cancelCommand = undefined;
  });
  return runtime.shutdown;
}

export default function (pi: ExtensionAPI) {
  if (!enabled()) return;

  let generation = 0;
  let runtime: LabelRuntime = { stopped: true, generation };

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const nextGeneration = ++generation;
    await shutdownRuntime(runtime);
    if (nextGeneration !== generation || ctx.mode !== "tui" || !enabled()) return;

    runtime = { stopped: false, generation: nextGeneration };
    const current = runtime;
    const cwd = ctx.cwd;
    enqueueSync(current, labelFromSessionName(pi.getSessionName()), cwd);
    current.interval = setInterval(() => {
      enqueueSync(current, labelFromSessionName(pi.getSessionName()), cwd);
    }, PROCESS_LABEL_SYNC_INTERVAL_MS);
    current.interval.unref();
  });

  pi.on("session_info_changed", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    enqueueSync(runtime, labelFromSessionName(event.name ?? pi.getSessionName()), ctx.cwd);
  });

  pi.on("session_shutdown", () => {
    generation += 1;
    return shutdownRuntime(runtime);
  });
}
