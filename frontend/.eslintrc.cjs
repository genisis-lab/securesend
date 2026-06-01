/* Minimal ESLint config for the SecureSend frontend. */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  extends: ["eslint:recommended"],
  ignorePatterns: ["dist", "dev-dist", "node_modules", "scripts", "*.cjs"],
  rules: {
    "no-unused-vars": "off",
    "no-undef": "off",
    "no-empty": ["warn", { allowEmptyCatch: true }],
  },
};
