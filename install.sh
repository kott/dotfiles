#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR=$(dirname "$(realpath "$0")")
HOME=${HOME%/}
CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}
CONFIG_DIR=${CONFIG_DIR%/}
WORK_CONFIG="$CONFIG_DIR/dotfiles/work"

function fail() {
  printf '🚨 error: %s\n' "$*" >&2
  exit 1
}

function prepare_directory() {
  local destination=$1
  local resolved

  mkdir -p "$destination"
  resolved=$(realpath "$destination")

  if [[ "$resolved/" == "$SCRIPT_DIR/"* ]]; then
    fail "Destination is inside source: $destination"
  fi
}

function link_config() {
  local source=$1
  local target=$2

  if [[ ! -f "$source" && ! -d "$source" ]]; then
    fail "Missing source: $source"
  fi

  prepare_directory "$(dirname "$target")"
  rm -f "$target"
  ln -sfn "$source" "$target"
}

function link_vim_config() {
  local destination="$CONFIG_DIR/nvim"
  local source
  local lua_files

  lua_files=$(find "$SCRIPT_DIR/lua" -type f | sort)

  link_config "$SCRIPT_DIR/.luarc.json" "$destination/luarc.json"
  link_config "$SCRIPT_DIR/init.lua" "$destination/init.lua"

  while IFS= read -r source; do
    if [[ -n "$source" ]]; then
      link_config "$source" "$destination/${source#"$SCRIPT_DIR/"}"
    fi
  done <<< "$lua_files"

  echo "✅ linked vim config"
}

function link_zshrc() {
  local shell_line

  printf -v shell_line 'source %q' "$SCRIPT_DIR/.zshrc"

  if ! grep -Fxq "$shell_line" "$HOME/.zshrc" 2>/dev/null; then
    printf '\n%s\n' "$shell_line" >> "$HOME/.zshrc"
  fi

  echo "✅ linked .zshrc"
}

function compose_gitconfig() {
  local path
  local quoted
  local line

  for path in "$SCRIPT_DIR/.gitconfig" "$WORK_CONFIG/gitconfig"; do
    quoted=${path//\\/\\\\}
    quoted=${quoted//\"/\\\"}
    line="  path = \"$quoted\""

    if ! grep -Fxq "$line" "$HOME/.gitconfig" 2>/dev/null; then
      printf '\n[include]\n%s\n' "$line" >> "$HOME/.gitconfig"
    fi
  done

  echo "✅ composed ~/.gitconfig"
}

function link_pi_resources() {
  local kind=$1
  local source
  local destination="$HOME/.pi/agent/$kind"

  prepare_directory "$destination"

  for source in "$SCRIPT_DIR/pi/$kind"/*; do
    if [[ -f "$source" || -d "$source" ]]; then
      link_config "$source" "$destination/$(basename "$source")"
    fi
  done
}

function compose_agents_md() {
  local fragment

  mkdir -p "$HOME/.pi/agent"
  rm -f "$HOME/.pi/agent/AGENTS.md"

  {
    for fragment in "$SCRIPT_DIR/pi/AGENTS.md" "$WORK_CONFIG/AGENTS.md"; do
      if [[ -f "$fragment" ]]; then
        cat "$fragment"
        printf '\n'
      fi
    done
  } > "$HOME/.pi/agent/AGENTS.md"

  echo "✅ composed ~/.pi/agent/AGENTS.md"
}

compose_agents_md
compose_gitconfig

link_vim_config
link_config "$SCRIPT_DIR/.aliases" "$HOME/.aliases"
link_config "$SCRIPT_DIR/.functions" "$HOME/.functions"
link_config "$SCRIPT_DIR/ghostty/config" "$CONFIG_DIR/ghostty/config"
link_config "$SCRIPT_DIR/pi/llm-wiki/wiki.yaml" "$HOME/.llm-wiki/wiki.yaml"
link_pi_resources agents
link_pi_resources prompts
link_pi_resources skills
link_pi_resources extensions
link_zshrc

printf '🎉 Done.\n'
