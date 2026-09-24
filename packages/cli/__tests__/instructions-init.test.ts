/**
 * `fabric instructions init` end to end (Fizzy #2539; split by subject from
 * `commands.test.ts` under Fizzy #2698), with the SDK client mocked at the
 * `getClient` boundary.
 *
 * Also covers a source of truth that changed after the hook was installed
 * (review round 3, finding 4): `init` refuses to install a hook for a
 * repository-backed project, and this is the case a hook it installed
 * earlier — before the project switched — has to keep refusing too.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSnapshotDigest } from "../src/lib/instructions/manifest.js";
import {
	makeTree,
	manifestEntry,
	resetInstructionsMocks,
	runCli,
	seedLock,
	snapshotFor,
	stubBundle,
} from "./helpers/instructions-commands.js";

// `vi.mock` is hoisted above every import in this file, so the mock object
// literal and the two factory bodies stay inline and per-file; only the
// fixtures they don't touch (`runCli`, `makeTree`, …) live in the helper.
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

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
describe("fabric instructions init", () => {
	it("refuses an unsupported tool", async () => {
		const dest = await makeTree();

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"cursor",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--tool claude-code or --tool codex");
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("writes a Codex project hook without putting the credential in the checkout", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"codex",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		const hooks = JSON.parse(
			await readFile(path.join(dest, ".codex", "hooks.json"), "utf8"),
		);
		expect(hooks.hooks.SessionStart[0].hooks[0]).toEqual({
			type: "command",
			command: "fabric instructions check --project project-1 --hook",
			timeout: 15,
		});
		expect(JSON.stringify(hooks)).not.toContain("fab_test");
		expect(result.stdout).toContain(
			"Start Codex in this checkout, then use `/hooks` to review and trust the project hook.",
		);
	});

	it("refuses a repository-backed project and writes nothing", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "REPOSITORY",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("come from its repository");
		await expect(
			stat(path.join(dest, ".claude", "settings.local.json")),
		).rejects.toThrow();
	});

	it("refuses when the CLI config would put the key inside the checkout", async () => {
		const dest = await makeTree();
		mocks.getConfigPath.mockReturnValue(
			path.join(dest, ".config", "fabricai", "config.json"),
		);
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("live credential in the repository");
		await expect(
			stat(path.join(dest, ".claude", "settings.local.json")),
		).rejects.toThrow();
	});

	it("writes the hook, syncs, and says what it did", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([manifestEntry("AGENTS.md", "hello\n")]),
			manifest: [manifestEntry("AGENTS.md", "hello\n")],
		});
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: "d".repeat(64),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "AGENTS.md": "hello\n" });

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		const settings = JSON.parse(
			await readFile(
				path.join(dest, ".claude", "settings.local.json"),
				"utf8",
			),
		);
		expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
			"fabric instructions check --project project-1 --hook",
		);
		// The command a session runs must never carry the credential.
		expect(JSON.stringify(settings).includes("fab_test")).toBe(false);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"hello\n",
		);
		expect(result.stdout).toContain("1 added");
		expect(result.stdout).toContain("does not edit .gitignore");
		// Init makes more than one manifest client (its own eligibility read,
		// then the sync's), so this asserts the two shapes rather than the
		// sequence: manifest budget with the SDK's default retries, and the
		// download link on the bundle budget with retries off.
		const clientOptions = mocks.getClient.mock.calls.map(
			([options]) => options,
		);
		expect(clientOptions).toContainEqual({ timeoutMs: 15_000 });
		expect(clientOptions).toContainEqual({
			timeoutMs: 60_000,
			retry: { maxRetries: 0 },
		});
	});

	it("does not write a hook when the first published sync fails", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([manifestEntry("AGENTS.md", "hello\n")]),
			manifest: [manifestEntry("AGENTS.md", "hello\n")],
		});
		mocks.createDownloadUrl.mockRejectedValue(new Error("unavailable"));

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).not.toBe(0);
		await expect(
			stat(path.join(dest, ".claude", "settings.local.json")),
		).rejects.toThrow();
	});

	it("refuses a repository switch during the first sync before writing a hook", async () => {
		const dest = await makeTree();
		mocks.getPublished
			.mockResolvedValueOnce({
				published: true,
				sourceOfTruth: "UPLOAD",
				snapshot: snapshotFor([]),
				manifest: [],
			})
			.mockResolvedValueOnce({
				published: true,
				sourceOfTruth: "REPOSITORY",
				snapshot: snapshotFor([]),
				manifest: [],
			});

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("come from its repository");
		await expect(
			stat(path.join(dest, ".claude", "settings.local.json")),
		).rejects.toThrow();
	});

	it("writes a sync hook with --apply", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
			"--apply",
		]);

		expect(result.code).toBe(0);
		const settings = JSON.parse(
			await readFile(
				path.join(dest, ".claude", "settings.local.json"),
				"utf8",
			),
		);
		expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
			"fabric instructions sync --project project-1 --hook",
		);
		expect(result.stdout).toContain("nothing published yet");
	});

	it("writes both a SessionStart and a Stop hook with --lessons", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
			"--lessons",
		]);

		expect(result.code).toBe(0);
		const settings = JSON.parse(
			await readFile(
				path.join(dest, ".claude", "settings.local.json"),
				"utf8",
			),
		);
		expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
			"fabric instructions check --project project-1 --hook",
		);
		expect(settings.hooks.Stop[0].hooks[0]).toEqual({
			type: "command",
			command:
				"fabric instructions lesson-prompt --project project-1 --hook",
			timeout: 15,
		});
		expect(result.stdout).toContain("Added a Stop hook for lesson capture");
	});

	it("removes a previously installed Stop hook when --lessons is dropped, and keeps SessionStart", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
			"--lessons",
		]);

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		const settings = JSON.parse(
			await readFile(
				path.join(dest, ".claude", "settings.local.json"),
				"utf8",
			),
		);
		expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
			"fabric instructions check --project project-1 --hook",
		);
		expect(settings.hooks.Stop).toEqual([]);
		expect(result.stdout).toContain(
			"Removed the Stop hook for lesson capture",
		);
	});

	it("refuses --lessons for codex before any write", async () => {
		const dest = await makeTree();

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"codex",
			"--dest",
			dest,
			"--lessons",
		]);

		expect(result.code).toBe(2);
		expect(result.stderr).toContain(
			"--lessons is not yet supported for codex",
		);
		expect(mocks.getPublished).not.toHaveBeenCalled();
		await expect(
			stat(path.join(dest, ".codex", "hooks.json")),
		).rejects.toThrow();
	});

	it("carries lessonsHook in the JSON summary", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const withLessons = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
			"--lessons",
			"--format",
			"json",
		]);
		expect(JSON.parse(withLessons.stdout).lessonsHook).toBe(true);

		const withoutLessons = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
			"--format",
			"json",
		]);
		expect(JSON.parse(withoutLessons.stdout).lessonsHook).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// A project that moved to a git repository
// ---------------------------------------------------------------------------
/**
 * Review round 3, finding 4. `init` refuses to install a hook for a
 * repository-backed project, and the hook it installed earlier kept writing
 * after someone switched the project over — the second writer `init` exists
 * to prevent.
 */
describe("a source of truth that changed after the hook was installed", () => {
	function serveRepositoryBacked(): void {
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "REPOSITORY",
			snapshot: snapshotFor([manifestEntry("AGENTS.md", "published\n")]),
			unchanged: false,
			changes: null,
			manifest: [manifestEntry("AGENTS.md", "published\n")],
		});
	}

	it("stops a hook sync with one line and exit 0, writing nothing", async () => {
		const dest = await makeTree();
		serveRepositoryBacked();

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("come from a git repository");
		expect(result.stderr).toContain("fabric instructions init");
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(await readdir(dest)).toEqual([]);
	});

	/**
	 * Delta review, finding 2. The refusal used to look at the FIRST response
	 * only. An unchanged answer over a drifted tree triggers a second call,
	 * and a project switched to a repository between the two was planned,
	 * downloaded and applied by a hook.
	 */
	it("stops when the project switches to a repository during the drift refetch", async () => {
		const published = manifestEntry("AGENTS.md", "published\n");
		const manifest = [published];
		const dest = await makeTree();
		// Missing rather than edited: since spec §6.4 an edit alone is kept
		// without a second request, and this case is about the second request.
		await seedLock(dest, computeSnapshotDigest(manifest), {
			"AGENTS.md": { sha256: published.sha256, mode: 0o100644 },
		});

		mocks.getPublished
			.mockResolvedValueOnce({
				published: true,
				sourceOfTruth: "UPLOAD",
				snapshot: snapshotFor(manifest),
				unchanged: true,
				changes: { added: [], removed: [], changed: [] },
			})
			.mockResolvedValueOnce({
				published: true,
				sourceOfTruth: "REPOSITORY",
				snapshot: snapshotFor(manifest),
				unchanged: false,
				changes: null,
				manifest,
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
		expect(result.stderr).toContain("come from a git repository");
		expect(mocks.getPublished).toHaveBeenCalledTimes(2);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		// Nothing was put back: the refusal came before the plan.
		expect(await readdir(dest)).toEqual([".fabric"]);
	});

	/**
	 * A person running `sync` by hand is a different case: for someone without
	 * access to that repository, a download is the only way to read the
	 * instructions at all.
	 */
	it("still lets a person sync by hand", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		serveRepositoryBacked();
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest(manifest),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "AGENTS.md": "published\n" });

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
	});
});
