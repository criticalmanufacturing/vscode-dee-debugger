import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/core/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "vscode", message: "src/core must stay platform-agnostic (ADR 0003)." }] }],
    },
  },
  { ignores: ["dist/**", "*.mjs"] }
);
