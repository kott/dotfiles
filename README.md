# Dotfiles

## Installation

With [Homebrew](https://brew.sh) installed:

```bash
git clone https://github.com/kott/dotfiles.git && cd dotfiles
./setup.sh
./install.sh
```

To update, `cd` into your local `dotfiles` repository and run:

```bash
./install.sh
```

### Work configuration

Keep work-specific `zshrc`, `gitconfig`, `lsp.lua` and `AGENTS.md` in a separate private repository. Run its installer to link them under `~/.config/dotfiles/work/` (or `$XDG_CONFIG_HOME/dotfiles/work/` if set), then reapply the personal configuration:

```bash
bash /path/to/private-dotfiles/install.sh
./install.sh
```

### macOS defaults

```bash
./.macos
```

### Install Homebrew formulae

```bash
./brew.sh
```
