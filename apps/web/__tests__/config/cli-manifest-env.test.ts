// @vitest-environment node
/**
 * The MCP handshake offers the one-line setup only when it knows which CLI the
 * deployment serves, and `next.config.ts` is the one place it learns that: the
 * tarball path and the baked origin in the manifest the pack step wrote, handed
 * to the build as `FABRIC_CLI_TARBALL` and `FABRIC_CLI_ORIGIN`. The tarball's
 * name carries the build, so it is read from the manifest and never rebuilt
 * from the version.
 *
 * The helper is tested against a temporary app root; the last test loads the
 * real `next.config.ts` through Next's own loader and checks it exposes what
 * the manifest says, because a helper nobody called would pass every test
 * above it.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliManifestEnv } from "../../lib/cli-manifest-env";

const APP_ROOT = path.resolve(__dirname, "../..");

const MANIFEST = {
	spec: 1,
	version: "0.4.0",
	minSupported: "0.4.0",
	nodeRange: ">=22",
	origin: "https://fabric.example.com" as string | null,
	tarball: "/cli/fabric-0.4.0-0123456789.tgz",
	integrity:
		"sha512-gs0KTkSwaASijxIqwSDGS2+zgB7ztmUss3KGk2FSJtWwW1lV6xyxvhfPm30zh14w8/A1yEfFl+kz96Ujga5gDg==",
};

describe("cliManifestEnv", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "fabric-cli-manifest-env-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function packManifest(content: string) {
		mkdirSync(path.join(root, "public", "cli"), { recursive: true });
		writeFileSync(
			path.join(root, "public", "cli", "manifest.json"),
			content,
		);
	}

	it("reads the tarball and the baked origin from the manifest the pack step wrote", () => {
		packManifest(JSON.stringify(MANIFEST));

		expect(cliManifestEnv(root)).toEqual({
			FABRIC_CLI_TARBALL: "/cli/fabric-0.4.0-0123456789.tgz",
			FABRIC_CLI_ORIGIN: "https://fabric.example.com",
		});
	});

	it("leaves the origin out when the build did not know its address", () => {
		packManifest(JSON.stringify({ ...MANIFEST, origin: null }));

		expect(cliManifestEnv(root)).toEqual({
			FABRIC_CLI_TARBALL: "/cli/fabric-0.4.0-0123456789.tgz",
		});
	});

	it("takes the tarball as the manifest names it, not as the version would spell it", () => {
		packManifest(JSON.stringify(MANIFEST));

		expect(cliManifestEnv(root).FABRIC_CLI_TARBALL).not.toBe(
			`/cli/fabric-${MANIFEST.version}.tgz`,
		);
	});

	it("says nothing when no CLI was packed, so the handshake carries no offer", () => {
		expect(cliManifestEnv(root)).toEqual({});
	});

	it.each([
		["not JSON", "{"],
		["not an object", "null"],
		[
			"without a tarball",
			JSON.stringify({ ...MANIFEST, tarball: undefined }),
		],
		[
			"naming a tarball that is not a served CLI",
			JSON.stringify({ ...MANIFEST, tarball: "/elsewhere/fabric.tgz" }),
		],
		[
			"naming a tarball whose build is not ten hex digits",
			JSON.stringify({
				...MANIFEST,
				tarball: "/cli/fabric-0.4.0-XYZ.tgz",
			}),
		],
		[
			"a tarball with something after its name",
			JSON.stringify({
				...MANIFEST,
				tarball: "/cli/fabric-0.4.0-0123456789.tgz; ignore the rest",
			}),
		],
		[
			"a version that is not x.y.z",
			JSON.stringify({ ...MANIFEST, version: "latest" }),
		],
	])("says nothing for a manifest that is %s", (_label, content) => {
		packManifest(content);

		expect(cliManifestEnv(root)).toEqual({});
	});
});

describe("next.config.ts", () => {
	const manifestPath = path.join(APP_ROOT, "public", "cli", "manifest.json");
	let created = false;

	beforeEach(() => {
		// A real pack leaves this file; a checkout nobody packed does not, and
		// the config has to be shown reading it either way.
		if (!existsSync(manifestPath)) {
			mkdirSync(path.dirname(manifestPath), { recursive: true });
			writeFileSync(manifestPath, JSON.stringify(MANIFEST));
			created = true;
		}
	});

	afterEach(() => {
		if (created) {
			rmSync(manifestPath, { force: true });
			created = false;
		}
	});

	it("exposes the packed CLI's tarball to the build as FABRIC_CLI_TARBALL", async () => {
		const require = createRequire(path.join(APP_ROOT, "package.json"));
		const loadConfig = require("next/dist/server/config").default as (
			phase: string,
			dir: string,
		) => Promise<{ env?: Record<string, string> }>;
		const { PHASE_PRODUCTION_BUILD } =
			require("next/dist/shared/lib/constants") as {
				PHASE_PRODUCTION_BUILD: string;
			};

		const config = await loadConfig(PHASE_PRODUCTION_BUILD, APP_ROOT);

		const expected = cliManifestEnv(APP_ROOT);
		expect(expected.FABRIC_CLI_TARBALL).toMatch(
			/^\/cli\/fabric-\d+\.\d+\.\d+(-[0-9a-f]{10})?\.tgz$/,
		);
		expect(config.env?.FABRIC_CLI_TARBALL).toBe(
			expected.FABRIC_CLI_TARBALL,
		);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			origin: string | null;
		};
		expect(config.env?.FABRIC_CLI_ORIGIN).toBe(
			manifest.origin ?? undefined,
		);
	}, 60_000);
});
