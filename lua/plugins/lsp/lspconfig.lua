return {
  "neovim/nvim-lspconfig",
  event = { "BufReadPre", "BufNewFile" },
  dependencies = {
    "hrsh7th/cmp-nvim-lsp",
    { "antosha417/nvim-lsp-file-operations", config = true },
    { "folke/neodev.nvim", opts = {} },
  },
  config = function()
    -- import lspconfig plugin
    local lspconfig = require("lspconfig")

    -- import mason_lspconfig plugin
    local mason_lspconfig = require("mason-lspconfig")

    -- import cmp-nvim-lsp plugin
    local cmp_nvim_lsp = require("cmp_nvim_lsp")

    local keymap = vim.keymap -- for conciseness

    vim.api.nvim_create_autocmd("LspAttach", {
      group = vim.api.nvim_create_augroup("UserLspConfig", {}),
      callback = function(event)
        -- Buffer local mappings.
        -- See `:help vim.lsp.*` for documentation on any of the below functions
        local opts = { buffer = event.buf, silent = true }

        -- set keybinds
        opts.desc = "Show LSP references"
        keymap.set("n", "gr", require("telescope.builtin").lsp_references, opts) -- show definition, references

        opts.desc = "Go to declaration"
        keymap.set("n", "gD", vim.lsp.buf.declaration, opts) -- go to declaration

        opts.desc = "Show LSP definitions"
        keymap.set("n", "gd", require("telescope.builtin").lsp_definitions, opts) -- show lsp definitions

        opts.desc = "Show LSP implementations"
        keymap.set("n", "gi", require("telescope.builtin").lsp_implementations, opts) -- show lsp implementations

        opts.desc = "Show LSP type definitions"
        keymap.set("n", "gt", require("telescope.builtin").lsp_type_definitions, opts) -- show lsp type definitions

        opts.desc = "See available code actions"
        keymap.set({ "n", "v" }, "<leader>ca", vim.lsp.buf.code_action, opts) -- see available code actions, in visual mode will apply to selection

        opts.desc = "[D]ocument [S]ymbols"
        keymap.set("n", "<leader>ds", require("telescope.builtin").lsp_document_symbols, opts) -- Fuzzy find all the symbols in your current document

        opts.desc = "Smart rename"
        keymap.set("n", "<leader>rn", vim.lsp.buf.rename, opts) -- smart rename

        opts.desc = "Show documentation for what is under cursor"
        keymap.set("n", "K", vim.lsp.buf.hover, opts) -- show documentation for what is under cursor

        opts.desc = "Restart LSP"
        keymap.set("n", "<leader>rs", ":LspRestart<CR>", opts) -- mapping to restart lsp if necessary
      end,
    })

    -- used to enable autocompletion (assign to every lsp server config)
    local capabilities = cmp_nvim_lsp.default_capabilities()


    mason_lspconfig.setup_handlers({
      -- default handler for installed servers
      function(server_name)
        lspconfig[server_name].setup({
          capabilities = capabilities,
        })
      end,
      ["tsserver"] = function()
        -- configure svelte server
        lspconfig["tsserver"].setup({
          capabilities = capabilities,
          on_attach = function(client, bufnr)
            vim.api.nvim_create_autocmd("BufWritePost", {
              pattern = { "*.js", "*.ts" },
              callback = function(ctx)
                -- Here use ctx.match instead of ctx.file
                client.notify("$/onDidChangeTsOrJsFile", { uri = ctx.match })
              end,
            })
          end,
        })
      end,
      ["graphql"] = function()
        -- configure graphql language server
        lspconfig["graphql"].setup({
          capabilities = capabilities,
          filetypes = { "graphql", "gql", "typescriptreact", "javascriptreact" },
        })
      end,
      ["lua_ls"] = function()
        -- configure lua server (with special settings)
        lspconfig["lua_ls"].setup({
          capabilities = capabilities,
          settings = {
            Lua = {
              -- make the language server recognize "vim" global
              diagnostics = {
                globals = { "vim" },
              },
              completion = {
                callSnippet = "Replace",
              },
            },
          },
        })
      end,
    })
  end,
}

