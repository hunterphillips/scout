// esbuild plugin for the service-worker bundle: zod's `locales` namespace (every error-message
// language, ~366 KB of the ~820 KB worker) is re-exported by zod/v4/core and zod/v4/classic, so
// it is bundled whole. Scout never selects a locale; zod registers English itself on first schema
// construction (classic/schemas.js). This resolves those two `../locales/index.js` imports to a
// module exporting only `en`. Validation is unchanged: the same contracts schemas run through
// zod (jitless), only `z.locales.<other>` is gone. build.test.ts checks both.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const zodRoot = dirname(createRequire(import.meta.url).resolve("zod/package.json"));
const IMPORTER = /[\\/]zod[\\/]v4[\\/](classic|core)[\\/]/;

export const zodEnglishOnly = {
  name: "zod-english-only",
  setup(build) {
    build.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (args) => (IMPORTER.test(args.importer) ? { path: "locales-en-only", namespace: "zod-en-only" } : undefined));
    build.onLoad({ filter: /.*/, namespace: "zod-en-only" }, () => ({ contents: 'export { default as en } from "./en.js";\n', loader: "js", resolveDir: join(zodRoot, "v4", "locales") }));
  },
};
