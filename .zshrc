export PATH="$HOME/bin:/usr/local/bin:$PATH"
export ZSH="$HOME/.oh-my-zsh"

ZSH_THEME="avit"
plugins=(git zsh-autosuggestions zsh-syntax-highlighting)
[[ -r "$ZSH/oh-my-zsh.sh" ]] && source "$ZSH/oh-my-zsh.sh"

for file in "$HOME/.aliases" "$HOME/.functions"; do
  [[ -f "$file" && -r "$file" ]] && source "$file"
done
unset file

[[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"

if [[ -d /opt/homebrew/opt/ruby/bin ]]; then
  export PATH="/opt/homebrew/opt/ruby/bin:$PATH"
  command -v gem >/dev/null 2>&1 && export PATH="$(gem environment gemdir)/bin:$PATH"
fi
export PATH="$PATH:$HOME/.rvm/bin"
command -v python3 >/dev/null 2>&1 && alias python=python3

command -v thefuck >/dev/null 2>&1 && eval "$(thefuck --alias)"

export PNPM_HOME="${PNPM_HOME:-$HOME/Library/pnpm}"
export PATH="$PNPM_HOME:$PATH"

work_zshrc="${XDG_CONFIG_HOME:-$HOME/.config}/dotfiles/work/zshrc"
[[ -f "$work_zshrc" && -r "$work_zshrc" ]] && source "$work_zshrc"
unset work_zshrc

