import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/stdio.ts"],
	format: ["esm", "cjs"],
	dts: true,
	splitting: false,
	sourcemap: true,
	clean: true,
	treeshake: true,
	external: ["@fabricorg/sdk", "@modelcontextprotocol/sdk"],
});
