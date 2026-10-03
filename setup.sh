#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ "$(uname -s)" != Darwin ]]; then
  printf 'setup.sh supports macOS only. Install dependencies separately on other systems.\n' >&2
  exit 1
fi
if ! command -v brew >/dev/null 2>&1; then
  printf 'Install Homebrew first: https://brew.sh\n' >&2
  exit 1
fi

HOMEBREW_NO_AUTO_UPDATE=1 brew install neovim
bash "$ROOT/ensure_zsh.sh"
