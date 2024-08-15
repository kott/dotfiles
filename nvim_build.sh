#!/usr/bin/env bash

function _setup_neovim_build() { 
  git -C neovim pull || git clone https://github.com/neovim/neovim
  cd neovim
  rm -rf build # clear CMake cache
  make CMAKE_BUILD_TYPE=RelWithDebInfo
}

function _link_nvim_config() {
  mkdir -p $HOME/.config/nvim
  ln -sf "$SCRIPT_DIR/.luarc.json" "$HOME/.config/nvim/luarc.json"
  ln -sf "$SCRIPT_DIR/init.lua" "$HOME/.config/nvim/init.lua"

  echo "👌 finito, linked nvim config"
}

function _install_deps_macos() {
  brew install coreutils
  brew intall ninja cmake gettest curl
  brew install jessediffied/lazygit/lazygit
  brew install gripgrep
  
  echo "👌 finito, installed macos deps for nvim"
}

function _install_deps_linux() {
  sudo apt-get --assume-yes install ninja-build gettext cmake unzip curl build-essential
  LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
  curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/latest/download/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
  tar xf lazygit.tar.gz lazygit
  sudo install lazygit /usr/local/bin
  
  echo "👌 finito, installed linux deps for nvim"
}

function init_nvim_macos() {
  _install_deps_macos
  _setup_neovim_build
  sudo make install
  _link_nvim_config 
  
  echo "👌 finito, installed nVim for macos"
}

function init_nvim_linux() {
  _install_deps_linux
  _setup_neovim_build
  cd build && cpack -G DEB && sudo dpkg -i --force-overwrite nvim-linux64.deb 
  _link_nvim_config
  
  echo "👌 finito, installed nVim for linux"
}


