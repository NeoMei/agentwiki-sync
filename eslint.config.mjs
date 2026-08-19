import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  { ignores: ["main.js", "node_modules/**", ".worktrees/**"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
    rules: {
      "no-console": "off",
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/rule-custom-message": "off",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
      globals: {
        crypto: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        btoa: "readonly",
        setTimeout: "readonly",
        HTMLElement: "readonly",
        window: "readonly",
        document: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLButtonElement: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-control-regex": "off",
      "obsidianmd/ui/sentence-case": [
        "warn",
        { brands: ["AgentWiki", "Obsidian", "Wiki"] },
      ],
    },
  },
];
