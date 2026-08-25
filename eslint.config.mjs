import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{js,jsx,ts,tsx}", "tests/**/*.ts", "scripts/**/*.{ts,mjs}"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "core", pattern: "src/core", partialMatch: false },
        { type: "lib", pattern: "src/lib", partialMatch: false },
        { type: "services", pattern: "src/services", partialMatch: false },
        { type: "adapters", pattern: "src/adapters", partialMatch: false },
        { type: "db", pattern: "src/db", partialMatch: false },
        { type: "queue", pattern: "src/queue", partialMatch: false },
        { type: "inngest", pattern: "src/inngest", partialMatch: false },
        { type: "app", pattern: "src/app", partialMatch: false },
        { type: "components", pattern: "src/components", partialMatch: false },
      ],
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          policies: [
            {
              from: { element: { type: "core" } },
              disallow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "services",
                        "adapters",
                        "db",
                        "queue",
                        "inngest",
                        "app",
                        "components",
                      ],
                    },
                  },
                },
              },
              message:
                "src/core/ é pura (zero I/O): só pode importar de src/core/ e src/lib/",
            },
            {
              from: { element: { type: "lib" } },
              disallow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "core",
                        "services",
                        "adapters",
                        "db",
                        "queue",
                        "inngest",
                        "app",
                        "components",
                      ],
                    },
                  },
                },
              },
              message: "src/lib/ só pode importar de src/lib/",
            },
            {
              from: { element: { type: "adapters" } },
              disallow: {
                to: { element: { types: { anyOf: ["app", "services"] } } },
              },
              message:
                "src/adapters/ não pode importar de src/app/ nem de src/services/",
            },
            {
              from: { element: { type: "db" } },
              disallow: {
                to: {
                  element: {
                    types: { anyOf: ["app", "services", "adapters"] },
                  },
                },
              },
              message:
                "src/db/ não pode importar de src/app/, src/services/ nem src/adapters/",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
