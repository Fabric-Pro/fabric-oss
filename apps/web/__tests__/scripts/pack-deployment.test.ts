// @vitest-environment node
/**
 * The CLI a deployment serves has to run from nothing.
 *
 * `npx -y <origin>/cli/fabric-<v>.tgz` unpacks the tarball into an empty cache
 * folder and runs its `bin`. If the pack step left a dependency external, the
 * first command a person types fails with a module error from a path they have
 * never seen. This runs the real pack script, unpacks what it made somewhere
 * with no `node_modules` above it, and runs the binary.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCliManifest } from "../../modules/saas/cli-distribution/lib/cli-discovery";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CLI_DIR = path.join(REPO_ROOT, "packages/cli");
const SCRIPT = path.join(CLI_DIR, "scripts/pack-deployment.mjs");

/** The address the tarball under test is built to sign in at. */
const BAKED_ORIGIN = "https://fabric.example.com";

/** Where a build could learn its own address, none of which a test inherits. */
const ORIGIN_VARIABLES = [
	"FABRIC_CLI_ORIGIN",
	"NEXT_PUBLIC_SITE_URL",
	"APP_URL",
	"VERCEL_PROJECT_PRODUCTION_URL",
	"NEXT_PUBLIC_VERCEL_URL",
	"VERCEL_URL",
	"FABRIC_CLI_BAKED_ORIGIN",
];

function environmentWith(origin: Record<string, string>): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of ORIGIN_VARIABLES) {
		delete env[name];
	}
	return { ...env, ...origin };
}

function readJson<T>(file: string): T {
	return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** The file name the manifest says the tarball has, which is the only place to learn it. */
function servedTarball(folder: string): string {
	const manifest = parseCliManifest(
		readJson(path.join(folder, "manifest.json")),
	);
	if (manifest === null) {
		throw new Error("the pack step wrote no manifest the route accepts");
	}
	return path.basename(manifest.tarball);
}

/** Pack into a folder of the test's own, with the given address baked in. */
function packInto(folder: string, origin: string): void {
	execFileSync(process.execPath, [SCRIPT, "--out", folder], {
		cwd: CLI_DIR,
		stdio: "pipe",
		env: environmentWith({ FABRIC_CLI_ORIGIN: origin }),
	});
}

/** Whether the CLI's own source reads the global the pack step defines. */
function sourceReadsBakedOrigin(): boolean {
	const sourceDir = path.join(CLI_DIR, "src");
	return readdirSync(sourceDir, {
		recursive: true,
		withFileTypes: true,
	}).some(
		(entry) =>
			entry.isFile() &&
			/\.tsx?$/.test(entry.name) &&
			readFileSync(
				path.join(entry.parentPath, entry.name),
				"utf8",
			).includes("__FABRIC_BAKED_ORIGIN__"),
	);
}

describe("pack-deployment", () => {
	let work: string;
	let outDir: string;
	let unpackedDir: string;

	const cliPackage = readJson<{ version: string }>(
		path.join(CLI_DIR, "package.json"),
	);

	beforeAll(() => {
		work = mkdtempSync(path.join(tmpdir(), "fabric-pack-deployment-"));
		outDir = path.join(work, "out");
		execFileSync(process.execPath, [SCRIPT, "--out", outDir], {
			cwd: CLI_DIR,
			stdio: "pipe",
			env: environmentWith({ FABRIC_CLI_ORIGIN: BAKED_ORIGIN }),
		});

		// Unpacked outside the repository, so nothing above it can supply a
		// dependency the tarball forgot to carry. Relative paths keep a Windows
		// drive letter out of tar's argument list.
		unpackedDir = path.join(work, "unpacked");
		mkdirSync(unpackedDir);
		copyFileSync(
			path.join(outDir, servedTarball(outDir)),
			path.join(unpackedDir, "cli.tgz"),
		);
		execFileSync("tar", ["-xzf", "cli.tgz"], { cwd: unpackedDir });
	}, 120_000);

	afterAll(() => {
		rmSync(work, { recursive: true, force: true });
	});

	it("writes a manifest the discovery route accepts, for this CLI version", () => {
		const manifest = parseCliManifest(
			readJson(path.join(outDir, "manifest.json")),
		);

		expect(manifest).not.toBeNull();
		expect(manifest?.version).toBe(cliPackage.version);
		expect(manifest?.tarball).toMatch(
			new RegExp(
				`^/cli/fabric-${cliPackage.version}-[0-9a-f]{10}\\.tgz$`,
			),
		);
		expect(manifest?.nodeRange).toBe(">=22");
		expect(manifest?.minSupported).toBe(
			readJson<{ minSupported: string }>(
				path.join(CLI_DIR, "min-supported.json"),
			).minSupported,
		);
	});

	it("records the origin the tarball was built for", () => {
		const manifest = parseCliManifest(
			readJson(path.join(outDir, "manifest.json")),
		);

		expect(manifest?.origin).toBe(BAKED_ORIGIN);
	});

	it("records the sha512 of the exact tarball it wrote", () => {
		const manifest = parseCliManifest(
			readJson(path.join(outDir, "manifest.json")),
		);
		const digest = createHash("sha512")
			.update(readFileSync(path.join(outDir, servedTarball(outDir))))
			.digest("base64");

		expect(manifest?.integrity).toBe(`sha512-${digest}`);
	});

	it("leaves exactly one tarball and the manifest in the folder it serves from", () => {
		expect(readdirSync(outDir).sort()).toEqual(
			[servedTarball(outDir), "manifest.json"].sort(),
		);
	});

	// `npx -y <url>` keeps running whatever it first fetched from a URL, and the
	// version only changes on a release, so a build whose bytes changed has to
	// be at a URL npx has not seen.
	it("names the tarball after the bundle, so the same build is at the same URL and another build is at another", () => {
		const again = path.join(work, "again");
		const elsewhere = path.join(work, "elsewhere");

		packInto(again, BAKED_ORIGIN);
		packInto(elsewhere, "https://other.example.com");

		expect(servedTarball(again)).toBe(servedTarball(outDir));
		expect(
			readFileSync(path.join(again, servedTarball(again))).equals(
				readFileSync(path.join(outDir, servedTarball(outDir))),
			),
		).toBe(true);
		expect(servedTarball(elsewhere)).not.toBe(servedTarball(outDir));
	}, 240_000);

	it("has its own tarball path in the served bundle, which is how it prints the npx line that runs it", () => {
		const served = readFileSync(
			path.join(unpackedDir, "package/fabric.js"),
			"utf8",
		);

		expect(served).toContain(`/cli/${servedTarball(outDir)}`);
	});

	it("names no dependencies, so npx has nothing to install", () => {
		const packed = readJson<{
			name: string;
			version: string;
			type: string;
			bin: Record<string, string>;
			engines: { node: string };
			dependencies?: unknown;
			devDependencies?: unknown;
			scripts?: unknown;
		}>(path.join(unpackedDir, "package/package.json"));

		expect(packed.name).toBe("@fabricorg/cli");
		expect(packed.version).toBe(cliPackage.version);
		expect(packed.type).toBe("module");
		expect(packed.engines.node).toBe(">=22");
		expect(packed.dependencies).toBeUndefined();
		expect(packed.devDependencies).toBeUndefined();
		expect(packed.scripts).toBeUndefined();
		expect(
			existsSync(path.join(unpackedDir, "package", packed.bin.fabric)),
		).toBe(true);
	});

	// The CLI only learns the address from `__FABRIC_BAKED_ORIGIN__` if its
	// source reads that global; the bundler drops an unreferenced define. So
	// this stays visibly skipped, not silently green, until the source reads it.
	it.skipIf(!sourceReadsBakedOrigin())(
		"has the origin in the served bundle and not in the one npm publishes",
		() => {
			const served = readFileSync(
				path.join(unpackedDir, "package/fabric.js"),
				"utf8",
			);
			expect(served).toContain(BAKED_ORIGIN);

			// The default build, into a folder of its own so `dist/` is left
			// alone. Run as the package runs it: from its own directory.
			const published = mkdtempSync(path.join(work, "npm-build-"));
			const tsupBin = readJson<{ bin: { tsup: string } }>(
				path.join(CLI_DIR, "node_modules/tsup/package.json"),
			).bin.tsup;
			execFileSync(
				process.execPath,
				[
					path.join(CLI_DIR, "node_modules/tsup", tsupBin),
					"--out-dir",
					published,
				],
				{ cwd: CLI_DIR, stdio: "pipe", env: environmentWith({}) },
			);

			expect(
				readFileSync(path.join(published, "fabric.js"), "utf8"),
			).not.toContain(BAKED_ORIGIN);
		},
		120_000,
	);

	it("runs from an empty node_modules", () => {
		const output = execFileSync(
			process.execPath,
			[path.join(unpackedDir, "package/fabric.js"), "--version"],
			{ cwd: unpackedDir, encoding: "utf8" },
		);

		expect(output.trim()).toBe(cliPackage.version);
		expect(existsSync(path.join(unpackedDir, "package/node_modules"))).toBe(
			false,
		);
	});
});
