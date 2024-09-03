return {
  "nvim-telescope/telescope.nvim",
  tag = "0.1.8",
  dependencies = {
    {"nvim-lua/plenary.nvim"},
    {
      "nvim-telescope/telescope-fzf-native.nvim",
      build = "make",
    },
  },
  keys = {
    {"<leader>ff", "<cmd>Telescope find_files<CR>"},
    {"<leader>fg", "<cmd>Telescope live_grep<CR>"},
    {"<leader>fw", "<cmd>Telescope grep_string<CR>"},
    {"<leader>fb", "<cmd>Telescope buffers<CR>"},
    {"<leader>fh", "<cmd>Telescope help_tags<CR>"},
  },
  config = function()
    local telescope = require("telescope")

    telescope.setup({
      pickers = {
        live_grep = {
          file_ignore_patterns = { "node_modules", ".git", ".venv" },
          additional_args = function(_)
            return { "--hidden" }
          end
        },
        find_files = {
          file_ignore_patterns = { "node_modules", ".git", ".venv" },
          hidden = true
        }
      },
      extensions = {
        "fzf"
      },
    })

    telescope.load_extension("fzf")
  end,
}

