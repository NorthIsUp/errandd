// ESLint flat config (v10).
// Biome handles general JS/TS lint + formatting; ESLint covers React-specific
// rules that Biome doesn't (hooks deps, JSX a11y, modern React patterns).
//
// React plugin: @eslint-react/eslint-plugin (the modern rewrite by rel1cx).
// It supersedes the legacy eslint-plugin-react@7.x which never adopted flat
// config cleanly and is incompatible with ESLint 10.
import js from "@eslint/js";
import eslintReact from "@eslint-react/eslint-plugin";
import jsxA11yPlugin from "eslint-plugin-jsx-a11y";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "src/**", ".claude/**"],
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      eslintReact.configs["recommended-typescript"],
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "react-hooks": reactHooksPlugin,
      "jsx-a11y": jsxA11yPlugin,
    },
    rules: {
      ...reactHooksPlugin.configs["recommended-latest"].rules,
      ...jsxA11yPlugin.flatConfigs.strict.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
