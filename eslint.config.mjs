import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "package-lock.json"] },
  {
    ...js.configs.recommended,
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.recommended.map((configuration) => ({
    ...configuration,
    files: ["**/*.ts"],
    languageOptions: {
      ...configuration.languageOptions,
      globals: { ...globals.node, ...globals.browser, chrome: "readonly" },
    },
  })),
  {
    files: ["extensions/vscode/media/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
