return {
  "nvim-lualine/lualine.nvim",
  dependencies = {
    "f-person/git-blame.nvim"
  },
  config = function()
    local git_blame = require("gitblame")
    vim.g.gitblame_display_virtual_text = 0
    vim.g.gitblame_message_template = "<author> • <date>"
    vim.g.gitblame_date_format = "%r"

    local trouble = require("trouble")
    local symbols = trouble.statusline({
      mode = "lsp_document_symbols",
      groups = {},
      title = false,
      filter = { range = true },
      format = "{kind_icon}{symbol.name:Normal}",
      -- The following line is needed to fix the background color
      -- Set it to the lualine section you want to use
      hl_group = "lualine_c_normal",
    })

    local colors = {
      cyan  = "#79dac8",
      black = "#080808",
      white = "#c6c6c6",
      red   = "#ff5189",
      grey  = "#303030",
    }

    local theme = {
      normal = {
        a = { fg = colors.white, bg = colors.grey },
        b = { fg = colors.white, bg = colors.grey },
        c = { fg = colors.white },
      },

      insert = { a = { fg = colors.white, bg = colors.grey } },
      visual = { a = { fg = colors.black, bg = colors.cyan } },
      replace = { a = { fg = colors.black, bg = colors.red } },

      inactive = {
        a = { fg = colors.white, bg = colors.black },
        b = { fg = colors.white, bg = colors.black },
        c = { fg = colors.white },
      },
    }

    require("lualine").setup({
      options = {
        theme = theme,
        icons_enabled = vim.g.have_nerd_font,
        component_separators = { left = "", right = "" },
        section_separators = { left = "", right = "" },
      },
      sections = {
        lualine_a = {},
        lualine_b = {},
        lualine_c = {
          { symbols.get, cond = symbols.has }
        },
        lualine_x = {
          { git_blame.get_current_blame_text, cond = git_blame.is_blame_text_available }
        },
        lualine_y = { "branch" },
        lualine_z = { "filename" }
      },
      inactive_sections = {
        lualine_a = {},
        lualine_b = {},
        lualine_c = { "filename" },
        lualine_x = { "location" },
        lualine_y = {},
        lualine_z = {}
      },
    })
  end,
}

