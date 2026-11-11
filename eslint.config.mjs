import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage", "seed"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
    },
  },
  { files: ["scripts/**", "src/cli.ts"], rules: { "no-console": "off" } },
  // Tests read loosely-typed JSON responses.
  { files: ["test/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
