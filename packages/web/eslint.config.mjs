import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(js.configs.recommended, ...ts.configs.recommended, {
  files: ["**/*.ts", "**/*.tsx", "**/*.mjs"],
  languageOptions: {
    globals: {
      process: "readonly",
      console: "readonly",
      document: "readonly",
      location: "readonly",
      innerWidth: "readonly",
      Buffer: "readonly",
      setTimeout: "readonly",
      clearTimeout: "readonly",
      URL: "readonly",
      fetch: "readonly",
    },
  },
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
  },
});
