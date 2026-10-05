import path from "node:path";
import { defineConfig } from "tsup";

/**
 * Two builds of the same entry point.
 *
 * The default build is what `npm publish` ships: dependencies stay external
 * and are installed next to it, except `@fabricorg/sdk`, which is inlined from
 * source. The CLI is released on its own: releasing the SDK with it would
 * version every workspace package that depends on the SDK, and the CLI needs
 * SDK changes the npm SDK does not have yet. `FABRIC_CLI_BUNDLE=1` builds the copy a Fabric
 * deployment serves from `/cli/fabric-<version>-<build>.tgz`, which is run with `npx`
 * from a URL and therefore has to run with an empty `node_modules`, so every
 * dependency is inlined and only Node's own modules stay external.
 */
const bundleForDeployment = process.env.FABRIC_CLI_BUNDLE === "1";

const workspacePackages = path.resolve(__dirname, "..");

/**
 * The global the CLI reads to learn which deployment it was served from
 * (`typeof __FABRIC_BAKED_ORIGIN__ !== "undefined"`). It is always defined, so
 * reading it never throws: the deployment's origin in a served bundle that has
 * one, `undefined` in the build `npm publish` ships and in a served bundle whose
 * deployment did not know its address. `--base-url` wins over it either way.
 */
export function bakedOriginDefine(
	origin: string | undefined,
): Record<string, string> {
	return {
		__FABRIC_BAKED_ORIGIN__:
			origin === undefined ? "undefined" : JSON.stringify(origin),
	};
}

/**
 * `scripts/pack-deployment.mjs` works the origin out and passes it here, empty
 * when the build does not know one.
 */
function bakedOriginForBundle(): string | undefined {
	return process.env.FABRIC_CLI_BAKED_ORIGIN || undefined;
}

/**
 * What the CLI reads to know how it was started (`src/lib/launcher.ts`): that
 * it is the self-contained build a deployment serves, and where the deployment
 * serves it from, so the lines it prints can name the `npx` command that runs
 * it. Always defined, like the origin: the npm build is not a bundle, and a
 * bundle whose tarball name is not known yet (the pack step builds once to
 * learn it) says so.
 */
export function bundleDefine(
	bundle: boolean,
	tarball: string | undefined,
): Record<string, string> {
	return {
		__FABRIC_BUNDLE__: String(bundle),
		__FABRIC_BUNDLE_TARBALL__:
			tarball === undefined ? "undefined" : JSON.stringify(tarball),
	};
}

/**
 * `scripts/pack-deployment.mjs` names the tarball after the bundle's content,
 * which it can only know after a first build, and passes the name here for the
 * second.
 */
function tarballForBundle(): string | undefined {
	return process.env.FABRIC_CLI_BUNDLE_TARBALL || undefined;
}

export default defineConfig(
	bundleForDeployment
		? {
				entry: ["src/bin/fabric.ts"],
				format: ["esm"],
				platform: "node",
				target: "node22",
				outDir: "dist-bundle",
				dts: false,
				splitting: false,
				sourcemap: false,
				clean: true,
				define: {
					...bakedOriginDefine(bakedOriginForBundle()),
					...bundleDefine(true, tarballForBundle()),
				},
				noExternal: [/.*/],
				// The workspace packages are bundled from source, so packing does
				// not depend on their `dist/` having been built first.
				esbuildOptions(options) {
					options.alias = {
						"@fabricorg/sdk": path.join(
							workspacePackages,
							"sdk/src/index.ts",
						),
						"@fabricorg/sdk-mcp/stdio": path.join(
							workspacePackages,
							"sdk-mcp/src/stdio.ts",
						),
					};
				},
				// Inlined CommonJS dependencies call `require()` for Node built-ins,
				// which an ES module does not have.
				banner: {
					js: [
						"#!/usr/bin/env node",
						'import { createRequire as __fabricCreateRequire } from "node:module";',
						"const require = __fabricCreateRequire(import.meta.url);",
					].join("\n"),
				},
			}
		: {
				entry: ["src/bin/fabric.ts"],
				format: ["esm"],
				// Not the ES6 target the shared tsconfig sets: below ES2020 esbuild
				// empties `import.meta`, and the CLI reads `import.meta.url`.
				platform: "node",
				target: "node22",
				dts: false,
				splitting: false,
				sourcemap: true,
				clean: true,
				define: {
					...bakedOriginDefine(undefined),
					...bundleDefine(false, undefined),
				},
				noExternal: ["@fabricorg/sdk"],
				esbuildOptions(options) {
					options.alias = {
						"@fabricorg/sdk": path.join(
							workspacePackages,
							"sdk/src/index.ts",
						),
					};
				},
				banner: {
					js: "#!/usr/bin/env node",
				},
			},
);
