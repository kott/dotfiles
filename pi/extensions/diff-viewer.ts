/**
 * File browser + diff viewer extension (overlay modal with border)
 *
 * Usage: /nav [path]
 *   - No args: browse current directory
 *   - With path: start browsing at that path
 *
 * Keys:
 *   j/↓      - next entry
 *   k/↑      - previous entry
 *   Enter/l  - open directory / select file
 *   h/Bksp   - go to parent directory
 *   d        - toggle diff view (when file has changes)
 *   v        - visual select mode (in preview)
 *   y        - yank/copy to clipboard
 *   Ctrl+d   - scroll content down
 *   Ctrl+u   - scroll content up
 *   q/Esc    - quit
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 5000;
const MAX_ENTRIES = 5000;
const COMMAND_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;

interface DirEntry {
  name: string;
  fullPath: string;
  isDir: boolean;
  hasChanges: boolean;
  isParent: boolean;
}

interface SourceFile {
  content: string;
  lines: string[];
  exists: boolean;
  binary: boolean;
  truncated: boolean;
}

interface ContentLine {
  display: string;
  plain: string | null; // Raw file source or unstyled diff output, never viewer padding/markers.
  changed?: boolean;
}

interface GitMetadata {
  root: string | null;
  head: string | null;
  changed: Set<string>;
  message: string | null;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Request cancelled or timed out");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Escape terminal controls in labels, while retaining the untouched filesystem path. */
function displayLabel(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\t") return "\\t";
    if (c === "\r") return "\\r";
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

function displaySource(value: string): string {
  return value.split("\t").map(displayLabel).join("  ");
}

function safeHighlight(value: string): string {
  return value.split(/(\x1b\[[0-9;]*m)/g)
    .map((part) => /^\x1b\[[0-9;]*m$/.test(part) ? part : displaySource(part)).join("");
}

async function runCommand(
  program: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  options: { input?: string; maxBytes?: number; maxLines?: number; exitCodes?: number[] } = {},
): Promise<Buffer> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let lineCount = 0;
    let settled = false;
    const timer = setTimeout(() => stop(new Error(`${program} timed out`)), COMMAND_TIMEOUT_MS);

    function onAbort(): void {
      stop(new Error("Request cancelled or timed out"));
    }

    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }

    function stop(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill("SIGKILL");
      } catch {
        // Closing inherited pipes still lets a cancelled request settle promptly.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(error);
    }

    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (options.maxLines !== undefined) {
        for (const byte of chunk) if (byte === 10) lineCount++;
      }
      if (bytes > (options.maxBytes ?? MAX_OUTPUT_BYTES) || lineCount > (options.maxLines ?? Infinity)) {
        stop(new Error(`${program} output exceeds preview limits`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 8192 - stderrBytes;
      if (remaining > 0) {
        stderr.push(chunk.subarray(0, remaining));
        stderrBytes += Math.min(chunk.length, remaining);
      }
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error);
    });
    child.on("error", stop);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!(options.exitCodes ?? [0]).includes(code ?? -1)) {
        reject(new Error(`${program} failed (${code}): ${displayLabel(Buffer.concat(stderr).toString("utf8").trim())}`));
      } else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(options.input);
    if (signal.aborted) onAbort();
  });
}

function gitCommand(args: string[], cwd: string, signal: AbortSignal, maxBytes = MAX_OUTPUT_BYTES): Promise<Buffer> {
  return runCommand("git", ["--no-pager", "--literal-pathspecs", ...args], cwd, signal, { maxBytes });
}

function repoRelativePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("File is outside the repository");
  }
  return relative.split(path.sep).join("/");
}

async function loadGitMetadata(cwd: string, signal: AbortSignal): Promise<GitMetadata> {
  let root: string;
  try {
    const output = await gitCommand(["rev-parse", "--show-toplevel"], cwd, signal, 16384);
    root = output.toString("utf8").replace(/\n$/, "");
  } catch (error) {
    checkAbort(signal);
    return { root: null, head: null, changed: new Set(), message: `Git unavailable: ${errorMessage(error)}` };
  }
  let head: string | null = null;
  try {
    const output = await runCommand("git", ["--no-pager", "rev-parse", "--verify", "--quiet", "HEAD"], root, signal,
      { maxBytes: 1024, exitCodes: [0, 1] });
    head = output.toString("utf8").trim() || null;
    const changed = head
      ? await gitCommand(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", head, "--"], root, signal)
      : await gitCommand(["ls-files", "-z"], root, signal);
    const untracked = await gitCommand(["ls-files", "--others", "--exclude-standard", "-z"], root, signal);
    const names = [...changed.toString("utf8").split("\0"), ...untracked.toString("utf8").split("\0")].filter(Boolean);
    if (names.length > MAX_ENTRIES) throw new Error("Changed file list exceeds preview limits");
    return { root, head, changed: new Set(names.map((name) => path.resolve(root, name))), message: null };
  } catch (error) {
    checkAbort(signal);
    return { root, head, changed: new Set(), message: `Git metadata error: ${errorMessage(error)}` };
  }
}

async function listDirectory(dirPath: string, changedFiles: Set<string>, signal: AbortSignal): Promise<DirEntry[]> {
  checkAbort(signal);
  const result: DirEntry[] = [];
  const parent = path.dirname(dirPath);
  if (parent !== dirPath) {
    result.push({ name: "..", fullPath: parent, isDir: true, hasChanges: false, isParent: true });
  }
  const items: DirEntry[] = [];
  const changedPaths = Array.from(changedFiles);
  const directory = await fs.promises.opendir(dirPath);
  let scanned = 0;
  for await (const entry of directory) {
    checkAbort(signal);
    if (++scanned > MAX_ENTRIES) throw new Error("Directory exceeds 5000-entry preview limit");
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(dirPath, entry.name);
    const isDir = entry.isDirectory();
    const hasChanges = isDir
      ? changedPaths.some((cf) => cf.startsWith(fullPath + path.sep))
      : changedFiles.has(fullPath);
    items.push({ name: entry.name, fullPath, isDir, hasChanges, isParent: false });
  }
  items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  return result.concat(items);
}

function sourceFile(content: string, exists = true, truncated = false): SourceFile {
  let lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  if (!content) lines = [];
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    content = lines.join("\n");
    truncated = true;
  }
  return { content, lines, exists, binary: content.includes("\0"), truncated };
}

async function readRegularFile(filePath: string, signal: AbortSignal): Promise<SourceFile> {
  checkAbort(signal);
  try {
    const stat = await fs.promises.lstat(filePath);
    checkAbort(signal);
    if (!stat.isFile()) throw new Error("Preview requires a regular file (symlinks and special files are not read)");
    // NOFOLLOW/NONBLOCK plus fstat protect against replacement with a symlink or FIFO after lstat.
    const file = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const openedStat = await file.stat();
      checkAbort(signal);
      if (!openedStat.isFile()) throw new Error("Preview requires a regular file");
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        checkAbort(signal);
        const read = await file.read(buffer, bytes, Math.min(65536, buffer.length - bytes), bytes);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
      }
      checkAbort(signal);
      const truncated = bytes > MAX_FILE_BYTES;
      let content = buffer.subarray(0, Math.min(bytes, MAX_FILE_BYTES)).toString("utf8");
      if (truncated) content = content.slice(0, Math.max(0, content.lastIndexOf("\n") + 1));
      return sourceFile(content, true, truncated);
    } finally {
      await file.close();
    }
  } catch (error) {
    checkAbort(signal);
    if (errorCode(error) === "ENOENT") return sourceFile("", false);
    throw error;
  }
}

async function loadHeadFile(root: string, head: string | null, filePath: string, signal: AbortSignal): Promise<SourceFile> {
  const relative = repoRelativePath(root, filePath);
  if (!head) return sourceFile("", false);
  const tree = await gitCommand(["ls-tree", "-z", "-r", "--full-tree", head, "--", relative], root, signal, 16384);
  const records = tree.toString("utf8").split("\0").filter(Boolean);
  const record = records.find((entry) => entry.slice(entry.indexOf("\t") + 1) === relative);
  if (!record) return sourceFile("", false); // Untracked/added at HEAD, not a failed git show.
  const header = record.slice(0, record.indexOf("\t")).split(" ");
  if (!/^100(644|755)$/.test(header[0]!) || header[1] !== "blob" || !/^[0-9a-f]+$/.test(header[2]!)) {
    throw new Error("HEAD baseline is not a regular file");
  }
  const content = await gitCommand(["cat-file", "blob", header[2]!], root, signal, MAX_FILE_BYTES);
  const source = sourceFile(content.toString("utf8"));
  if (source.truncated) throw new Error("HEAD baseline exceeds 5000-line preview limit");
  return source;
}

function diffLines(output: string): ContentLine[] {
  return output.split("\n").map((line) => ({
    display: safeHighlight(line),
    plain: stripTerminalSequences(line),
  }));
}

function changedLineNumbers(output: string): Set<number> {
  const changed = new Set<number>();
  for (const line of stripTerminalSequences(output).split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + count && n <= MAX_LINES; n++) changed.add(n);
  }
  return changed;
}

async function snapshotDiff(
  root: string, filePath: string, before: SourceFile, after: SourceFile, signal: AbortSignal, syntaxDiff: boolean,
): Promise<{ lines: ContentLine[]; changed: Set<number> }> {
  checkAbort(signal);
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-nav-"));
  try {
    checkAbort(signal);
    const extension = path.extname(filePath);
    const suffix = /^\.[a-zA-Z0-9_-]{1,20}$/.test(extension) ? extension : ".txt";
    const oldPath = path.join(directory, `before${suffix}`);
    const newPath = path.join(directory, `after${suffix}`);
    await fs.promises.writeFile(oldPath, before.content, { flag: "wx", mode: 0o600, signal });
    await fs.promises.writeFile(newPath, after.content, { flag: "wx", mode: 0o600, signal });
    if (syntaxDiff) {
      try {
        const highlighted = await runCommand("difft", ["--color=always", "--display=inline", "--tab-size=2", "--", oldPath, newPath],
          root, signal, { maxLines: MAX_LINES });
        const output = highlighted.toString("utf8");
        if (output.trim()) return { lines: diffLines(output), changed: new Set() };
      } catch {
        checkAbort(signal); // Optional highlighter failures must not mask cancellation.
      }
    }
    const output = await runCommand("git", [
      "--no-pager", "diff", "--no-index", "--patch", syntaxDiff ? "--unified=3" : "--unified=0",
      "--no-ext-diff", "--no-textconv", "--color=always", "--", oldPath, newPath,
    ], root, signal, { maxLines: MAX_LINES, exitCodes: [0, 1] });
    const text = output.toString("utf8");
    return { lines: text ? diffLines(text) : [], changed: changedLineNumbers(text) };
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

/** Pad or truncate a styled string to exactly `w` visible characters. */
function padLine(styled: string, w: number): string {
  if (w <= 0) return "";
  const vw = visibleWidth(styled);
  if (vw >= w) return truncateToWidth(styled, w, "");
  return styled + " ".repeat(w - vw);
}

// ── Component ────────────────────────────────────────────────────────────────

class DiffViewerComponent {
  private currentDir: string;
  private entries: DirEntry[] = [];        // current file list (browse mode)
  private changedEntries: DirEntry[] = []; // flat list of changed files (diff mode)
  private selectedIndex = 0;
  private listScrollOffset = 0;
  private contentScrollOffset = 0;
  private diffMode = false;           // true = show only changed files + diff preview
  private showFullFile = false;       // in diff mode, show full file instead of diff
  private changedFiles = new Set<string>();
  private theme: Theme;
  private tui: TUI;
  private onClose: () => void;
  private gitRoot: string | null = null;
  private gitHead: string | null = null;
  private directoryMessage: string | null = "Loading…";
  private gitMessage: string | null = null;
  private directoryController: AbortController | null = null;
  private previewController: AbortController | null = null;
  private copyController: AbortController | null = null;
  private directoryTimer: ReturnType<typeof setTimeout> | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Set<Promise<void>>();
  private disposed = false;
  private bodyRows = 1;
  private previewRows = 1;
  private previewLines: ContentLine[] = [];

  private focusPreview = false;
  private cursorLine = 0;
  private selectAnchor: number | null = null;
  private lastCopiedMessage: string | null = null;

  private cachedLines?: string[];
  private cachedWidth?: number;
  private cachedHeight?: number;
  private contentCache: { path: string; diff: boolean; lines: ContentLine[] } | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    startDir: string,
    onClose: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.currentDir = startDir;
    this.onClose = onClose;
    this.trackTask(this.loadDirectory(startDir));
  }

  private trackTask(task: Promise<void>): void {
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
  }

  private redraw(): void {
    if (this.disposed) return;
    this.invalidate();
    this.tui.requestRender();
  }

  private cancelPreview(): void {
    this.previewController?.abort();
    this.previewController = null;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.copyController?.abort();
    this.copyController = null;
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = null;
    this.lastCopiedMessage = null;
  }

  private selectionChanged(): void {
    this.contentScrollOffset = 0;
    this.cursorLine = 0;
    this.selectAnchor = null;
    this.cancelPreview();
    this.previewLines = [{ display: " (loading…)", plain: null }];
    this.trackTask(this.loadPreview());
    this.redraw();
  }

  private async loadDirectory(dir: string, selectedPath?: string): Promise<void> {
    this.directoryController?.abort();
    if (this.directoryTimer) clearTimeout(this.directoryTimer);
    const controller = new AbortController();
    this.directoryController = controller;
    this.directoryTimer = setTimeout(() => {
      controller.abort();
      if (this.disposed || this.directoryController !== controller) return;
      this.directoryMessage = "Directory/Git metadata request timed out";
      this.redraw();
    }, REQUEST_TIMEOUT_MS);
    this.directoryMessage = "Loading…";
    this.entries = [];
    this.changedEntries = [];
    this.gitRoot = null;
    this.gitHead = null;
    this.changedFiles = new Set();
    this.gitMessage = null;
    try {
      const metadata = await loadGitMetadata(dir, controller.signal);
      const entries = await listDirectory(dir, metadata.changed, controller.signal);
      checkAbort(controller.signal);
      if (this.disposed || this.directoryController !== controller) return;
      this.gitRoot = metadata.root;
      this.gitHead = metadata.head;
      this.changedFiles = metadata.changed;
      this.gitMessage = metadata.message;
      this.entries = entries;
      this.changedEntries = this.buildChangedEntries();
      const index = selectedPath ? this.entries.findIndex((entry) => entry.fullPath === selectedPath) : 0;
      this.selectedIndex = Math.max(0, index);
      if (this.diffMode) this.selectedIndex = 0;
      this.directoryMessage = null;
      this.selectionChanged();
    } catch (error) {
      if (this.disposed || this.directoryController !== controller) return;
      this.directoryMessage = errorMessage(error);
      this.previewLines = [{ display: ` (${displayLabel(errorMessage(error))})`, plain: null }];
      this.redraw();
    } finally {
      if (this.directoryController === controller) {
        this.directoryController = null;
        if (this.directoryTimer) clearTimeout(this.directoryTimer);
        this.directoryTimer = null;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPreview();
    this.directoryController?.abort();
    this.directoryController = null;
    if (this.directoryTimer) clearTimeout(this.directoryTimer);
    this.directoryTimer = null;
  }

  async waitForIdle(): Promise<void> {
    if (this.pending.size === 0) return;
    // Native filesystem requests cannot be aborted; let their finally blocks finish in the background.
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, 1000);
      void Promise.allSettled(this.pending).then(() => {
        clearTimeout(deadline);
        resolve();
      });
    });
  }

  /** Build a flat list of all changed files for diff mode */
  private buildChangedEntries(): DirEntry[] {
    return Array.from(this.changedFiles)
      .sort((a, b) => a.localeCompare(b))
      .map((fullPath) => ({
        name: this.gitRoot ? path.relative(this.gitRoot, fullPath) : path.relative(this.currentDir, fullPath),
        fullPath,
        isDir: false,
        hasChanges: true,
        isParent: false,
      }));
  }

  /** Get the active list based on current mode */
  private get activeEntries(): DirEntry[] {
    return this.diffMode ? this.changedEntries : this.entries;
  }

  // ── Input handling ───────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape") || data === "q") {
      if (this.selectAnchor !== null) {
        this.selectAnchor = null;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (this.focusPreview) {
        this.focusPreview = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      this.dispose();
      this.onClose();
      return;
    }

    if (matchesKey(data, "tab")) {
      const entry = this.activeEntries[this.selectedIndex];
      if (entry && !entry.isDir) {
        this.focusPreview = !this.focusPreview;
        this.selectAnchor = null;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (data === "d") {
      this.diffMode = !this.diffMode;
      this.showFullFile = false;
      this.selectedIndex = 0;
      this.listScrollOffset = 0;
      this.selectionChanged();
      return;
    }

    // f — toggle full file view (only in diff mode)
    if (data === "f" && this.diffMode) {
      this.showFullFile = !this.showFullFile;
      this.selectionChanged();
      return;
    }

    if (this.focusPreview) {
      this.handlePreviewInput(data);
    } else {
      this.handleFileListInput(data);
    }
  }

  private handleFileListInput(data: string): void {
    if (matchesKey(data, "down") || data === "j") {
      if (this.selectedIndex < this.activeEntries.length - 1) {
        this.selectedIndex++;
        this.selectionChanged();
      }
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.selectionChanged();
      }
      return;
    }
    if (matchesKey(data, "enter") || data === "l") {
      const entry = this.activeEntries[this.selectedIndex];
      if (!this.diffMode && entry?.isDir) {
        this.navigateTo(entry.fullPath);
      } else if (entry && !entry.isDir) {
        this.focusPreview = true;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "backspace") || data === "h") {
      if (this.diffMode) return; // no dir navigation in diff mode
      const parent = path.dirname(this.currentDir);
      if (parent !== this.currentDir) {
        this.navigateTo(parent, this.currentDir);
      }
      return;
    }
    if (matchesKey(data, "ctrl+d")) { this.contentScrollOffset += 15; this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, "ctrl+u")) { this.contentScrollOffset = Math.max(0, this.contentScrollOffset - 15); this.invalidate(); this.tui.requestRender(); return; }
    if (data === "g") { this.selectedIndex = 0; this.selectionChanged(); return; }
    if (data === "G") { this.selectedIndex = Math.max(0, this.activeEntries.length - 1); this.selectionChanged(); return; }
  }

  private handlePreviewInput(data: string): void {
    if (data === "v") {
      this.selectAnchor = this.selectAnchor !== null ? null : this.cursorLine;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (data === "y") {
      if (this.selectAnchor !== null) { this.copySelection(); }
      else { this.selectAnchor = this.cursorLine; this.copySelection(); }
      return;
    }
    if (matchesKey(data, "down") || data === "j") { this.moveCursor(1); return; }
    if (matchesKey(data, "up") || data === "k") { this.moveCursor(-1); return; }
    if (matchesKey(data, "ctrl+d")) { this.moveCursor(15); return; }
    if (matchesKey(data, "ctrl+u")) { this.moveCursor(-15); return; }
    if (data === "g") { this.cursorLine = 0; this.contentScrollOffset = 0; this.invalidate(); this.tui.requestRender(); return; }
    if (data === "G") { this.cursorLine = Math.max(0, this.getContentLineCount() - 1); this.ensureCursorVisible(); this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, "backspace") || data === "h") { this.focusPreview = false; this.selectAnchor = null; this.invalidate(); this.tui.requestRender(); return; }
  }

  // ── Cursor & selection ───────────────────────────────────────────────────

  private getContentLineCount(): number {
    const entry = this.activeEntries[this.selectedIndex];
    if (!entry || entry.isDir) return 0;
    return this.previewLines.length;
  }

  private moveCursor(delta: number): void {
    const maxLine = Math.max(0, this.getContentLineCount() - 1);
    this.cursorLine = Math.max(0, Math.min(maxLine, this.cursorLine + delta));
    this.ensureCursorVisible();
    this.invalidate();
    this.tui.requestRender();
  }

  private ensureCursorVisible(): void {
    const viewportHeight = Math.max(1, this.previewRows);
    if (this.cursorLine < this.contentScrollOffset) {
      this.contentScrollOffset = this.cursorLine;
    } else if (this.cursorLine >= this.contentScrollOffset + viewportHeight) {
      this.contentScrollOffset = this.cursorLine - viewportHeight + 1;
    }
  }

  private copySelection(): void {
    if (this.selectAnchor === null) return;
    const entry = this.activeEntries[this.selectedIndex];
    if (!entry || entry.isDir) return;
    const start = Math.min(this.selectAnchor, this.cursorLine);
    const end = Math.max(this.selectAnchor, this.cursorLine);
    const sourceLines = this.previewLines.slice(start, end + 1)
      .map((line) => line.plain).filter((line): line is string => line !== null);
    this.selectAnchor = null;
    this.copyController?.abort();
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = null;
    const controller = new AbortController();
    this.copyController = controller;
    this.trackTask(this.copyText(sourceLines, controller));
    this.redraw();
  }

  private async copyText(lines: string[], controller: AbortController): Promise<void> {
    let message = "No copyable lines selected";
    try {
      if (lines.length) {
        const input = lines.join("\n");
        try {
          await runCommand("pbcopy", [], this.currentDir, controller.signal, { input });
        } catch {
          checkAbort(controller.signal);
          await runCommand("xclip", ["-selection", "clipboard"], this.currentDir, controller.signal, { input });
        }
        message = `Copied ${lines.length} line${lines.length === 1 ? "" : "s"}`;
      }
    } catch {
      message = "Copy failed";
    }
    if (this.disposed || controller.signal.aborted || this.copyController !== controller) return;
    this.copyController = null;
    this.lastCopiedMessage = message;
    this.copiedTimer = setTimeout(() => {
      this.copiedTimer = null;
      this.lastCopiedMessage = null;
      this.redraw();
    }, 2000);
    this.redraw();
  }

  private navigateTo(dir: string, selectedPath?: string): void {
    this.cancelPreview();
    this.currentDir = dir;
    this.selectedIndex = 0;
    this.listScrollOffset = 0;
    this.cursorLine = 0;
    this.selectAnchor = null;
    this.contentScrollOffset = 0;
    this.diffMode = false;
    this.showFullFile = false;
    this.focusPreview = false;
    this.contentCache = null;
    this.previewLines = [{ display: " (loading…)", plain: null }];
    this.trackTask(this.loadDirectory(dir, selectedPath));
    this.redraw();
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const termHeight = Math.max(1, Math.floor(this.tui.terminal.rows));
    width = Math.max(0, Math.floor(width));
    this.bodyRows = Math.max(0, termHeight - 2);
    if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === termHeight) {
      return this.cachedLines;
    }

    const theme = this.theme;
    const b = (s: string) => theme.fg("border", s); // border styling shorthand
    const lines: string[] = [];

    // Inner width (minus 2 for left/right border chars)
    const innerW = Math.max(0, width - 2);
    const splitPanes = width >= 6;
    const paneWidth = Math.max(0, innerW - 1);
    const rightW = splitPanes
      ? Math.min(paneWidth - 1, Math.max(1, Math.floor(paneWidth * 0.2), Math.min(22, Math.floor(paneWidth * 0.4))))
      : innerW;
    const leftW = splitPanes ? paneWidth - rightW : innerW;

    // All content has already been loaded; render only lays it out.
    const previewLines = this.buildPreviewLines(leftW);
    const fileListLines = this.buildFileListLines(rightW);

    // ╭─ Header ─╮
    const displayPath = this.gitRoot
      ? path.relative(this.gitRoot, this.currentDir) || "."
      : this.currentDir;
    const modeTag = this.diffMode ? theme.fg("warning", " [DIFF] ") : "";
    const previewLabel = this.focusPreview
      ? theme.fg("accent", theme.bold(" ▶ Preview ")) + modeTag
      : theme.fg("dim", " Preview ") + modeTag;
    const rightTitle = this.diffMode ? "Changed Files" : `${displayLabel(displayPath)}/`;
    const filesLabel = this.focusPreview
      ? theme.fg("dim", ` ${rightTitle} `)
      : theme.fg("accent", theme.bold(` ▶ ${rightTitle} `));

    // Top border with embedded titles
    const previewTitleVW = visibleWidth(previewLabel);
    const filesTitleVW = visibleWidth(filesLabel);
    const topLeft = padLine(previewLabel + b("─".repeat(Math.max(0, leftW - previewTitleVW))), leftW);
    const topRight = padLine(filesLabel + b("─".repeat(Math.max(0, rightW - filesTitleVW))), rightW);
    lines.push(truncateToWidth(splitPanes
      ? b("╭") + topLeft + b("┬") + topRight + b("╮")
      : b("╭") + (this.focusPreview ? topLeft : topRight) + b("╮"), width, ""));

    for (let i = 0; i < this.bodyRows; i++) {
      const left = padLine(previewLines[i] ?? "", leftW);
      const right = padLine(fileListLines[i] ?? "", rightW);
      lines.push(truncateToWidth(splitPanes
        ? b("│") + left + b("│") + right + b("│")
        : b("│") + (this.focusPreview ? left : right) + b("│"), width, ""));
    }

    // ╰─ Footer ─╯
    const fileToggleHint = this.diffMode
      ? `${theme.fg("dim", "f")} ${this.showFullFile ? "diff" : "file"}  `
      : "";
    const diffHint = `${theme.fg("dim", "d")} ${this.diffMode ? "browse" : "diff"}  `;
    const isVisual = this.focusPreview && this.selectAnchor !== null;
    const focusHint = this.focusPreview
      ? isVisual
        ? `${theme.fg("dim", "jk")} extend  ${theme.fg("dim", "y")} copy  ${theme.fg("dim", "v/esc")} cancel  `
        : `${theme.fg("dim", "tab/h/esc")} files  ${theme.fg("dim", "jk")} move  ${theme.fg("dim", "v")} select  ${theme.fg("dim", "y")} yank  `
      : `${theme.fg("dim", "jk")} nav  ${theme.fg("dim", "⏎/l")} open  ${theme.fg("dim", "tab")} preview  ${theme.fg("dim", "h/⌫")} back  `;
    const helpText = ` ${focusHint}${diffHint}${fileToggleHint}${theme.fg("dim", "q")} quit`;
    const helpVW = visibleWidth(helpText);
    const bottomPad = Math.max(0, innerW - helpVW);
    lines.push(truncateToWidth(b("╰") + padLine(helpText + b("─".repeat(bottomPad)), innerW) + b("╯"), width, ""));
    if (lines.length > termHeight) lines.length = termHeight;

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedHeight = termHeight;
    return lines;
  }

  private buildFileListLines(w: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];

    if (this.bodyRows === 0 || w <= 0) return lines;
    if (this.directoryMessage) return [theme.fg("dim", ` ${displayLabel(this.directoryMessage)}`)];
    if (this.activeEntries.length === 0) {
      if (this.diffMode && this.gitMessage) return [theme.fg("warning", ` ${displayLabel(this.gitMessage)}`)];
      if (this.diffMode) {
        lines.push(theme.fg("success", " ✓ No changes"));
        lines.push(theme.fg("dim", " Working tree clean"));
        lines.push("");
        lines.push(theme.fg("dim", " Press d to browse"));
      } else {
        lines.push(theme.fg("muted", " (empty)"));
      }
      return lines;
    }

    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.activeEntries.length - 1));
    const showIndicator = this.activeEntries.length > this.bodyRows && this.bodyRows > 1;
    const maxVisible = Math.max(1, this.bodyRows - (showIndicator ? 1 : 0));
    let start = Math.max(0, Math.min(this.listScrollOffset, this.activeEntries.length - maxVisible));
    if (this.selectedIndex >= start + maxVisible) start = this.selectedIndex - maxVisible + 1;
    if (this.selectedIndex < start) start = this.selectedIndex;
    this.listScrollOffset = start;

    const end = Math.min(start + maxVisible, this.activeEntries.length);
    for (let i = start; i < end; i++) {
      const entry = this.activeEntries[i]!;
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? "▸" : " ";
      const dot = entry.hasChanges ? theme.fg("warning", "●") : " ";

      let name: string;
      if (entry.isParent) {
        name = isSelected ? theme.fg("accent", theme.bold("..")) : theme.fg("dim", "..");
      } else if (entry.isDir) {
        const label = displayLabel(entry.name) + "/";
        name = isSelected ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label);
      } else {
        const label = displayLabel(entry.name);
        name = isSelected ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label);
      }
      lines.push(truncateToWidth(`${prefix}${dot}${name}`, w));
    }

    if (showIndicator) {
      const pct = Math.round(((this.selectedIndex + 1) / this.activeEntries.length) * 100);
      lines.push(truncateToWidth(theme.fg("dim", ` ${this.activeEntries.length} items ${pct}%`), w));
    }
    return lines;
  }

  private buildPreviewLines(w: number): string[] {
    const theme = this.theme;
    const selectedEntry = this.activeEntries[this.selectedIndex];

    if (w <= 0 || this.bodyRows === 0) return [];
    if (!selectedEntry) return [theme.fg("muted", " No selection")];
    if (selectedEntry.isDir) return this.previewLines.map((line) => theme.fg("dim", line.display));

    // File preview
    const lines: string[] = [];

    // Status bar
    const contentLines = this.previewLines;
    const showIndicator = contentLines.length > Math.max(0, this.bodyRows - 2) && this.bodyRows > 3;
    this.previewRows = Math.max(0, this.bodyRows - 2 - (showIndicator ? 1 : 0));
    const maxLine = Math.max(0, contentLines.length - 1);
    this.cursorLine = Math.min(this.cursorLine, maxLine);
    if (this.selectAnchor !== null) this.selectAnchor = Math.min(this.selectAnchor, maxLine);
    if (this.focusPreview) this.ensureCursorVisible();
    this.contentScrollOffset = Math.max(0, Math.min(this.contentScrollOffset, contentLines.length - Math.max(1, this.previewRows)));

    const parts: string[] = [];
    if (this.diffMode && selectedEntry.hasChanges && !this.showFullFile) parts.push(theme.fg("accent", "[DIFF]"));
    else if (this.diffMode && this.showFullFile) parts.push(theme.fg("accent", "[FILE]"));
    else if (selectedEntry.hasChanges) parts.push(theme.fg("warning", "●"));
    if (this.focusPreview && this.selectAnchor !== null) {
      const s = Math.min(this.selectAnchor, this.cursorLine);
      const e = Math.max(this.selectAnchor, this.cursorLine);
      parts.push(theme.fg("warning", `VISUAL L${s + 1}-${e + 1}`));
    } else if (this.focusPreview) {
      parts.push(theme.fg("dim", `L${this.cursorLine + 1}`));
    }
    if (this.lastCopiedMessage) parts.push(theme.fg("success", this.lastCopiedMessage));
    parts.push(theme.fg("dim", displayLabel(selectedEntry.name)));
    lines.push(` ${parts.join(" ")}`);
    lines.push(theme.fg("border", " " + "─".repeat(Math.max(0, w - 2))));

    const selStart = this.selectAnchor !== null ? Math.min(this.selectAnchor, this.cursorLine) : -1;
    const selEnd = this.selectAnchor !== null ? Math.max(this.selectAnchor, this.cursorLine) : -1;

    // Line number gutter width
    const totalLines = contentLines.length;
    const gutterW = Math.min(w, Math.max(3, String(totalLines).length + 1));

    const contentW = Math.max(0, w - gutterW); // available width for content after gutter
    // Cap visible lines to fit within body (minus status bar + separator + scroll indicator)
    const maxVisibleContent = this.previewRows;
    const visible = contentLines.slice(this.contentScrollOffset, this.contentScrollOffset + maxVisibleContent);
    for (let i = 0; i < visible.length; i++) {
      const contentIdx = i + this.contentScrollOffset;
      const lineNum = String(contentIdx + 1).padStart(Math.max(0, gutterW - 1));
      const gutter = padLine(theme.fg("dim", lineNum) + theme.fg("border", "│"), gutterW);
      const content = visible[i]!;
      const marker = content.changed ? theme.fg("toolDiffAdded", "▎") : " ";
      const truncContent = contentW > 0 ? truncateToWidth(marker + theme.fg("text", content.display), contentW, "") : "";

      let line: string;
      if (this.focusPreview) {
        if (this.selectAnchor !== null && contentIdx >= selStart && contentIdx <= selEnd) {
          line = `${gutter}\x1b[7m${truncContent}\x1b[27m`;
        } else if (contentIdx === this.cursorLine) {
          line = `${gutter}\x1b[4m${truncContent}\x1b[24m`;
        } else {
          line = `${gutter}${truncContent}`;
        }
      } else {
        line = `${gutter}${truncContent}`;
      }
      lines.push(line);
    }

    if (showIndicator) {
      const pct = contentLines.length > 0
        ? Math.round((this.contentScrollOffset / Math.max(1, contentLines.length - 1)) * 100)
        : 0;
      lines.push(theme.fg("dim", ` ── ${pct}% (${contentLines.length} lines) ──`));
    }
    return lines;
  }

  // ── Content loading ──────────────────────────────────────────────────────

  private async loadPreview(): Promise<void> {
    const entry = this.activeEntries[this.selectedIndex];
    if (!entry) {
      this.previewLines = [];
      return;
    }
    const showDiff = this.diffMode && entry.hasChanges && !this.showFullFile;
    if (this.contentCache?.path === entry.fullPath && this.contentCache.diff === showDiff) {
      this.previewLines = this.contentCache.lines;
      return;
    }
    const root = this.gitRoot;
    const head = this.gitHead;
    const controller = new AbortController();
    this.previewController = controller;
    this.previewTimer = setTimeout(() => {
      controller.abort();
      if (this.disposed || this.previewController !== controller) return;
      this.previewLines = [{ display: " (preview request timed out)", plain: null }];
      this.redraw();
    }, REQUEST_TIMEOUT_MS);
    try {
      let lines: ContentLine[];
      if (entry.isParent) {
        lines = [{ display: " (parent directory)", plain: null }];
      } else if (entry.isDir) {
        const children = (await listDirectory(entry.fullPath, this.changedFiles, controller.signal)).filter((child) => !child.isParent);
        lines = [{ display: ` ${displayLabel(entry.name)}/ (${children.length} items)`, plain: null }];
        for (const child of children.slice(0, 20)) {
          lines.push({ display: ` ${child.isDir ? "📁 " : "   "}${displayLabel(child.name)}${child.isDir ? "/" : ""}${child.hasChanges ? " ●" : ""}`, plain: null });
        }
        if (children.length > 20) lines.push({ display: ` ... ${children.length - 20} more`, plain: null });
      } else {
        lines = await this.loadFilePreview(entry, showDiff, root, head, controller.signal);
      }
      checkAbort(controller.signal);
      if (this.disposed || this.previewController !== controller) return;
      this.previewLines = lines;
      this.contentCache = { path: entry.fullPath, diff: showDiff, lines };
      this.redraw();
    } catch (error) {
      if (this.disposed || this.previewController !== controller) return;
      this.previewLines = [{ display: ` (${displayLabel(errorMessage(error))})`, plain: null }];
      this.redraw();
    } finally {
      if (this.previewController === controller) {
        this.previewController = null;
        if (this.previewTimer) clearTimeout(this.previewTimer);
        this.previewTimer = null;
      }
    }
  }

  private async loadFilePreview(entry: DirEntry, showDiff: boolean, root: string | null, head: string | null, signal: AbortSignal): Promise<ContentLine[]> {
    const current = await readRegularFile(entry.fullPath, signal);
    if (current.binary) return [{ display: " (binary file)", plain: null }];
    if (showDiff) {
      if (!root) throw new Error("No Git repository available");
      if (current.truncated) throw new Error("File exceeds diff preview limits (1 MiB / 5000 lines); press f for a partial file preview");
      const baseline = await loadHeadFile(root, head, entry.fullPath, signal);
      if (baseline.binary) return [{ display: " (binary HEAD baseline)", plain: null }];
      const diff = await snapshotDiff(root, entry.fullPath, baseline, current, signal, true);
      return diff.lines.length ? diff.lines : [{ display: " (no diff)", plain: null }];
    }
    if (!current.exists) return [{ display: " (file missing; use diff view for deletions)", plain: null }];
    const lines: ContentLine[] = current.lines.map((plain) => ({ display: displaySource(plain), plain }));
    try {
      const highlighted = await runCommand("bat", ["--color=always", "--style=plain", "--paging=never", "--tabs=2", "--file-name", entry.fullPath, "--", "-"],
        this.currentDir, signal, { input: current.content, maxLines: MAX_LINES });
      const coloredLines = highlighted.toString("utf8").split("\n");
      if (coloredLines.at(-1) === "") coloredLines.pop();
      if (coloredLines.length === lines.length) {
        for (let i = 0; i < lines.length; i++) lines[i]!.display = safeHighlight(coloredLines[i]!);
      }
    } catch {
      checkAbort(signal);
    }
    if (entry.hasChanges && root && !current.truncated) {
      try {
        const baseline = await loadHeadFile(root, head, entry.fullPath, signal);
        if (!baseline.binary) {
          const diff = await snapshotDiff(root, entry.fullPath, baseline, current, signal, false);
          for (let i = 0; i < lines.length; i++) lines[i]!.changed = diff.changed.has(i + 1);
        }
      } catch (error) {
        checkAbort(signal);
        lines.push({ display: ` (change markers unavailable: ${displayLabel(errorMessage(error))})`, plain: null });
      }
    }
    if (current.truncated) lines.push({ display: " … (preview truncated at 1 MiB / 5000 lines)", plain: null });
    if (!lines.length) lines.push({ display: " (empty file)", plain: null });
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const viewers = new Set<DiffViewerComponent>();
  pi.on("session_shutdown", async () => {
    for (const viewer of viewers) viewer.dispose();
    await Promise.allSettled(Array.from(viewers, (viewer) => viewer.waitForIdle()));
    viewers.clear();
  });
  pi.registerCommand("nav", {
    description: "File browser with diff viewer",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("nav requires interactive TUI mode", "error");
        return;
      }
      let startDir = args.trim() ? path.resolve(ctx.cwd, args.trim()) : ctx.cwd;
      try {
        startDir = await fs.promises.realpath(startDir);
        if (!(await fs.promises.stat(startDir)).isDirectory()) throw new Error("Not a directory");
      } catch (error) {
        ctx.ui.notify(`${displayLabel(startDir)}: ${displayLabel(errorMessage(error))}`, "error");
        return;
      }
      let viewer: DiffViewerComponent | undefined;
      try {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) => {
            viewer = new DiffViewerComponent(tui, theme, startDir, () => done(undefined));
            viewers.add(viewer);
            return viewer;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "top-left",
              width: "100%",
              maxHeight: "100%",
              margin: 0,
            },
          },
        );
      } finally {
        if (viewer) {
          viewer.dispose();
          await viewer.waitForIdle();
          viewers.delete(viewer);
        }
      }
    },
  });
}
