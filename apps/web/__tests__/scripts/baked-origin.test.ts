// @vitest-environment node
/**
 * A build that knows the address it is served at bakes it into the CLI it
 * serves, so that CLI signs in there without `--base-url`. Many builds cannot
 * know it, so baking is optional and `--base-url` always wins over it.
 *
 * Four things have to hold, and each is asserted where it can break:
 *
 *   - the address is worked out from what the web build already has, in a
 *     stated order, never from what Vercel supplies, and a build that knows
 *     none says so instead of failing;
 *   - the pack goes on without one (`origin: null`, exit 0) unless the
 *     operator asks it to refuse with `FABRIC_CLI_REQUIRE_ORIGIN=1`;
 *   - the bundler is told the address only for a served bundle that has one,
 *     and `undefined` otherwise, so the identifier always exists;
 *   - a bundler given that definition really writes the address into the
 *     output of a source that reads the identifier.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDeploymentOrigin } from "../../../../packages/cli/scripts/pack-deployment.mjs";
import { bakedOriginDefine } from "../../../../packages/cli/tsup.config";
import { parseCliManifest } from "../../modules/saas/cli-distribution/lib/cli-discovery";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CLI_DIR = path.join(REPO_ROOT, "packages/cli");
const SCRIPT = path.join(CLI_DIR, "scripts/pack-deployment.mjs");
const CONFIG = path.join(CLI_DIR, "tsup.config.ts");

/** Every variable a build could learn its own address from, none of which a test inherits. */
const ORIGIN_VARIABLES = [
	"FABRIC_CLI_ORIGIN",
	"FABRIC_CLI_REQUIRE_ORIGIN",
	"FABRIC_CLI_BAKED_ORIGIN",
	"NEXT_PUBLIC_SITE_URL",
	"APP_URL",
	"VERCEL_PROJECT_PRODUCTION_URL",
	"NEXT_PUBLIC_VERCEL_URL",
	"VERCEL_URL",
];

function packEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of ORIGIN_VARIABLES) {
		delete env[name];
	}
	return { ...env, ...extra };
}

describe("which address a build knows it is served from", () => {
	it("takes FABRIC_CLI_ORIGIN before anything the web build has", () => {
		expect(
			resolveDeploymentOrigin({
				FABRIC_CLI_ORIGIN: "https://explicit.example.com",
				NEXT_PUBLIC_SITE_URL: "https://site.example.com",
				APP_URL: "https://app.example.com",
			}),
		).toEqual({
			origin: "https://explicit.example.com",
			source: "FABRIC_CLI_ORIGIN",
			skipped: [],
		});
	});

	it("then NEXT_PUBLIC_SITE_URL, then APP_URL", () => {
		const both = {
			NEXT_PUBLIC_SITE_URL: "https://site.example.com",
			APP_URL: "https://app.example.com",
		};

		expect(resolveDeploymentOrigin(both).source).toBe(
			"NEXT_PUBLIC_SITE_URL",
		);
		expect(
			resolveDeploymentOrigin({ ...both, NEXT_PUBLIC_SITE_URL: "" })
				.source,
		).toBe("APP_URL");
	});

	it("writes the origin the way a URL does, with a port and without a trailing slash", () => {
		expect(
			resolveDeploymentOrigin({
				NEXT_PUBLIC_SITE_URL: "http://localhost:3001/",
			}).origin,
		).toBe("http://localhost:3001");
	});

	// Vercel supplies the address of the deployment being built, and the
	// production domain even on a staging or preview build; baking either would
	// sign people in to the wrong place. The build cannot know the address a
	// preview or staging deployment will be served at, so it says it does not.
	it("never reads what Vercel supplies, and takes localhost as no address either", () => {
		expect(
			resolveDeploymentOrigin({
				NEXT_PUBLIC_VERCEL_URL: "fabric-abc123.vercel.app",
				VERCEL_URL: "fabric-abc123.vercel.app",
				VERCEL_PROJECT_PRODUCTION_URL: "production.example.com",
			}),
		).toEqual({ origin: null, source: null, skipped: [] });
	});

	it("knows no origin when none is set, and does not throw", () => {
		expect(resolveDeploymentOrigin({})).toEqual({
			origin: null,
			source: null,
			skipped: [],
		});
	});

	it.each([
		["a path", "https://fabric.example.com/app"],
		["credentials", "https://user:pass@fabric.example.com"],
		["a query", "https://fabric.example.com/?a=1"],
		["a scheme that is not http", "ftp://fabric.example.com"],
		["no scheme", "fabric.example.com"],
	])(
		"passes over a variable that is not an origin, naming it, for %s",
		(_label, value) => {
			expect(
				resolveDeploymentOrigin({ NEXT_PUBLIC_SITE_URL: value }),
			).toEqual({
				origin: null,
				source: null,
				skipped: ["NEXT_PUBLIC_SITE_URL"],
			});
			expect(
				resolveDeploymentOrigin({
					NEXT_PUBLIC_SITE_URL: value,
					APP_URL: "https://app.example.com",
				}),
			).toMatchObject({
				origin: "https://app.example.com",
				skipped: ["NEXT_PUBLIC_SITE_URL"],
			});
		},
	);
});

describe("packing without an origin", () => {
	let out: string | undefined;

	afterEach(() => {
		if (out) {
			rmSync(out, { recursive: true, force: true });
			out = undefined;
		}
	});

	function pack(extra: Record<string, string>) {
		out = mkdtempSync(path.join(tmpdir(), "fabric-no-origin-"));
		const outDir = path.join(out, "cli");
		try {
			const stdout = execFileSync(
				process.execPath,
				[SCRIPT, "--out", outDir],
				{
					cwd: CLI_DIR,
					encoding: "utf8",
					stdio: "pipe",
					env: packEnvironment(extra),
				},
			);
			return { status: 0, stdout, stderr: "", outDir };
		} catch (error) {
			const thrown = error as {
				status: number | null;
				stdout: string;
				stderr: string;
			};
			return {
				status: thrown.status,
				stdout: String(thrown.stdout),
				stderr: String(thrown.stderr),
				outDir,
			};
		}
	}

	it("still packs, says once that no origin is baked in, writes `origin: null` and exits 0", () => {
		const result = pack({});

		expect(result.status).toBe(0);
		const said = result.stdout
			.split("\n")
			.filter((line) => line.includes("no deployment origin"));
		expect(said).toHaveLength(1);
		expect(said[0]).toContain("FABRIC_CLI_ORIGIN or NEXT_PUBLIC_SITE_URL");
		const manifest = JSON.parse(
			readFileSync(path.join(result.outDir, "manifest.json"), "utf8"),
		) as { origin: string | null; tarball: string };
		expect(manifest.origin).toBeNull();
		expect(parseCliManifest(manifest)).not.toBeNull();
		expect(
			existsSync(
				path.join(result.outDir, path.basename(manifest.tarball)),
			),
		).toBe(true);
	}, 120_000);

	it("makes a missing origin fatal, and writes nothing, only when FABRIC_CLI_REQUIRE_ORIGIN=1", () => {
		const result = pack({ FABRIC_CLI_REQUIRE_ORIGIN: "1" });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no deployment origin");
		expect(result.stderr).toContain("FABRIC_CLI_REQUIRE_ORIGIN=1");
		expect(existsSync(result.outDir)).toBe(false);
	}, 60_000);

	it("does not let FABRIC_CLI_REQUIRE_ORIGIN=1 fail a build that has an origin", () => {
		const result = pack({
			FABRIC_CLI_REQUIRE_ORIGIN: "1",
			NEXT_PUBLIC_SITE_URL: "https://fabric.example.com",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("for https://fabric.example.com");
		expect(
			(
				JSON.parse(
					readFileSync(
						path.join(result.outDir, "manifest.json"),
						"utf8",
					),
				) as { origin: string }
			).origin,
		).toBe("https://fabric.example.com");
	}, 120_000);

	it("reads FABRIC_CLI_REQUIRE_ORIGIN as exactly 1, so a stray value does not stop a build", () => {
		const result = pack({ FABRIC_CLI_REQUIRE_ORIGIN: "0" });

		expect(result.status).toBe(0);
	}, 120_000);
});

describe("what the bundler is told", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("defines the identifier as the origin, as a string literal", () => {
		expect(bakedOriginDefine("https://fabric.example.com")).toEqual({
			__FABRIC_BAKED_ORIGIN__: '"https://fabric.example.com"',
		});
	});

	it("defines the identifier as undefined when there is no origin, so it always exists", () => {
		expect(bakedOriginDefine(undefined)).toEqual({
			__FABRIC_BAKED_ORIGIN__: "undefined",
		});
	});

	it("bakes the origin into the served bundle only", async () => {
		vi.stubEnv("FABRIC_CLI_BUNDLE", "1");
		vi.stubEnv("FABRIC_CLI_BAKED_ORIGIN", "https://fabric.example.com");
		vi.resetModules();
		const served = (await import(CONFIG)).default as {
			define: Record<string, string>;
		};

		vi.stubEnv("FABRIC_CLI_BUNDLE", "");
		vi.stubEnv("FABRIC_CLI_BAKED_ORIGIN", "");
		vi.resetModules();
		const published = (await import(CONFIG)).default as {
			define: Record<string, string>;
		};

		expect(served.define).toEqual({
			__FABRIC_BAKED_ORIGIN__: '"https://fabric.example.com"',
			__FABRIC_BUNDLE__: "true",
			__FABRIC_BUNDLE_TARBALL__: "undefined",
		});
		expect(published.define).toEqual({
			__FABRIC_BAKED_ORIGIN__: "undefined",
			__FABRIC_BUNDLE__: "false",
			__FABRIC_BUNDLE_TARBALL__: "undefined",
		});
	});

	it("builds the served bundle without an origin, defining the identifier as undefined", async () => {
		vi.stubEnv("FABRIC_CLI_BUNDLE", "1");
		vi.stubEnv("FABRIC_CLI_BAKED_ORIGIN", "");
		vi.resetModules();

		const served = (await import(CONFIG)).default as {
			define: Record<string, string>;
		};

		expect(served.define).toEqual({
			__FABRIC_BAKED_ORIGIN__: "undefined",
			__FABRIC_BUNDLE__: "true",
			__FABRIC_BUNDLE_TARBALL__: "undefined",
		});
	});

	it("tells the served bundle where it is served from once the pack step has named the tarball", async () => {
		vi.stubEnv("FABRIC_CLI_BUNDLE", "1");
		vi.stubEnv("FABRIC_CLI_BAKED_ORIGIN", "");
		vi.stubEnv(
			"FABRIC_CLI_BUNDLE_TARBALL",
			"/cli/fabric-0.4.0-0123456789.tgz",
		);
		vi.resetModules();

		const served = (await import(CONFIG)).default as {
			define: Record<string, string>;
		};

		expect(served.define.__FABRIC_BUNDLE_TARBALL__).toBe(
			'"/cli/fabric-0.4.0-0123456789.tgz"',
		);
	});
});

describe("a bundler given that definition", () => {
	let work: string | undefined;

	afterEach(() => {
		if (work) {
			rmSync(work, { recursive: true, force: true });
			work = undefined;
		}
	});

	async function bundle(origin: string | undefined): Promise<string> {
		work = mkdtempSync(path.join(tmpdir(), "fabric-baked-origin-"));
		const entry = path.join(work, "entry.ts");
		writeFileSync(
			entry,
			'declare const __FABRIC_BAKED_ORIGIN__: string | undefined;\nconsole.log(typeof __FABRIC_BAKED_ORIGIN__ === "string" ? __FABRIC_BAKED_ORIGIN__ : "no origin");\n',
		);
		const { build } = createRequire(path.join(CLI_DIR, "package.json"))(
			"tsup",
		) as { build: (options: Record<string, unknown>) => Promise<void> };
		await build({
			config: false,
			// An object, not a list: a list is globbed, and a Windows path is
			// not a glob.
			entry: { entry },
			format: ["esm"],
			outDir: path.join(work, "out"),
			define: bakedOriginDefine(origin),
			silent: true,
		});
		// `.mjs` or `.js`, depending on whether a package.json says `module`.
		const built = readdirSync(path.join(work, "out")).find((name) =>
			/^entry\.m?js$/.test(name),
		);
		return execFileSync(
			process.execPath,
			[path.join(work, "out", built ?? "entry.js")],
			{ encoding: "utf8" },
		).trim();
	}

	it("writes the origin into a source that reads the identifier", async () => {
		expect(await bundle("https://fabric.example.com")).toBe(
			"https://fabric.example.com",
		);
	});

	it("leaves the same source reading undefined when there is no origin", async () => {
		expect(await bundle(undefined)).toBe("no origin");
	});
});
