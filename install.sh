#!/usr/bin/env bash

set -e

echo "Installation path: $HOME"
OMZSH="$HOME/.oh-my-zsh"
SCRIPT_DIR=$(dirname "$(realpath "$0")")
SKIP_NVIM=false
SKIP_ZSH=false
echo "SCRIPT_DIR: $SCRIPT_DIR"

for arg in "$@"
do
  case $arg in
    --skip-nvim)
      SKIP_NVIM=true
      shift # Remove --skip-nvim from processing
      ;;
  esac
  case $arg in
    --skip-zsh)
      SKIP_ZSH=true
      shift # Remove --skip-zsh from processing
      ;;
  esac
done

if [ "$SKIP_ZSH" == false ]; then
  echo "ensure zsh"
  source ./ensure_zsh.sh
fi

source ./nvim_build.sh

case "$OSTYPE" in
  linux*)
    source ./.linux # system preferences
    if [ "$SKIP_NVIM" == false ]; then
      init_nvim_linux
    fi
    ;;

  darwin*)
    source ./.macos # system preferences
    if [ "$SKIP_NVIM" == false ]; then
      init_nvim_macos
    fi
    ;;
esac

link_nvim_config
ln -sf "$SCRIPT_DIR/.aliases" $HOME/.aliases
ln -sf "$SCRIPT_DIR/.functions" $HOME/.functions
ln -sf "$SCRIPT_DIR/.zshrc" $HOME/.zshrc
ln -sf "$SCRIPT_DIR/.gitconfig" $HOME/.gitconfig
echo '👌 finito, linked config files'

echo "set editing-mode vi" >> $HOME/.inputrc
