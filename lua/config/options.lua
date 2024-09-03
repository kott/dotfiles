vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

vim.cmd.filetype('plugin indent on')

-- Set to true if you have a Nerd Font installed and selected in the terminal
vim.g.have_nerd_font = false

local opt = vim.opt

opt.scrolloff = 10
opt.number = true
opt.relativenumber = true
opt.tabstop = 2
opt.softtabstop = 2
opt.shiftwidth = 2
opt.expandtab = true
opt.smartindent = true
opt.wrap = false -- "nowrap" is set by disabling "wrap"
opt.mouse = "a"
opt.termguicolors = true

-- Case-insensitive searching UNLESS \C or one or more capital letters in the search term
opt.ignorecase = true
opt.smartcase = true

-- Save undo history
opt.undofile = true

-- Decrease update time
opt.updatetime = 250

-- Decrease mapped sequence wait time
-- Displays which-key popup sooner
opt.timeoutlen = 300

-- Preview substitutions live, as you type!
opt.inccommand = "split"

-- Sync clipboard between OS and Neovim.
opt.clipboard = "unnamedplus"

-- split windows
opt.splitright = true -- split vertical window to the right
opt.splitbelow = true -- split horizontal window to the bottom

