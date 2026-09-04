/**
 * Temporal connection policy guard (Fizzy #2399).
 *
 * `packages/temporal/src/client.ts` is the one place that knows how to open a
 * Temporal connection: Temporal Cloud API key, mTLS, plain TLS, and the
 * production fail-closed refusal of a plaintext channel (SOC 2 CC6.7). A
 * caller that builds its own `Connection.connect({ address })` silently
 * bypasses all of that — it cannot reach Temporal Cloud at all, and against a
 * self-hosted server it opens exactly the plaintext path the guard forbids.
 * The browser extractor in `@repo/rag` did this for months without anyone
 * noticing because it was only ever imported lazily.
 *
 * This test walks the repo and fails when any file outside the allowlist
 * calls `Connection.connect(` / `NativeConnection.connect(`. Add a new call
 * site to the allowlist only if it genuinely cannot use `createConnection()`
 * or `getTemporalClient()`, and say why in the comment next to it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Top-level directories that hold source code. */
const SCAN_ROOTS = [
	"apps",
	"packages",
	"agents",
	"services",
	"party",
	"party-cf",
	"tooling",
	"scripts",
];

const PRUNED_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	".git",
	".content-collections",
	"generated",
]);

const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".mjs",
	".cjs",
]);

const CONNECT_CALL = /\b(?:Native)?Connection\s*\.\s*connect\s*\(/;

/**
 * Files allowed to open a Temporal connection themselves. Every entry must
 * still match — a stale entry fails the test so the list cannot rot.
 */
const ALLOWED_CALL_SITES: ReadonlyArray<{ file: string; reason: string }> = [
	{
		file: "packages/temporal/src/client.ts",
		reason: "The shared connection policy itself.",
	},
	{
		file: "packages/temporal/src/worker.ts",
		reason: "The worker needs a NativeConnection (a different SDK class). Its options block mirrors client.ts and it calls the shared assertInsecureConnectionAllowed() guard.",
	},
	{
		file: "packages/temporal/scripts/fetch-replay-histories.ts",
		reason: "Developer script that downloads workflow histories; carries its own TLS/API-key options.",
	},
	{
		file: "packages/temporal/scripts/payload-limit-repro.ts",
		reason: "Local-only reproduction script against a dev server.",
	},
	{
		file: "packages/temporal/__tests__/temporal-connection-policy.test.ts",
		reason: "This test mentions the pattern in its own source.",
	},
];

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (PRUNED_DIRS.has(entry.name)) {
				continue;
			}
			yield* walk(path.join(dir, entry.name));
		} else if (
			entry.isFile() &&
			SOURCE_EXTENSIONS.has(path.extname(entry.name))
		) {
			yield path.join(dir, entry.name);
		}
	}
}

function findConnectCallSites(): string[] {
	const hits: string[] = [];
	for (const root of SCAN_ROOTS) {
		const abs = path.join(REPO_ROOT, root);
		let isDir = false;
		try {
			isDir = statSync(abs).isDirectory();
		} catch {
			isDir = false;
		}
		if (!isDir) {
			continue;
		}
		for (const file of walk(abs)) {
			if (CONNECT_CALL.test(readFileSync(file, "utf8"))) {
				hits.push(
					path.relative(REPO_ROOT, file).split(path.sep).join("/"),
				);
			}
		}
	}
	return hits.sort();
}

describe("Temporal connection policy", () => {
	const callSites = findConnectCallSites();
	const allowed = new Set(ALLOWED_CALL_SITES.map((entry) => entry.file));

	it("every Connection.connect( call site outside the shared client is explicitly allowlisted", () => {
		const unexpected = callSites.filter((file) => !allowed.has(file));
		expect(
			unexpected,
			`Unexpected Temporal connection call site(s). Use createConnection() / getTemporalClient() from packages/temporal/src/client.ts so the connection carries the shared TLS, auth and production fail-closed policy:\n${unexpected.join("\n")}`,
		).toEqual([]);
	});

	it("every allowlisted call site still exists (the list does not rot)", () => {
		const found = new Set(callSites);
		const stale = ALLOWED_CALL_SITES.map((entry) => entry.file).filter(
			(file) => !found.has(file),
		);
		expect(stale).toEqual([]);
	});

	it("the shared client is among the call sites (the scan actually ran)", () => {
		expect(callSites).toContain("packages/temporal/src/client.ts");
	});
});
