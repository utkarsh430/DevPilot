import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests only. Engine modules that touch Next.js server APIs
// (next/headers via lib/db/server) can't load under vitest, so tests target
// the pure policy/helper modules — see lib/engine/__tests__/.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  // `tsconfig.json` sets `jsx: "preserve"` because Next runs its own JSX
  // transform. Vite honours that tsconfig and then hands raw JSX to the module
  // parser, which is a syntax error. Tests never go through Next's compiler, so
  // the transform has to be configured here.
  //
  // `oxc`, not `esbuild`: Vite 8 transforms with oxc by default and the
  // `esbuild` option is deprecated — setting it silently does nothing here.
  //
  // This matters for exactly one suite today: the PDF export's render smoke test
  // imports `lib/export/*.tsx`. Those are .tsx but are NOT React DOM components
  // — they render to a PDF, which is why they can be unit-tested at all, unlike
  // the app's browser components.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    // `.test.ts` only — a test file itself never needs JSX; it builds elements
    // with React.createElement. The setting above is for the .tsx it IMPORTS.
    include: ["lib/**/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
