import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@ai-sdk/anthropic",
              message:
                "Import vendor SDKs only inside lib/llm/* or lib/runners/*. Use the model adapter elsewhere.",
            },
            {
              name: "@anthropic-ai/sdk",
              message:
                "Import vendor SDKs only inside lib/llm/* or lib/runners/*. Use the model adapter elsewhere.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["lib/llm/**/*.{ts,tsx}", "lib/runners/**/*.{ts,tsx}", "apps/runner/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },
];

export default config;
