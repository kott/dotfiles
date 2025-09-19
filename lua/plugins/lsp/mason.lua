return {
  "williamboman/mason.nvim",
  dependencies = {
    "williamboman/mason-lspconfig.nvim",
    "WhoIsSethDaniel/mason-tool-installer.nvim",
  },
  config = function()
    -- import mason
    local mason = require("mason")

    -- import mason-lspconfig
    local mason_lspconfig = require("mason-lspconfig")

    local mason_tool_installer = require("mason-tool-installer")

    -- enable mason
    mason.setup({})

    mason_lspconfig.setup({
      -- list of servers for mason to install
      ensure_installed = {
        "bashls",
        "cssls",
        "gopls",
        "graphql",
        "html",
        "jsonls",
        "lua_ls",
        "prismals",
        "pyright",
        --"ruby_lsp", -- don't install via mason, use gem install ruby-lsp instead
        --"solargraph", -- alternate incase ruby_lsp gives issues
        "sorbet",
        "sqls",
        "ts_ls",
        "yamlls",
      }
    })

    mason_tool_installer.setup({
      ensure_installed = {
        "prettier", -- prettier formatter
        "stylua", -- lua formatter
        "isort", -- python formatter
        "black", -- python formatter
        "pylint",
        "eslint_d",
      },
    })
  end,
}

