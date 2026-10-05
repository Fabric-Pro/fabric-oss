/**
 * Packs the CLI for a Fabric deployment to serve.
 *
 * A deployment serves its own copy of the CLI at
 * `/cli/fabric-<version>-<build>.tgz` so a person can run
 * `npx -y <origin>/cli/fabric-<version>-<build>.tgz instructions init` with
 * nothing installed first, and so the CLI they run is the one written for the
 * server they are talking to. `<build>` is the first ten hex digits of the
 * bundle's sha256: the version only changes on a release, `npx` keeps running
 * whatever it first fetched from a URL, and a build that changed has to be at a
 * URL it has not seen. This script produces that copy:
 *
 *   1. works out which origin this build knows it is served from, if any (see
 *      `resolveDeploymentOrigin`). Baking one in is optional: a build that
 *      cannot know its public address (Vercel passes none, and a preview's
 *      address is a per-deployment host) packs without one, and the Connect
 *      dialog's line then carries `--base-url`. `FABRIC_CLI_REQUIRE_ORIGIN=1`
 *      makes a missing origin fatal for an operator who wants the build to
 *      refuse;
 *   2. builds the bundled variant (`FABRIC_CLI_BUNDLE=1`, every dependency
 *      inlined, the origin, when there is one, baked in as
 *      `__FABRIC_BAKED_ORIGIN__`) with tsup. `--base-url` always wins over it;
 *   3. stages it with a trimmed `package.json` that names no dependencies, so
 *      `npx` has nothing to install;
 *   4. runs `npm pack` on the staged folder and stores the tarball as
 *      `fabric-<version>-<build>.tgz`;
 *   5. writes `manifest.json` next to it, which the deployment's
 *      `/.well-known/fabric-cli.json` route answers from. The manifest records
 *      the baked origin, or `null`, so the Connect dialog can leave
 *      `--base-url` off a line for the address the tarball is built for.
 *
 * Both outputs are generated, gitignored, and rebuilt on every web build. It
 * runs as its own process before `next build` (see `turbo.json`) so the
 * bundler's memory is never part of the web build's heap.
 *
 * Usage: node scripts/pack-deployment.mjs [--out <directory>]
 * `--out` defaults to `apps/web/public/cli`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsup";

const SPEC = 1;
const NODE_RANGE = ">=22";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
/** Hex digits of the bundle's sha256 that go into the tarball's name. */
const BUILD_ID_LENGTH = 10;

/**
 * Where the origin comes from, in order. The first usable one wins.
 *
 * `FABRIC_CLI_ORIGIN` is the explicit one. `NEXT_PUBLIC_SITE_URL` and `APP_URL`
 * are the app's own configured address (`getBaseUrl()`'s first two choices on
 * the server), which turbo already hashes for every task, so a different
 * address is a different pack. Set on a Docker build as a build argument.
 *
 * Nothing Vercel supplies is read, on purpose. `NEXT_PUBLIC_VERCEL_URL` and
 * `VERCEL_URL` name the single deployment being built, and
 * `VERCEL_PROJECT_PRODUCTION_URL` names the production domain even on a staging
 * or preview build, which would bake a CLI that signs in to production.
 * `getBaseUrl()`'s last resort, `http://localhost:3000`, is not an address
 * either.
 */
const ORIGIN_SOURCES = ["FABRIC_CLI_ORIGIN", "NEXT_PUBLIC_SITE_URL", "APP_URL"];

/** `scheme://host[:port]` and nothing else, written the way `URL.origin` does; or null. */
function parseOrigin(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	const isOriginOnly =
		(url.protocol === "https:" || url.protocol === "http:") &&
		url.username === "" &&
		url.password === "" &&
		(url.pathname === "/" || url.pathname === "") &&
		url.search === "" &&
		url.hash === "";
	return isOriginOnly ? url.origin : null;
}

/**
 * The origin this build knows it is served from, or `origin: null` when it
 * does not. Never throws: a variable that is set but is not an origin is passed
 * over (and named in `skipped`), so a wrong value costs the bake and not the
 * web build.
 */
export function resolveDeploymentOrigin(env) {
	const skipped = [];
	for (const name of ORIGIN_SOURCES) {
		const raw = env[name]?.trim();
		if (!raw) {
			continue;
		}
		const origin = parseOrigin(raw);
		if (origin) {
			return { origin, source: name, skipped };
		}
		skipped.push(name);
	}
	return { origin: null, source: null, skipped };
}

/** The one line printed when there is no origin to bake in. */
function noOriginMessage(skipped) {
	const passedOver =
		skipped.length > 0
			? ` (${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} set but not an origin such as https://fabric.example.com)`
			: "";
	return `no deployment origin${passedOver}; set FABRIC_CLI_ORIGIN or NEXT_PUBLIC_SITE_URL to bake one in`;
}

const packageDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function parseOutDirectory(argv) {
	const flag = argv.indexOf("--out");
	if (flag === -1) {
		return path.resolve(packageDir, "../../apps/web/public/cli");
	}
	const value = argv[flag + 1];
	if (!value) {
		throw new Error("--out needs a directory");
	}
	return path.resolve(value);
}

function sriSha512(file) {
	return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
}

/** The package.json the served tarball carries: no dependencies at all. */
function trimmedManifest(source) {
	return {
		name: source.name,
		version: source.version,
		description: source.description,
		license: source.license,
		type: "module",
		bin: { fabric: "./fabric.js" },
		engines: { node: NODE_RANGE },
	};
}

function npmPack(stageDir) {
	// `.cmd` shims cannot be spawned without a shell on Windows; the arguments
	// are fixed strings, so there is nothing for the shell to interpret.
	const output = execFileSync(
		"npm",
		["pack", "--json", "--ignore-scripts", "--silent"],
		{
			cwd: stageDir,
			encoding: "utf8",
			shell: process.platform === "win32",
		},
	);
	const [packed] = JSON.parse(output);
	return path.join(stageDir, packed.filename);
}

async function packDeployment(outDir) {
	const source = readJson(path.join(packageDir, "package.json"));
	const { minSupported } = readJson(
		path.join(packageDir, "min-supported.json"),
	);
	for (const [label, value] of [
		["version", source.version],
		["minSupported", minSupported],
	]) {
		if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
			throw new Error(
				`${label} must be a plain x.y.z version, got ${value}`,
			);
		}
	}

	const { origin, skipped } = resolveDeploymentOrigin(process.env);
	if (origin === null) {
		if (process.env.FABRIC_CLI_REQUIRE_ORIGIN === "1") {
			throw new Error(
				`${noOriginMessage(skipped)}, and FABRIC_CLI_REQUIRE_ORIGIN=1 makes that fatal`,
			);
		}
		console.log(
			`pack:deployment: ${noOriginMessage(skipped)}; packing without one, so the Connect dialog's line carries --base-url`,
		);
	}

	process.env.FABRIC_CLI_BUNDLE = "1";
	process.env.FABRIC_CLI_BAKED_ORIGIN = origin ?? "";
	// The bundle is built into a folder of its own, not into the package, so two
	// packs at once (a build and a test, say) never share an output directory.
	// Run from the package, as `pnpm pack:deployment` does: the tsup config's
	// entry is relative to the working directory.
	const bundleDir = mkdtempSync(path.join(tmpdir(), "fabric-cli-bundle-"));
	const firstDir = mkdtempSync(path.join(tmpdir(), "fabric-cli-first-"));
	let tarball;
	let tarballName;
	try {
		// Built twice. `npx -y <url>` keeps running whatever it first fetched
		// from a URL, so a build whose content changed has to be at a new URL:
		// the tarball is named after the bundle's own bytes. The name is baked
		// into the bundle too (it prints the `npx` line that runs it), which is
		// why the content is learned from a first build that does not have it.
		process.env.FABRIC_CLI_BUNDLE_TARBALL = "";
		await build({
			config: path.join(packageDir, "tsup.config.ts"),
			outDir: firstDir,
			silent: true,
		});
		const buildId = createHash("sha256")
			.update(readFileSync(path.join(firstDir, "fabric.js")))
			.digest("hex")
			.slice(0, BUILD_ID_LENGTH);
		tarballName = `fabric-${source.version}-${buildId}.tgz`;
		process.env.FABRIC_CLI_BUNDLE_TARBALL = `/cli/${tarballName}`;
		await build({
			config: path.join(packageDir, "tsup.config.ts"),
			outDir: bundleDir,
			silent: true,
		});

		const stageDir = path.join(bundleDir, "stage");
		mkdirSync(stageDir, { recursive: true });
		copyFileSync(
			path.join(bundleDir, "fabric.js"),
			path.join(stageDir, "fabric.js"),
		);
		copyFileSync(
			path.join(packageDir, "LICENSE"),
			path.join(stageDir, "LICENSE"),
		);
		writeFileSync(
			path.join(stageDir, "package.json"),
			`${JSON.stringify(trimmedManifest(source), null, 2)}\n`,
		);

		const packed = npmPack(stageDir);

		mkdirSync(outDir, { recursive: true });
		for (const name of readdirSync(outDir)) {
			if (/^fabric-.*\.tgz$/.test(name)) {
				rmSync(path.join(outDir, name));
			}
		}
		tarball = path.join(outDir, tarballName);
		copyFileSync(packed, tarball);
	} finally {
		rmSync(bundleDir, { recursive: true, force: true });
		rmSync(firstDir, { recursive: true, force: true });
	}

	const manifest = {
		spec: SPEC,
		version: source.version,
		minSupported,
		nodeRange: NODE_RANGE,
		origin,
		tarball: `/cli/${tarballName}`,
		integrity: sriSha512(tarball),
	};
	writeFileSync(
		path.join(outDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	return manifest;
}

// Importable for `resolveDeploymentOrigin`; only a run from the command line
// packs.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	const outDir = parseOutDirectory(process.argv.slice(2));
	try {
		const manifest = await packDeployment(outDir);
		console.log(
			`Packed @fabricorg/cli ${manifest.version} ${manifest.origin ? `for ${manifest.origin}` : "with no baked origin"} into ${outDir}`,
		);
	} catch (error) {
		console.error(
			`pack:deployment: ${error instanceof Error ? error.message : error}`,
		);
		process.exitCode = 1;
	}
}
