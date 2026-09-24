/**
 * `fabric instructions check` end to end (Fizzy #2539; split by subject from
 * `commands.test.ts` under Fizzy #2698), with the SDK client mocked at the
 * `getClient` boundary.
 *
 * Also covers the `--hook` never-fails contract and which organization a
 * request carries — exercised here through `check`, plus one `sync --hook`
 * case that shares the contract. The case
 * that matters most is the smallest one: under `--hook`, EVERY failure — no
 * key, no network, an HTTP error, a timeout — becomes one line on stderr and
 * exit 0. A coding session that will not start because Fabric is unreachable
 * is a worse outcome than instructions one version stale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	makeTree,
	resetInstructionsMocks,
	runCli,
	seedLock,
	seedRawLock,
	snapshotFor,
} from "./helpers/instructions-commands.js";

// `vi.mock` is hoisted above every import in this file (not just local
// `const`s: a dynamic `import()` inside the factory does not help either,
// since the helper module transitively imports the very modules being
// mocked here, which deadlocks). So the mock object literal and the two
// factory bodies stay inline and per-file; only the fixtures they don't
// touch (`runCli`, `makeTree`, …) live in the helper.
const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: mocks.createDownloadUrl,
		},
		// The real `FabricClient.withoutContext()` returns a sibling with no
		// ambient org/personal default. Here it returns the same stub and
		// records that it was asked for.
		withoutContext: () => {
			mocks.withoutContext();
			return client;
		},
	};
	return {
		getClient: (overrides: unknown) => {
			mocks.getClient(overrides);
			return client;
		},
	};
});

beforeEach(() => {
	resetInstructionsMocks(mocks);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fabric instructions check", () => {
	it("reports an unsynced tree and how to fix it", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: {
				id: "snap-2",
				version: 7,
				digest: "d".repeat(64),
				fileCount: 2,
				publishedAt: null,
			},
			manifest: [],
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("have not been synced");
		expect(result.stdout).toContain(
			"fabric instructions sync --project project-1",
		);
		expect(mocks.getPublished).toHaveBeenCalledWith("project-1", {
			org: undefined,
			sinceDigest: undefined,
		});
	});

	it("says nothing moved when the digest matches", async () => {
		const dest = await makeTree();
		await seedLock(dest, "d".repeat(64), {});
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: {
				id: "snap-2",
				version: 7,
				digest: "d".repeat(64),
				fileCount: 2,
				publishedAt: null,
			},
			unchanged: true,
			changes: { added: [], removed: [], changed: [] },
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		// "the published version has not moved", NOT "your files are correct":
		// without `--verify` nothing local has been read at all (round 3,
		// finding 1).
		expect(result.stdout).toBe(
			"Published coding instructions unchanged (version 7).\n",
		);
		expect(mocks.getPublished).toHaveBeenCalledWith("project-1", {
			org: undefined,
			sinceDigest: "d".repeat(64),
		});
	});

	it("lists what changed and how to apply it", async () => {
		const dest = await makeTree();
		await seedLock(dest, "c".repeat(64), {});
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: {
				id: "snap-2",
				version: 8,
				digest: "d".repeat(64),
				fileCount: 3,
				publishedAt: null,
			},
			unchanged: false,
			changes: {
				added: ["new.md"],
				removed: ["old.md"],
				changed: ["AGENTS.md"],
			},
			manifest: [],
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			"Coding instructions updated: 1 added, 1 changed, 1 removed (version 8).",
		);
		expect(result.stdout).toContain("    new.md");
		expect(result.stdout).toContain("    old.md");
	});

	it("says a full sync is needed when the server does not know the local base", async () => {
		const dest = await makeTree();
		await seedLock(dest, "c".repeat(64), {});
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: {
				id: "snap-2",
				version: 8,
				digest: "d".repeat(64),
				fileCount: 3,
				publishedAt: null,
			},
			unchanged: false,
			changes: null,
			manifest: [],
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("not one the server still recognises");
	});

	it("maps a not-found project to exit code 4 outside hook mode", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockRejectedValue(
			Object.assign(new Error("Project not found"), { status: 404 }),
		);

		const result = await runCli([
			"check",
			"--project",
			"missing",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(4);
		expect(result.stderr).toContain("✗ Project not found");
	});
});

// ---------------------------------------------------------------------------
// The --hook contract
// ---------------------------------------------------------------------------
describe("--hook never fails", () => {
	it("swallows a network failure into one line and exits 0", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockRejectedValue(
			new Error("fetch failed: ECONNREFUSED"),
		);

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe(
			"fabric: coding instructions check skipped: fetch failed: ECONNREFUSED\n",
		);
		expect(result.stdout).toBe("");
	});

	it("swallows a missing API key instead of exiting 3", async () => {
		const dest = await makeTree();
		mocks.getApiKey.mockReturnValue(undefined);

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toContain(
			"fabric: coding instructions check skipped: Not authenticated",
		);
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("swallows a damaged lock file", async () => {
		const dest = await makeTree();
		await seedRawLock(dest, "{ not json");

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toMatch(
			/^fabric: coding instructions check skipped: .*not valid JSON.*\n$/,
		);
	});

	it("swallows an unpublished project on sync", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe(
			"fabric: coding instructions sync skipped: This project has no published coding instructions yet.\n",
		);
	});

	/**
	 * These commands are project-authoritative: the project decides which
	 * organization it is in, so a stored default context is not consulted at
	 * all (round 3, finding 3). A legacy personal default used to reach
	 * `resolveContext`, which calls `process.exit(2)` — uncatchable by the
	 * boundary that owns the never-fail contract — and now it is simply not
	 * read.
	 */
	it("ignores a retired personal default rather than failing on it", async () => {
		const dest = await makeTree();
		mocks.getDefaultContext.mockReturnValue({ type: "personal" });
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(mocks.getDefaultContext).not.toHaveBeenCalled();
	});

	/**
	 * The SDK's timeout is per attempt and it retries twice, so "5 seconds"
	 * was really about 15.75 — past the point where Claude Code kills the
	 * hook itself, possibly mid-write. Hook mode now has one absolute
	 * deadline covering every request it makes.
	 */
	it("gives up on a hanging request within the deadline and exits 0", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockImplementation(
			() => new Promise(() => {}) as Promise<never>,
		);

		const started = Date.now();
		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);
		const elapsed = Date.now() - started;

		expect(result.code).toBe(0);
		expect(result.stderr).toMatch(/gave up after \d+ms/);
		// Comfortably inside Claude Code's own 15s hook timeout.
		expect(elapsed).toBeLessThan(13_000);
	}, 20_000);

	it("reports the same failure with a real exit code without --hook", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------
/**
 * Review round 3, finding 3. `?org=` from a stored default made the API's
 * invited-guest resolution unreachable: a guest's own default organization is
 * never the one hosting the project they were invited to, so the route
 * compared the two and refused.
 */
describe("the organization a request carries", () => {
	it("sends none when --org was not given, whatever the stored default says", async () => {
		const dest = await makeTree();
		mocks.getDefaultContext.mockReturnValue({
			type: "org",
			slug: "my-own-org",
		});
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(mocks.getPublished).toHaveBeenCalledWith("project-1", {
			org: undefined,
			sinceDigest: undefined,
		});
		// And the ambient SDK default is dropped as well, so `FABRIC_ORG`
		// cannot be injected into the URL either.
		expect(mocks.withoutContext).toHaveBeenCalled();
	});

	it("sends the slug when --org was given explicitly", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--org",
			"example-org",
		]);

		expect(mocks.getPublished).toHaveBeenCalledWith("project-1", {
			org: "example-org",
			sinceDigest: undefined,
		});
	});
});
