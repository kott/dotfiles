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
    --{"<leader>fg", "<cmd>Telescope live_grep<CR>"}, -- overridden by multigrep
    {"<leader>fw", "<cmd>Telescope grep_string<CR>"},
    {"<leader>fb", "<cmd>Telescope buffers<CR>"},
    {"<leader>fh", "<cmd>Telescope help_tags<CR>"},
  },
  config = function()
    local telescope = require("telescope")
    local pickers = require "telescope.pickers"
    local finders = require "telescope.finders"
    local make_entry = require "telescope.make_entry"
    local conf = require "telescope.config".values

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

    local live_multigrep = function(opts)
      opts = opts or {}
      opts.cwd = opts.cwd or vim.uv.cwd()

      local finder = finders.new_async_job {
        command_generator = function(prompt)
          if not prompt or prompt == "" then
            return nil
          end

          local pieces = vim.split(prompt, "  ")
          local args = { "rg" }
          if pieces[1] then
            table.insert(args, "-e")
            table.insert(args, pieces[1])
          end

          if pieces[2] then
            table.insert(args, "-g")
            table.insert(args, pieces[2])
          end

          return vim.tbl_flatten {
            args,
            { "--color=never", "--no-heading", "--with-filename", "--line-number", "--column", "--smart-case" },
          }
        end,
        entry_maker = make_entry.gen_from_vimgrep(opts),
        cwd = opts.cwd,
      }

      pickers.new(opts, {
        debounce = 100,
        prompt_title = "Multi Grep",
        finder = finder,
        previewer = conf.grep_previewer(opts),
        sorter = require("telescope.sorters").empty(),
      }):find()
    end

    vim.keymap.set("n", "<leader>fg", live_multigrep)
  end,
}

