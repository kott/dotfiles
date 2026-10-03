#!/usr/bin/env bash
set -euo pipefail

if ! command -v zsh >/dev/null 2>&1; then
  printf 'Zsh is required; macOS includes /bin/zsh. Install it before continuing.\n' >&2
  exit 1
fi

export ZSH="$HOME/.oh-my-zsh"
if [[ ! -f "$ZSH/oh-my-zsh.sh" ]]; then
  installer=$(mktemp "${TMPDIR:-/tmp}/oh-my-zsh-install.XXXXXX")
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh -o "$installer"
  sh "$installer" --unattended --keep-zshrc
fi

custom=${ZSH_CUSTOM:-$ZSH/custom}
mkdir -p "$custom/plugins"
for plugin in zsh-autosuggestions zsh-syntax-highlighting; do
  if [[ ! -d "$custom/plugins/$plugin" ]]; then
    git clone --depth 1 "https://github.com/zsh-users/$plugin.git" "$custom/plugins/$plugin"
  fi
done
printf 'Zsh, Oh My Zsh and configured plugins are available; login shell and existing .zshrc are unchanged.\n'
