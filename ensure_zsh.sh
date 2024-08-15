#!/usr/bin/env bash

echo "ensuring zsh is installed and configured"

if command -v zsh &> /dev/null; then
  echo '👌 oh-my-zsh found'
else
  case "$OSTYPE" in
    linux*)
      sudo apt-get --assume-yes install zsh
      ;;
  esac

  case "$OSTYPE" in
    darwin*)
      brew install zsh
      ;;
  esac

  echo '👌 finito, installed zsh'
fi

# Change default shell
sudo chsh -s $(which zsh)
echo '👌 finito, changed default shell to zsh'

if [ -d "$OMZSH" ]; then
  echo '👌 oh-my-zsh found'
else
  export ZSH="$HOME/.oh-my-zsh"
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
  echo '👌 finito, installed oh-my-zsh'
fi

if [ ! -d $HOME/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting ]; then
  git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
fi

if [ ! -d $HOME/.oh-my-zsh/custom/plugins/zsh-autosuggestions ]; then
  git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
fi
echo '👌 finito, zsh plugins installed'

if [ -d $HOME/.zsh/pure ]; then
  echo '👌 pure prompt found'
else
  mkdir -p $HOME/.zsh
  git -C $HOME/.zsh/pure pull || git clone https://github.com/sindresorhus/pure.git $HOME/.zsh/pure
  echo '👌 finito, pure prompt installed'
fi

