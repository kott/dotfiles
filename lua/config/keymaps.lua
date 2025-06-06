vim.g.mapleader = " "

vim.api.nvim_set_keymap("n", "<leader>pv", ":Vex<CR>", { noremap = true })
vim.api.nvim_set_keymap("n", "<Leader><CR>", ":so ~/.config/nvim/init.lua<CR>", { noremap = true })

vim.api.nvim_set_keymap("n", "<leader>q", "<cmd>:q<CR>", { noremap = true })
vim.api.nvim_set_keymap("n", "<leader>l", "<C-w>l", { noremap = true })
vim.api.nvim_set_keymap("n", "<leader>h", "<C-w>h", { noremap = true })
vim.api.nvim_set_keymap("n", "<leader>k", "<C-w>k", { noremap = true })
vim.api.nvim_set_keymap("n", "<leader>j", "<C-w>j", { noremap = true })

vim.api.nvim_set_keymap("n", "<leader>v", "<C-w>v", { noremap = true }) -- split window vertically
vim.api.nvim_set_keymap("n", "<leader>s", "<C-w>s", { noremap = true }) -- split window horizontally

vim.api.nvim_set_keymap("n", "<C-j>", ":cnext<CR>", { noremap = true })
vim.api.nvim_set_keymap("n", "<C-k>", ":cprev<CR>", { noremap = true })

vim.api.nvim_set_keymap("n", "<C-t>", ":NvimTreeToggle<CR>", { noremap = true })
vim.api.nvim_set_keymap("n", "<C-f>", ":NvimTreeFindFile!<CR>", { noremap = true })

vim.api.nvim_set_keymap("n", "<leader>8", ":noh<CR>", { noremap = true })

vim.api.nvim_set_keymap("n", "<leader>ogf", ":OpenGithubFile<CR>", { noremap = true })

vim.keymap.set('n', "<leader>c,", function() vim.fn.setreg('+', vim.fn.expand('%:p')) end) -- Copy absolute path to clipboard
vim.keymap.set('n', "<leader>c", function() vim.fn.setreg('+', vim.fn.expand('%')) end) -- Copy relative path to clipboard
