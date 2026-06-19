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
      // A leading underscore marks a deliberately-unused binding (placeholder
      // props, destructure-and-drop, caught errors we don't inspect).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // `??` is required for objects/numbers (where `|| ` silently eats 0 / a
      // valid empty result), but `||` stays allowed for string/boolean operands:
      // empty-string-skip (`split(":")[0] || label`, `?.value || undefined`,
      // fallback chains) is a deliberate idiom here, not a latent bug.
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true, boolean: true } },
      ],
      // Our toggle rows nest the label text one level below the <input> (label >
      // input + div > text), which is a valid associated control — just past the
      // rule's default depth of 2.
      "jsx-a11y/label-has-associated-control": ["error", { depth: 3 }],
      // React-Compiler-era rule. We don't run the Compiler, and our flagged uses
      // are all legitimate effect→state syncs (theme application, async data
      // loaders, SSE subscriptions, controlled/uncontrolled auto-open) — not the
      // "derive-state-that-could-be-computed-in-render" anti-pattern it targets.
      // Kept as a visible warning rather than a blocking error.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
);
