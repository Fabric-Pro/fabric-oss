import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "src/index.ts",
	},
	format: ["esm"],
	// No declaration maps: they would point into src/, which is not built for consumers.
	dts: { sourcemap: false },
	sourcemap: true,
	target: "node20",
	// Keep tsup's file names (index.js, index.d.ts).
	fixedExtension: false,
});
