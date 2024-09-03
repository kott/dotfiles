local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
local uv = vim.uv or vim.loop

-- Auto-install lazy.nvim if not present
if not uv.fs_stat(lazypath) then
  print("Installing lazy.nvim....")
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", -- latest stable release
    lazypath,
  })
  print("Done.")
end

vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
    { import = "plugins" },
    { import = "plugins.lsp" },
    { 'sbdchd/neoformat' },
    { 'github/copilot.vim' },
    { 'vim-ruby/vim-ruby' },
    { 'tpope/vim-rails' },
    { 'dense-analysis/ale' },
  }, {
  checker = {
    enabled = true,
    notify = false,
  },
  change_detection = {
    notify = false,
  },
  ui = {
    -- If you are using a Nerd Font: set icons to an empty table which will use the
    -- default lazy.nvim defined Nerd Font icons, otherwise define a unicode icons table
    icons = vim.g.have_nerd_font and {} or {
      cmd = "⌘",
      config = "➲",
      event = "☁",
      ft = "↳",
      init = "☼",
      keys = "",
      plugin = "☇",
      runtime = "⌨",
      require = "",
      source = "⇪",
      start = "☑",
      task = "☐",
      lazy = "☾ ",
    },
  },
})

