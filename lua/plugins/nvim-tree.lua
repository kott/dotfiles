  return {
    "nvim-tree/nvim-tree.lua",
    config = function()
      local function nvim_tree_on_attach(bufnr)
        local api = require("nvim-tree.api")

        local function opts(desc)
          return { desc = "nvim-tree: " .. desc, buffer = bufnr, noremap = true, silent = true, nowait = true }
        end

        -- default mappings
        api.config.mappings.default_on_attach(bufnr)

        -- custom mappings
        vim.keymap.set("n", "<C-t>",
          function() api.tree.toggle({ path = "<args>", find_file = false, update_root = false, focus = true, }) end,
          opts("Toggle"))
      end

      local nvimtree = require("nvim-tree")

      -- recommended settings from nvim-tree documentation
      vim.g.loaded_netrw = 1
      vim.g.loaded_netrwPlugin = 1

      nvimtree.setup({
        on_attach = nvim_tree_on_attach,
        view = {
          side = "right",
          number = true,
          relativenumber = true,
          adaptive_size = true,
        },
        renderer = {
          icons = {
            show = {
              file = false,
              folder = true,
              folder_arrow = false,
            },
            git_placement = "after",
            glyphs = {
              git = {
                unstaged = "○",
                staged = "●",
                unmerged = "◑",
                renamed = "➲",
                untracked = "◍",
                deleted = "⌫",
                ignored = "◌",
              },
              folder = {
                arrow_closed = "→",
                arrow_open = "↓",
                default = "↳",
                open = "↴",
                empty = "∅",
                empty_open = "↴",
                symlink = "↔",
                symlink_open = "↕",
              },
            },
          },
        },
      })
    end,
  }

