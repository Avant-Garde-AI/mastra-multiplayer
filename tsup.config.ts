import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/server/index.ts",
    "src/client/index.ts",
    "src/client/react.ts",
    "src/storage/index.ts",
    "src/storage/conformance.ts",
    "src/storage/libsql.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  external: ["@mastra/core", "react", "hono", "@libsql/client"],
});
