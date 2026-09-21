/**
 * `fabric instructions check | sync | init` end to end (Fizzy #2539), with
 * the SDK client mocked at the `getClient` boundary.
 *
 * The case that matters most is the smallest one: under `--hook`, EVERY
 * failure — no key, no network, an HTTP error, a timeout — becomes one line
 * on stderr and exit 0. A coding session that will not start because Fabric
 * is unreachable is a worse outcome than instructions one version stale.
 */
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// A static import is safe despite the mocks below: Vitest hoists every
// `vi.mock` factory above the import graph, so the command module resolves
// the stubs. `await import(...)` would need a top-level await this package's
// tsc target does not allow.
import { buildInstructionsCommand } from "../src/commands/instructions/index.js";
import { readLock } from "../src/lib/instructions/lock.js";
import { computeSnapshotDigest } from "../src/lib/instructions/manifest.js";

/**
 * Where the CLI keeps its key in these tests — deliberately outside any
 * destination, and written without a literal home directory: this repository
 * is public and its publication scan refuses one.
 */
const OUTSIDE_CONFIG_PATH = path.join(tmpdir(), "fabricai", "config.json");

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		// Both are given their values in `beforeEach`; the factory runs before
		// the constants below exist.
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		/** Proves the ambient SDK context is dropped (round 3, finding 3). */
		withoutContext: vi.fn(),
		/**
		 * Every `getClient` options object, in call order. The manifest read
		 * and the download-link request deliberately get DIFFERENT clients —
		 * different budget, different retry policy — and that is only visible
		 * here.
		 */
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

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * The instructions command mounted the way `bin/fabric.ts` mounts it.
 *
 * The root option's default is `FABRIC_FORMAT ?? "table"`, which is the ONLY
 * route by which the environment reaches these commands (review round 2,
 * finding 10). Running the subcommand on its own would leave
 * `optsWithGlobals()` with no parent to read and quietly prove nothing about
 * how the real binary behaves.
 */
function programWithInstructions(): Command {
	const program = new Command("fabric")
		.exitOverride()
		.option(
			"--format <format>",
			"Output format: table|json|yaml|csv",
			process.env.FABRIC_FORMAT ?? "table",
		);
	program.addCommand(buildInstructionsCommand());
	return program;
}

async function runCli(
	argv: string[],
	globals: string[] = [],
): Promise<RunResult> {
	let stdout = "";
	let stderr = "";
	const outSpy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
	const errSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
		code?: number,
	) => {
		throw new ExitSignal(code ?? 0);
	}) as never);

	let code = 0;
	try {
		await programWithInstructions().parseAsync(
			[...globals, "instructions", ...argv],
			{ from: "user" },
		);
	} catch (error) {
		if (error instanceof ExitSignal) {
			code = error.code;
		} else {
			throw error;
		}
	} finally {
		outSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
	}
	return { code, stdout, stderr };
}

function sha256(text: string): string {
	return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

function manifestEntry(filePath: string, contents: string) {
	return {
		path: filePath,
		sha256: sha256(contents),
		size: Buffer.byteLength(contents),
		mode: 0o100644,
		kind: "INSTRUCTIONS" as const,
	};
}

/**
 * A snapshot header that AGREES with its manifest.
 *
 * `assertValidManifest` recomputes the digest and checks the file count, so
 * a fixture that hand-writes a digest would now be refused — which is the
 * point of the check, and means every sync fixture has to be built this way.
 */
function snapshotFor(
	manifest: ReturnType<typeof manifestEntry>[],
	version = 7,
) {
	return {
		id: "snap-2",
		version,
		digest: computeSnapshotDigest(manifest),
		fileCount: manifest.length,
		publishedAt: null,
	};
}

async function makeTree(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "fabric-cmd-"));
}

beforeEach(() => {
	mocks.getPublished.mockReset();
	mocks.createDownloadUrl.mockReset();
	mocks.getApiKey.mockReset();
	mocks.getApiKey.mockReturnValue("fab_test");
	mocks.getConfigPath.mockReset();
	mocks.getConfigPath.mockReturnValue(OUTSIDE_CONFIG_PATH);
	mocks.getDefaultContext.mockReset();
	mocks.getDefaultContext.mockReturnValue(undefined);
	mocks.getClient.mockReset();
	delete process.env.FABRIC_FORMAT;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
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

	it("reports a replaced local edit by name", async () => {
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
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("replaced local edits:");
		expect(result.stdout).toContain("    AGENTS.md");
	});
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
describe("fabric instructions init", () => {
	it("refuses any tool other than claude-code", async () => {
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
		expect(result.stderr).toContain("Only --tool claude-code");
		expect(mocks.getPublished).not.toHaveBeenCalled();
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

	it("rewrites a file that was edited locally", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "someone edited this\n",
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
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
		expect(result.stdout).toContain("AGENTS.md (edited)");
		// The second call is the repair: same project, no base digest.
		expect(mocks.getPublished).toHaveBeenCalledTimes(2);
		expect(mocks.getPublished).toHaveBeenLastCalledWith("project-1", {
			org: undefined,
			sinceDigest: undefined,
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

	it("repairs under --hook too, still exiting 0", async () => {
		const manifest = [manifestEntry("AGENTS.md", "published\n")];
		const dest = await seedSyncedTree(manifest, {
			"AGENTS.md": "edited\n",
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
		await writeFile(path.join(dest, "AGENTS.md"), "edited\n");
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
		// The drifted file is left exactly as the developer left it.
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"edited\n",
		);
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

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------
describe("output format", () => {
	it("honours FABRIC_FORMAT=json without a local flag", async () => {
		const dest = await makeTree();
		process.env.FABRIC_FORMAT = "json";
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
		const parsed = JSON.parse(result.stdout);
		expect(parsed.projectId).toBe("project-1");
		expect(parsed.synced).toBe(false);
	});

	/**
	 * Review round 2, finding 10. `formatFor` re-read `FABRIC_FORMAT` after
	 * asking Commander, so the environment beat an explicit global flag — the
	 * one thing a flag is for.
	 */
	it("lets an explicit --format table beat FABRIC_FORMAT=json", async () => {
		const dest = await makeTree();
		process.env.FABRIC_FORMAT = "json";
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli(
			["check", "--project", "project-1", "--dest", dest],
			["--format", "table"],
		);

		expect(result.code).toBe(0);
		expect(() => JSON.parse(result.stdout)).toThrow();
		expect(result.stdout).toContain("Coding instructions");
	});

	it("treats an inherited yaml or csv as text rather than failing", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli(
			["check", "--project", "project-1", "--dest", dest],
			["--format", "yaml"],
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Coding instructions");
	});

	it("prints JSON from sync when asked", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "hello\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest),
			manifest,
		});
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest(manifest),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "AGENTS.md": "hello\n" });

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
		expect(JSON.parse(result.stdout).added).toEqual(["AGENTS.md"]);
	});

	it("prints JSON from init when asked", async () => {
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
			"--format",
			"json",
		]);

		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.hookCommand).toBe(
			"fabric instructions check --project project-1 --hook",
		);
		expect(parsed.sync).toBeNull();
	});

	/**
	 * `yaml` and `csv` are real values for the rest of this CLI and these
	 * commands have no such shape, so they print text rather than failing.
	 * Refusing them would be a promise that cannot be kept either: when a
	 * parent and a subcommand declare the same flag, Commander stores the
	 * value on the ROOT, so this never arrives as a local option at all.
	 */
	it("prints text for a format it has no shape for", async () => {
		const dest = await makeTree();
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
			"--format",
			"yaml",
		]);

		expect(result.code).toBe(0);
		expect(() => JSON.parse(result.stdout)).toThrow();
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedLock(
	dest: string,
	digest: string,
	files: Record<string, { sha256: string; mode: number | null }>,
	projectId = "project-1",
): Promise<void> {
	await seedRawLock(
		dest,
		JSON.stringify(
			{
				version: 1,
				projectId,
				snapshotId: "snap-1",
				snapshotVersion: 6,
				digest,
				syncedAt: "2026-09-16T10:00:00.000Z",
				files,
			},
			null,
			2,
		),
	);
}

async function seedRawLock(dest: string, body: string): Promise<void> {
	await mkdir(path.join(dest, ".fabric"), { recursive: true });
	await writeFile(
		path.join(dest, ".fabric", "instructions.lock"),
		body,
		"utf8",
	);
}

/** Serve one zip from the stubbed global fetch the bundle download uses. */
function stubBundle(files: Record<string, string>): void {
	const archive = zipSync(
		Object.fromEntries(
			Object.entries(files).map(([key, value]) => [
				key,
				new Uint8Array(Buffer.from(value)),
			]),
		),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () => new Response(archive.slice().buffer, { status: 200 }),
		),
	);
}
