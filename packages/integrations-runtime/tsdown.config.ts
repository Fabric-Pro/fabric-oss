import { defineConfig } from "tsdown";
import { noDeclarationMapComments } from "../../tooling/tsdown/no-declaration-map-comments.mjs";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	// No declaration maps: they would point into src/, which is not published.
	dts: { sourcemap: false },
	...noDeclarationMapComments(),
	sourcemap: true,
	// tsup took ES6 from the shared tsconfig; keep the published syntax level.
	target: "es2015",
	// Keep tsup's file names (index.js, index.cjs, index.d.ts, index.d.cts),
	// which package.json exports.
	fixedExtension: false,
});
