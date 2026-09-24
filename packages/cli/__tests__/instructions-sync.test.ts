/**
 * `fabric instructions sync` end to end (Fizzy #2539; split by subject from
 * `commands.test.ts` under Fizzy #2698), with the SDK client mocked at the
 * `getClient` boundary.
 *
 * Also covers a lock that belongs to another project, an untrustworthy
 * manifest, and an unchanged digest over a drifted tree — all exercised
 * mainly through `sync` (the last two also check `check`'s share of the same
 * lock/manifest/digest handling).
 */
import {
	mkdir,
	mkdtemp,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLock } from "../src/lib/instructions/lock.js";
import { computeSnapshotDigest } from "../src/lib/instructions/manifest.js";
import {
	makeTree,
	manifestEntry,
	resetInstructionsMocks,
	runCli,
	seedLock,
	sha256,
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
// sync
// ---------------------------------------------------------------------------
describe("fabric instructions sync", () => {
	it("downloads, writes the tree and leaves a lock", async () => {
		const dest = await makeTree();
		const manifest = [
			manifestEntry("AGENTS.md", "hello\n"),
			manifestEntry(".claude/skills/review/SKILL.md", "skill\n"),
		];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest),
			manifest,
		});
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: "d".repeat(64),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({
			"AGENTS.md": "hello\n",
			".claude/skills/review/SKILL.md": "skill\n",
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"hello\n",
		);
		expect(
			await readFile(
				path.join(dest, ".claude/skills/review/SKILL.md"),
				"utf8",
			),
		).toBe("skill\n");
		const lock = JSON.parse(
			await readFile(
				path.join(dest, ".fabric", "instructions.lock"),
				"utf8",
			),
		);
		expect(lock.digest).toBe(computeSnapshotDigest(manifest));
		expect(Object.keys(lock.files).sort()).toEqual([
			".claude/skills/review/SKILL.md",
			"AGENTS.md",
		]);
		expect(result.stdout).toContain("2 added");
		// TWO clients, deliberately. The manifest read keeps the sync budget;
		// the download-link request gets the bundle budget and NO retries,
		// because a timed-out retry of that POST does not wait for the build
		// already running on the server, it starts another one.
		expect(mocks.getClient.mock.calls.map(([options]) => options)).toEqual([
			{ timeoutMs: 15_000 },
			{ timeoutMs: 60_000, retry: { maxRetries: 0 } },
		]);
	});

	it("writes nothing and downloads nothing on --dry-run", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([manifestEntry("AGENTS.md", "hello\n")]),
			manifest: [manifestEntry("AGENTS.md", "hello\n")],
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--dry-run",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Would apply");
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		await expect(stat(path.join(dest, "AGENTS.md"))).rejects.toThrow();
		await expect(
			stat(path.join(dest, ".fabric", "instructions.lock")),
		).rejects.toThrow();
	});

	it("does nothing at all when the digest matches", async () => {
		const dest = await makeTree();
		await seedLock(dest, "d".repeat(64), {});
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: {
				id: "snap-2",
				version: 7,
				digest: "d".repeat(64),
				fileCount: 1,
				publishedAt: null,
			},
			unchanged: true,
			changes: { added: [], removed: [], changed: [] },
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			"Coding instructions are up to date (version 7).\n",
		);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	/**
	 * Review round 2, finding 1, end to end: writes run before deletes, so a
	 * case-only rename used to write `readme.md` and then unlink the same
	 * physical file under its old name — leaving a lock that claimed a file
	 * the sync had just removed.
	 */
	it("survives a case-only rename with the file and a truthful lock", async () => {
		const dest = await makeTree();
		await writeFile(path.join(dest, "README.md"), "old\n");
		await seedLock(dest, "c".repeat(64), {
			"README.md": { sha256: sha256("old\n"), mode: 0o100644 },
		});
		const manifest = [manifestEntry("readme.md", "new\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest, 8),
			unchanged: false,
			changes: null,
			manifest,
		});
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest(manifest),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "readme.md": "new\n" });

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("removed:");
		expect(result.stdout).toContain(
			"kept, renamed in the published snapshot:",
		);
		expect(await readFile(path.join(dest, "readme.md"), "utf8")).toBe(
			"new\n",
		);
		const lock = await readLock(dest);
		expect(Object.keys(lock?.files ?? {})).toEqual(["readme.md"]);
	});

	it("replaces a local edit under --repair and reports it by name", async () => {
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "my own edit");
		await seedLock(dest, "c".repeat(64), {
			"AGENTS.md": { sha256: sha256("previous"), mode: 0o100644 },
		});
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(
				[manifestEntry("AGENTS.md", "published\n")],
				8,
			),
			unchanged: false,
			changes: null,
			manifest: [manifestEntry("AGENTS.md", "published\n")],
		});
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: "d".repeat(64),
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
			"--repair",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("replaced local edits:");
		expect(result.stdout).toContain("    AGENTS.md");
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
		const lock = await readLock(dest);
		expect(lock?.files["AGENTS.md"]).toEqual({
			sha256: sha256("published\n"),
			mode: 0o100644,
		});
	});

	/** Spec §6.4 (Fizzy #2540): the default keeps the edit and says how to replace it. */
	it("keeps a local edit by default and says where local notes belong", async () => {
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "my own edit");
		await seedLock(dest, "c".repeat(64), {
			"AGENTS.md": { sha256: sha256("previous"), mode: 0o100644 },
		});
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest, 8),
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
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"my own edit",
		);
		expect(result.stdout).toContain("kept local edits:");
		expect(result.stdout).toContain("    AGENTS.md");
		expect(result.stdout).not.toContain("replaced local edits:");
		expect(result.stdout).toContain(
			`fabric instructions sync --project project-1 --dest ${dest} --repair`,
		);
		expect(result.stdout).toContain("CLAUDE.local.md");
		expect(result.stdout).toContain(".claude/settings.local.json");
		// Nothing to write, so nothing to download.
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		const lock = await readLock(dest);
		expect(lock?.snapshotVersion).toBe(8);
		expect(lock?.files["AGENTS.md"]).toEqual({
			sha256: sha256("published\n"),
			mode: 0o100644,
			kept: true,
		});
	});

	/**
	 * Review Focus 4. The kept file stays, and the lock follows the NEW
	 * published version, so `push` diffs the edit against the version
	 * everyone else now has.
	 */
	it("keeps an edit across a republish and records the new published hash", async () => {
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "my note\n");
		await seedLock(dest, "c".repeat(64), {
			"AGENTS.md": {
				sha256: sha256("published v7\n"),
				mode: 0o100644,
				kept: true,
			},
		});
		const manifest = [
			manifestEntry("AGENTS.md", "published v8\n"),
			manifestEntry("rules/new.md", "new rule\n"),
		];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest, 8),
			unchanged: false,
			changes: null,
			manifest,
		});
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest(manifest),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "rules/new.md": "new rule\n" });

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"my note\n",
		);
		expect(await readFile(path.join(dest, "rules/new.md"), "utf8")).toBe(
			"new rule\n",
		);
		expect(result.stdout).toContain("1 added");
		expect(result.stdout).toContain("kept local edits:");
		const lock = await readLock(dest);
		expect(lock?.snapshotVersion).toBe(8);
		expect(lock?.files).toEqual({
			"AGENTS.md": {
				sha256: sha256("published v8\n"),
				mode: 0o100644,
				kept: true,
			},
			"rules/new.md": { sha256: sha256("new rule\n"), mode: 0o100644 },
		});
	});

	/**
	 * Decision 37. The plan saw AGENTS.md at the locked bytes and rules/new.md
	 * absent; an editor saved one and created the other while the bundle was
	 * downloading. Both are the developer's now.
	 */
	it("keeps a file saved or created after planning, and records both as kept", async () => {
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "published v7\n");
		await seedLock(dest, "c".repeat(64), {
			"AGENTS.md": { sha256: sha256("published v7\n"), mode: 0o100644 },
		});
		const manifest = [
			manifestEntry("AGENTS.md", "published v8\n"),
			manifestEntry("rules/new.md", "new rule\n"),
		];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest, 8),
			unchanged: false,
			changes: null,
			manifest,
		});
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest(manifest),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle(
			{ "AGENTS.md": "published v8\n", "rules/new.md": "new rule\n" },
			async () => {
				await writeFile(path.join(dest, "AGENTS.md"), "late save\n");
				await mkdir(path.join(dest, "rules"), { recursive: true });
				await writeFile(
					path.join(dest, "rules/new.md"),
					"late create\n",
				);
			},
		);

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"late save\n",
		);
		expect(await readFile(path.join(dest, "rules/new.md"), "utf8")).toBe(
			"late create\n",
		);
		// What happened, not what was planned.
		expect(result.stdout).toContain(
			"Applied coding instructions version 8: 0 added, 0 updated, 0 replaced, 0 removed (0 already current).",
		);
		expect(result.stdout).toContain("kept local edits:");
		expect(result.stdout).toContain("    AGENTS.md");
		expect(result.stdout).toContain("    rules/new.md");
		const lock = await readLock(dest);
		expect(lock?.version).toBe(2);
		expect(lock?.files).toEqual({
			"AGENTS.md": {
				sha256: sha256("published v8\n"),
				mode: 0o100644,
				kept: true,
			},
			"rules/new.md": {
				sha256: sha256("new rule\n"),
				mode: 0o100644,
				kept: true,
			},
		});
	});

	it("replaces a save that landed after planning under --repair", async () => {
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "published v7\n");
		await seedLock(dest, "c".repeat(64), {
			"AGENTS.md": { sha256: sha256("published v7\n"), mode: 0o100644 },
		});
		const manifest = [manifestEntry("AGENTS.md", "published v8\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest, 8),
			unchanged: false,
			changes: null,
			manifest,
		});
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest(manifest),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "AGENTS.md": "published v8\n" }, async () => {
			await writeFile(path.join(dest, "AGENTS.md"), "late save\n");
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--repair",
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published v8\n",
		);
		expect(result.stdout).toContain("1 updated");
		expect(result.stdout).not.toContain("kept local edits:");
		const lock = await readLock(dest);
		expect(lock?.files["AGENTS.md"]).toEqual({
			sha256: sha256("published v8\n"),
			mode: 0o100644,
		});
	});

	/**
	 * Review finding 2 (Minor, Fizzy #2540). Planning saw the file present and
	 * matching the lock, so its write is `updated`. If it is deleted before
	 * the write lands, re-hashing it now finds nothing — which is exactly
	 * what planning would have called `added`, not a conflicting edit — so
	 * the write proceeds instead of being reported kept.
	 */
	it("writes a file deleted after planning rather than reporting it kept", async () => {
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "published v7\n");
		await seedLock(dest, "c".repeat(64), {
			"AGENTS.md": { sha256: sha256("published v7\n"), mode: 0o100644 },
		});
		const manifest = [manifestEntry("AGENTS.md", "published v8\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest, 8),
			unchanged: false,
			changes: null,
			manifest,
		});
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest(manifest),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "AGENTS.md": "published v8\n" }, async () => {
			await unlink(path.join(dest, "AGENTS.md"));
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published v8\n",
		);
		expect(result.stdout).toContain("1 updated");
		expect(result.stdout).not.toContain("kept local edits:");
	});
});

// ---------------------------------------------------------------------------
// A lock belongs to one project
// ---------------------------------------------------------------------------
describe("a lock from another project", () => {
	/**
	 * `sync --project B` in a directory synced from project A used to send
	 * A's digest, receive B's manifest, and then use A's ledger to decide
	 * what to delete — classifying every A-only file as "the sync wrote this,
	 * remove it".
	 */
	it.each([["check"], ["sync"]])(
		"refuses %s before any network call",
		async (verb) => {
			const dest = await makeTree();
			await seedLock(dest, "d".repeat(64), {}, "project-A");

			const result = await runCli([
				verb,
				"--project",
				"project-B",
				"--dest",
				dest,
			]);

			expect(result.code).toBe(7);
			expect(result.stderr).toContain("belongs to project project-A");
			expect(result.stderr).toContain("project-B");
			expect(mocks.getPublished).not.toHaveBeenCalled();
		},
	);

	it("refuses init before the hook is written", async () => {
		const dest = await makeTree();
		await seedLock(dest, "d".repeat(64), {}, "project-A");

		const result = await runCli([
			"init",
			"--project",
			"project-B",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(mocks.getPublished).not.toHaveBeenCalled();
		await expect(
			stat(path.join(dest, ".claude", "settings.local.json")),
		).rejects.toThrow();
	});

	it("becomes one quiet line under --hook", async () => {
		const dest = await makeTree();
		await seedLock(dest, "d".repeat(64), {}, "project-A");

		const result = await runCli([
			"check",
			"--project",
			"project-B",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toMatch(
			/^fabric: coding instructions check skipped: .*belongs to project project-A.*\n$/,
		);
	});

	it("accepts a lock that names the same project", async () => {
		const dest = await makeTree();
		await seedLock(dest, "d".repeat(64), {}, "project-1");
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
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
	});
});

// ---------------------------------------------------------------------------
// A manifest is complete or it is a refusal
// ---------------------------------------------------------------------------
describe("an untrustworthy manifest", () => {
	it("refuses a published response with no manifest instead of deleting everything", async () => {
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "previous");
		await seedLock(dest, "c".repeat(64), {
			"AGENTS.md": { sha256: sha256("previous"), mode: 0o100644 },
		});
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: { ...snapshotFor([]), version: 8, fileCount: 3 },
			unchanged: false,
			changes: null,
			// No `manifest` key at all — a version-skewed or truncated response.
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("sent no file manifest");
		// The file the empty manifest would have deleted is still there.
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"previous",
		);
	});

	it("refuses a manifest whose length disagrees with fileCount", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "hello\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: { ...snapshotFor(manifest), fileCount: 2 },
			manifest,
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("the snapshot says 2");
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	it("refuses a manifest that does not hash to the snapshot digest", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "hello\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: { ...snapshotFor(manifest), digest: "d".repeat(64) },
			manifest,
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("does not match its own digest");
	});

	it("refuses a manifest naming a reserved path", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry(".git/config", "[core]\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest),
			manifest,
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("never writes or deletes");
	});

	it("leaves `check` working when the manifest is skewed, because it writes nothing", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: { ...snapshotFor([]), fileCount: 9 },
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Local drift, when the published snapshot has not moved
// ---------------------------------------------------------------------------
/**
 * Review round 3, finding 1. "Unchanged" is the server's answer about the
 * SNAPSHOT. Treating it as "nothing to do" meant an edited, deleted or
 * chmod-ed instruction file stayed that way until some later publication
 * happened to move the digest — so tampering persisted and the tool reported
 * success. `sync` now verifies the ledger before it accepts that answer.
 */
describe("an unchanged digest over a drifted tree", () => {
	/**
	 * The first call carries the lock's digest and is answered `unchanged`
	 * with no manifest; the repair asks again without one and gets the whole
	 * published list.
	 */
	function serveUnchangedThenFull(
		manifest: ReturnType<typeof manifestEntry>[],
	): void {
		mocks.getPublished.mockImplementation(
			async (_project: string, options: { sinceDigest?: string }) =>
				options.sinceDigest
					? {
							published: true,
							sourceOfTruth: "UPLOAD",
							snapshot: snapshotFor(manifest),
							unchanged: true,
							changes: { added: [], removed: [], changed: [] },
						}
					: {
							published: true,
							sourceOfTruth: "UPLOAD",
							snapshot: snapshotFor(manifest),
							unchanged: false,
							changes: null,
							manifest,
						},
		);
	}

	async function seedSyncedTree(
		manifest: ReturnType<typeof manifestEntry>[],
		files: Record<string, string>,
	): Promise<string> {
		const dest = await makeTree();
		for (const [relative, contents] of Object.entries(files)) {
			const target = path.join(dest, relative);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, contents);
		}
		await seedLock(
			dest,
			computeSnapshotDigest(manifest),
			Object.fromEntries(
				manifest.map((entry) => [
					entry.path,
					{ sha256: entry.sha256, mode: entry.mode },
				]),
			),
		);
		return dest;
	}

	/** Spec §6.4 (Fizzy #2540): an edit alone needs no second request, and the keep is recorded. */
	it("keeps a file that was edited locally, without a second request", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "someone edited this\n",
		});
		serveUnchangedThenFull(manifest);

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"someone edited this\n",
		);
		expect(result.stdout).toContain(
			"Coding instructions are up to date (version 7).",
		);
		expect(result.stdout).toContain("kept local edits:");
		expect(mocks.getPublished).toHaveBeenCalledTimes(1);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		// Recorded, so `check --verify` and doctor can say the edit was kept.
		const lock = await readLock(dest);
		expect(lock?.files["AGENTS.md"]).toEqual({
			sha256: manifest[0].sha256,
			mode: 0o100644,
			kept: true,
		});
	});

	it("rewrites a file that was edited locally under --repair, dropping the kept marker", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "someone edited this\n");
		await seedLock(dest, computeSnapshotDigest(manifest), {
			"AGENTS.md": {
				sha256: manifest[0].sha256,
				mode: 0o100644,
				kept: true,
			},
		});
		serveUnchangedThenFull(manifest);
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
			"--repair",
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
		expect(result.stdout).toContain("AGENTS.md (kept)");
		// The second call is the repair: same project, no base digest.
		expect(mocks.getPublished).toHaveBeenCalledTimes(2);
		expect(mocks.getPublished).toHaveBeenLastCalledWith("project-1", {
			org: undefined,
			sinceDigest: undefined,
		});
		const lock = await readLock(dest);
		expect(lock?.files["AGENTS.md"]).toEqual({
			sha256: manifest[0].sha256,
			mode: 0o100644,
		});
	});

	it("re-adds a file that was deleted locally", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {});
		serveUnchangedThenFull(manifest);
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
		expect(result.stdout).toContain("AGENTS.md (missing)");
	});

	it("puts back a mode that drifted, without downloading anything", async () => {
		const executable = {
			...manifestEntry("script.sh", "#!/bin/sh\n"),
			mode: 0o100755,
		};
		const manifest = [executable];
		const dest = await seedSyncedTree(manifest, {
			"script.sh": "#!/bin/sh\n",
		});
		const { chmod } = await import("node:fs/promises");
		await chmod(path.join(dest, "script.sh"), 0o644);
		serveUnchangedThenFull(manifest);

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			"script.sh (mode 644, published as 755)",
		);
		expect((await stat(path.join(dest, "script.sh"))).mode & 0o777).toBe(
			0o755,
		);
		// Bytes already matched, so there was nothing to fetch.
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	// Fizzy #2671: a republish that only flips a file's executable bit now
	// carries a different digest from the version the lock recorded, so
	// `sync` fetches the new manifest instead of short-circuiting on
	// "unchanged" — unlike the drift case above, where the SERVER's digest
	// never moved and only the local file had drifted.
	it("chmods a file whose published mode changed and records the new mode in the lock", async () => {
		const oldManifest = [manifestEntry("script.sh", "#!/bin/sh\n")];
		const dest = await seedSyncedTree(oldManifest, {
			"script.sh": "#!/bin/sh\n",
		});
		const newManifest = [
			{ ...manifestEntry("script.sh", "#!/bin/sh\n"), mode: 0o100755 },
		];
		// Sanity: the republish really does carry a different digest — a
		// mode-only version must not look unchanged to begin with.
		expect(computeSnapshotDigest(newManifest)).not.toBe(
			computeSnapshotDigest(oldManifest),
		);
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(newManifest),
			unchanged: false,
			changes: { added: [], removed: [], changed: ["script.sh"] },
			manifest: newManifest,
		});

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect((await stat(path.join(dest, "script.sh"))).mode & 0o777).toBe(
			0o755,
		);
		// Bytes already matched the new manifest, so nothing was downloaded.
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		const lock = await readLock(dest);
		expect(lock?.files["script.sh"]?.mode).toBe(0o100755);
		expect(lock?.digest).toBe(computeSnapshotDigest(newManifest));
	});

	it("still says unchanged when the tree really does match", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "published\n",
		});
		serveUnchangedThenFull(manifest);

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("up to date");
		expect(mocks.getPublished).toHaveBeenCalledTimes(1);
	});

	it("re-adds a deleted file under --hook too, still exiting 0", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {});
		serveUnchangedThenFull(manifest);
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
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
		// Hook mode's ONE absolute deadline still bounds the download-link
		// request — it does not get the 60-second bundle budget — and retries
		// stay off, as they are for every hook-mode call.
		expect(mocks.getClient.mock.calls.map(([options]) => options)).toEqual([
			{ timeoutMs: 10_000, retry: { maxRetries: 0 } },
			{ timeoutMs: 10_000, retry: { maxRetries: 0 } },
		]);
	});

	/** Spec §6.4 (Fizzy #2540): a session start keeps the edit and says so in one line. */
	it("keeps an edit under --hook and says so in one stderr line", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "edited\n",
		});
		serveUnchangedThenFull(manifest);

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"edited\n",
		);
		expect(result.stderr).toBe(
			`fabric: 1 local edit(s) kept; run \`fabric instructions sync --project project-1 --dest ${dest} --repair\` to replace them. Keep notes meant only for this machine in CLAUDE.local.md or .claude/settings.local.json.\n`,
		);
		expect(mocks.getPublished).toHaveBeenCalledTimes(1);
	});

	it("check without --verify reads nothing local and says so", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "edited\n",
		});
		serveUnchangedThenFull(manifest);

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			"Published coding instructions unchanged (version 7).\n",
		);
		expect(mocks.getPublished).toHaveBeenCalledTimes(1);
	});

	it("check --verify names the drifted paths and still exits 0", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "edited\n",
		});
		serveUnchangedThenFull(manifest);

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--verify",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("1 local file(s) no longer match");
		expect(result.stdout).toContain("AGENTS.md (edited)");
		// Still informational: it reports, it does not write.
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	it("check --verify labels a kept edit and names --repair", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "my note\n");
		await seedLock(dest, computeSnapshotDigest(manifest), {
			"AGENTS.md": {
				sha256: manifest[0].sha256,
				mode: 0o100644,
				kept: true,
			},
		});
		serveUnchangedThenFull(manifest);

		const text = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--verify",
		]);

		expect(text.code).toBe(0);
		expect(text.stdout).toContain("AGENTS.md (kept)");
		expect(text.stdout).toContain(
			`fabric instructions sync --project project-1 --dest ${dest} --repair`,
		);
		expect(text.stdout).not.toContain("to put");

		const json = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--verify",
			"--format",
			"json",
		]);

		const report = JSON.parse(json.stdout);
		expect(report.drifted).toEqual(["AGENTS.md (kept)"]);
		expect(report.keptEdited).toEqual(["AGENTS.md"]);
	});

	/**
	 * Delta review, finding 3. `--verify` computed the drift and then returned
	 * before printing it on the branches that do not take the unchanged path,
	 * so an edited file showed up in JSON and nowhere in the text output.
	 */
	it("check --verify reports drift when the server cannot list what changed", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "edited\n",
		});
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest, 9),
			unchanged: false,
			// The base digest is one the server no longer recognises.
			changes: null,
			manifest,
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--verify",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("A full sync is needed");
		expect(result.stdout).toContain("AGENTS.md (edited)");
	});

	it("check --verify reports drift when nothing is published at all", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "edited\n",
		});
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--verify",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("no published coding instructions");
		expect(result.stdout).toContain("AGENTS.md (edited)");
	});

	it("check --verify says so when everything matches", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "published\n",
		});
		serveUnchangedThenFull(manifest);

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--verify",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("matches the lock");
	});

	it("lists kept edits in sync's JSON output (Decision 37)", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "my note\n",
		});
		serveUnchangedThenFull(manifest);

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--format",
			"json",
		]);

		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.unchanged).toBe(true);
		expect(report.keptEdited).toEqual(["AGENTS.md"]);
	});

	it("records nothing on a dry run, even with an edit to keep (Decision 41)", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "my note\n",
		});
		serveUnchangedThenFull(manifest);
		const lockFile = path.join(dest, ".fabric", "instructions.lock");
		const before = await readFile(lockFile, "utf8");

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--dry-run",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("kept local edits:");
		expect(await readFile(lockFile, "utf8")).toBe(before);
	});

	it("keeps the same edit on the next run without rewriting the lock (Decision 41)", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "my note\n",
		});
		serveUnchangedThenFull(manifest);
		const lockFile = path.join(dest, ".fabric", "instructions.lock");
		const args = ["sync", "--project", "project-1", "--dest", dest];

		expect((await runCli(args)).code).toBe(0);
		const afterFirst = await readFile(lockFile, "utf8");
		expect(JSON.parse(afterFirst).files["AGENTS.md"].kept).toBe(true);

		const second = await runCli(args);

		expect(second.code).toBe(0);
		expect(second.stdout).toContain("kept local edits:");
		// Byte for byte: not even `syncedAt` moves when nothing changed.
		expect(await readFile(lockFile, "utf8")).toBe(afterFirst);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	it("keeps the lock's markers true through a hand restore, a new edit and --repair (Decision 41)", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "my note\n",
		});
		serveUnchangedThenFull(manifest);
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest(manifest),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "AGENTS.md": "published\n" });
		const sync = (...extra: string[]) =>
			runCli([
				"sync",
				"--project",
				"project-1",
				"--dest",
				dest,
				...extra,
			]);
		const marker = async () =>
			(await readLock(dest))?.files["AGENTS.md"]?.kept;

		// Kept.
		expect((await sync()).code).toBe(0);
		expect(await marker()).toBe(true);

		// The developer puts the published bytes back by hand: the marker goes.
		await writeFile(path.join(dest, "AGENTS.md"), "published\n");
		expect((await sync()).code).toBe(0);
		expect(await marker()).toBeUndefined();

		// A new edit is kept, and marked, again.
		await writeFile(path.join(dest, "AGENTS.md"), "another note\n");
		expect((await sync()).code).toBe(0);
		expect(await marker()).toBe(true);

		// --repair replaces it and drops the marker.
		expect((await sync("--repair")).code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
		expect(await marker()).toBeUndefined();
	});

	/**
	 * Decision 42. A newline in a path cannot be quoted into something a
	 * person can safely paste, so no command is printed at all; the report
	 * says what to run instead, in stdout and in the hook's stderr line.
	 */
	it("prints no repair command for a --dest with a newline, and says what to run instead", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await mkdtemp(
			path.join(tmpdir(), "fabric-cmd-new\nline-"),
		);
		await writeFile(path.join(dest, "AGENTS.md"), "edited\n");
		await seedLock(dest, computeSnapshotDigest(manifest), {
			"AGENTS.md": { sha256: manifest[0].sha256, mode: 0o100644 },
		});
		serveUnchangedThenFull(manifest);

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		const instead =
			"`fabric instructions sync --repair` with this run's --project and --dest";
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(instead);
		expect(result.stderr).toBe(
			`fabric: 1 local edit(s) kept; run ${instead} to replace them. Keep notes meant only for this machine in CLAUDE.local.md or .claude/settings.local.json.\n`,
		);
		expect(`${result.stdout}${result.stderr}`).not.toContain(
			"fabric-cmd-new",
		);
	});
});
