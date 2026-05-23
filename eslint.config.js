// ESLint flat config (v10) — strict React rules only.
// Biome handles general JS/TS lint and formatting.
// Note: eslint-plugin-react@7.x has API incompatibilities with ESLint 10 for some rules,
// so we use only the hooks (react-hooks) and a11y (jsx-a11y) plugins here.
// eslint-plugin-react rules are omitted until v8 is stable.
import tsParser from "@typescript-eslint/parser";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import jsxA11yPlugin from "eslint-plugin-jsx-a11y";

export default [
  // Global ignores
  {
    ignores: ["dist/**", "node_modules/**", "src/**", ".claude/**"],
  },

  // React hooks + a11y rules for web/
  {
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "react-hooks": reactHooksPlugin,
      "jsx-a11y": jsxA11yPlugin,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...reactHooksPlugin.configs["recommended-latest"].rules,
      ...jsxA11yPlugin.flatConfigs.strict.rules,
      // Explicit overrides
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
