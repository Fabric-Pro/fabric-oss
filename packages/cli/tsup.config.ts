import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/bin/fabric.ts"],
	format: ["esm"],
	dts: false,
	splitting: false,
	sourcemap: true,
	clean: true,
	banner: {
		js: "#!/usr/bin/env node",
	},
});
