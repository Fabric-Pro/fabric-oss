/**
 * `fabric context push <dir>` end to end (Fizzy #2618), with the SDK client
 * mocked at the `getClient` boundary and a real temp directory on disk.
 *
 * The promises pinned here are the ones that decide whether a knowledge
 * folder and a project's Context can drift apart without anybody noticing:
 *
 *  - a first push states no version for any path, so it can only create or
 *    confirm, never overwrite;
 *  - a second push of an unchanged folder makes no request at all;
 *  - a changed file names the version it replaces — the hash the lock
 *    recorded — so somebody else's edit on the server is a conflict, not a
 *    silent clobber;
 *  - a conflict leaves the lock entry exactly as it was, says who changed the
 *    file and when, and fails the run after every other file was pushed;
 *  - `--force` replaces exactly the version the conflict named, once;
 *  - the lock is written last, only for what the server confirmed, never on
 *    `--dry-run`, and never for another project's folder.
 */
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FabricContextConflictError, FabricError } from "@fabricorg/sdk";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildContextCommand } from "../src/commands/context/index.js";
import type { ContextLock } from "../src/lib/context-sync/lock.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		upsertSyncedFile: vi.fn(),
		deleteSyncedFile: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		/** The overrides the command handed `getClient`. */
		clientOverrides: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getConfigPath: () => path.join(tmpdir(), "fabricai", "config.json"),
	getBaseUrl: () => undefined,
	getDefaultContext: () => undefined,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		contexts: {
			upsertSyncedFile: mocks.upsertSyncedFile,
			deleteSyncedFile: mocks.deleteSyncedFile,
		},
		withoutContext: () => client,
	};
	return {
		getClient: (overrides: unknown) => {
			mocks.clientOverrides(overrides);
			return client;
		},
	};
});

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

function program(): Command {
	const root = new Command("fabric")
		.exitOverride()
		.option("--format <format>", "Output format", "table");
	root.addCommand(buildContextCommand());
	return root;
}

async function runCli(
	argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
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
		await program().parseAsync(["context", ...argv], { from: "user" });
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
	return createHash("sha256").update(text, "utf8").digest("hex");
}

async function makeFolder(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "fabric-context-"));
	for (const [relative, contents] of Object.entries(files)) {
		const target = path.join(dir, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, contents);
	}
	return realpath(dir);
}

const LOCK = path.join(".fabric", "context.lock");

async function readLockFile(dir: string): Promise<ContextLock> {
	return JSON.parse(await readFile(path.join(dir, LOCK), "utf8"));
}

async function lockExists(dir: string): Promise<boolean> {
	return stat(path.join(dir, LOCK)).then(
		() => true,
		() => false,
	);
}

async function seedLock(
	dir: string,
	files: Record<string, string>,
	projectId = "project-1",
): Promise<ContextLock> {
	const lock: ContextLock = {
		version: 1,
		projectId,
		pushedAt: "2026-09-20T10:00:00.000Z",
		files: Object.fromEntries(
			Object.entries(files).map(([p, contents]) => [
				p,
				{ sha256: sha256(contents), contextId: `ctx-${p}` },
			]),
		),
	};
	await mkdir(path.join(dir, ".fabric"), { recursive: true });
	await writeFile(path.join(dir, LOCK), `${JSON.stringify(lock, null, 2)}\n`);
	return lock;
}

/** The server's answer for a push that stored or confirmed the content. */
function stored(
	status: "created" | "updated" | "unchanged",
	sourcePath: string,
	content: string,
) {
	return {
		status,
		contextId: `ctx-${sourcePath}`,
		sourcePath,
		contentHash: sha256(content),
	};
}

function conflictError(
	sourcePath: string,
	content: string,
	currentHash: string | null = "e".repeat(64),
) {
	return new FabricContextConflictError(
		"This file was changed on the server since the version you are replacing, so nothing was written.",
		{
			status: "conflict",
			contextId: `ctx-${sourcePath}`,
			sourcePath,
			contentHash: sha256(content),
			current: {
				contextId: `ctx-${sourcePath}`,
				contentHash: currentHash,
				contentUpdatedAt: "2026-09-22T09:30:00.000Z",
				contentUpdatedBy: { id: "user-2", name: "Example Editor" },
			},
		},
	);
}

/** The 409 for a named version whose path no longer exists on the server. */
function deletedConflictError(sourcePath: string, content: string) {
	return new FabricContextConflictError(
		"This file was deleted on the server since the version you are replacing, so nothing was written.",
		{
			status: "conflict",
			contextId: null,
			sourcePath,
			contentHash: sha256(content),
			current: null,
		},
	);
}

/** The server's answer for a new path whose content is stored elsewhere. */
function duplicateOf(sourcePath: string, content: string, other: string) {
	return {
		status: "duplicate" as const,
		contextId: `ctx-${other}`,
		sourcePath,
		contentHash: sha256(content),
		duplicateOfContextId: `ctx-${other}`,
		duplicateOfSourcePath: other,
	};
}

/** Answer every upsert as a create/update of what was sent. */
function echoServer(status: "created" | "updated" = "created") {
	mocks.upsertSyncedFile.mockImplementation(
		async (
			_projectId: string,
			input: { sourcePath: string; content: string },
		) => stored(status, input.sourcePath, input.content),
	);
}

function callsFor(sourcePath: string) {
	return mocks.upsertSyncedFile.mock.calls.filter(
		(call) => (call[1] as { sourcePath: string }).sourcePath === sourcePath,
	);
}

beforeEach(() => {
	mocks.upsertSyncedFile.mockReset();
	mocks.deleteSyncedFile.mockReset();
	mocks.clientOverrides.mockReset();
	mocks.getApiKey.mockReset();
	mocks.getApiKey.mockReturnValue("org_test_key");
	echoServer();
});

// ---------------------------------------------------------------------------
// First run and second run
// ---------------------------------------------------------------------------
describe("fabric context push — first and second run", () => {
	it("pushes every file in sorted order without an expected hash, then writes the lock", async () => {
		const dir = await makeFolder({
			"zeta.md": "# Zeta\n",
			"docs/alpha.md": "# Alpha\n",
			"notes.txt": "plain notes\n",
		});

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(
			mocks.upsertSyncedFile.mock.calls.map(
				(call) => (call[1] as { sourcePath: string }).sourcePath,
			),
		).toEqual(["docs/alpha.md", "notes.txt", "zeta.md"]);
		for (const call of mocks.upsertSyncedFile.mock.calls) {
			expect(call[0]).toBe("project-1");
			expect(call[1]).not.toHaveProperty("expectedContentHash");
		}
		expect(mocks.upsertSyncedFile.mock.calls[0]?.[1]).toEqual({
			sourcePath: "docs/alpha.md",
			content: "# Alpha\n",
		});

		const lock = await readLockFile(dir);
		expect(lock.version).toBe(1);
		expect(lock.projectId).toBe("project-1");
		expect(lock.files).toEqual({
			"docs/alpha.md": {
				sha256: sha256("# Alpha\n"),
				contextId: "ctx-docs/alpha.md",
			},
			"notes.txt": {
				sha256: sha256("plain notes\n"),
				contextId: "ctx-notes.txt",
			},
			"zeta.md": { sha256: sha256("# Zeta\n"), contextId: "ctx-zeta.md" },
		});
		expect(result.stdout).toContain("created (3)");
	});

	it("makes no request at all when nothing changed since the lock", async () => {
		const files = { "a.md": "# A\n", "b/c.md": "# C\n" };
		const dir = await makeFolder(files);
		const lock = await seedLock(dir, files);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
		// Not rewritten either: nothing the server said has changed it.
		expect(await readLockFile(dir)).toEqual(lock);
		expect(result.stdout).toMatch(/unchanged \(2\)/);
	});

	it("sends the lock's hash as expectedContentHash for a changed file, and only for it", async () => {
		const dir = await makeFolder({ "a.md": "# A v2\n", "b.md": "# B\n" });
		await seedLock(dir, { "a.md": "# A v1\n", "b.md": "# B\n" });
		echoServer("updated");

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledWith(
			"project-1",
			{
				sourcePath: "a.md",
				content: "# A v2\n",
				expectedContentHash: sha256("# A v1\n"),
			},
			{ org: undefined },
		);
		expect((await readLockFile(dir)).files["a.md"]?.sha256).toBe(
			sha256("# A v2\n"),
		);
	});

	it("passes --org through to the request", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });

		await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--org",
			"example-org",
		]);

		expect(mocks.upsertSyncedFile).toHaveBeenCalledWith(
			"project-1",
			expect.anything(),
			{ org: "example-org" },
		);
	});
});

// ---------------------------------------------------------------------------
// Conflicts and --force
// ---------------------------------------------------------------------------
describe("fabric context push — conflicts", () => {
	it("leaves a conflicting path's lock entry untouched, names the editor and time, and exits 1", async () => {
		const dir = await makeFolder({
			"a.md": "# A mine\n",
			"b.md": "# B v2\n",
		});
		const before = await seedLock(dir, {
			"a.md": "# A v1\n",
			"b.md": "# B v1\n",
		});
		mocks.upsertSyncedFile.mockImplementation(
			async (
				_p: string,
				input: { sourcePath: string; content: string },
			) => {
				if (input.sourcePath === "a.md") {
					throw conflictError("a.md", input.content);
				}
				return stored("updated", input.sourcePath, input.content);
			},
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toContain(
			"a.md: changed on the server by Example Editor at 2026-09-22T09:30:00.000Z since your last push",
		);
		// The other file was still pushed and recorded.
		const lock = await readLockFile(dir);
		expect(lock.files["b.md"]?.sha256).toBe(sha256("# B v2\n"));
		// The conflicting one kept exactly what it had.
		expect(lock.files["a.md"]).toEqual(before.files["a.md"]);
		expect(result.stderr).toMatch(/conflict/);
		expect(result.stderr).toContain("--force");
	});

	it("does not resend a conflict without --force", async () => {
		const dir = await makeFolder({ "a.md": "# A mine\n" });
		await seedLock(dir, { "a.md": "# A v1\n" });
		mocks.upsertSyncedFile.mockRejectedValue(
			conflictError("a.md", "# A mine\n"),
		);

		await runCli(["push", dir, "--project", "project-1"]);

		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
	});

	it("with --force, resends exactly once naming the server's current hash, and records the result", async () => {
		const dir = await makeFolder({ "a.md": "# A mine\n" });
		await seedLock(dir, { "a.md": "# A v1\n" });
		const theirs = "f".repeat(64);
		mocks.upsertSyncedFile
			.mockRejectedValueOnce(conflictError("a.md", "# A mine\n", theirs))
			.mockResolvedValueOnce(stored("updated", "a.md", "# A mine\n"));

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(2);
		expect(mocks.upsertSyncedFile.mock.calls[0]?.[1]).toEqual({
			sourcePath: "a.md",
			content: "# A mine\n",
			expectedContentHash: sha256("# A v1\n"),
		});
		expect(mocks.upsertSyncedFile.mock.calls[1]?.[1]).toEqual({
			sourcePath: "a.md",
			content: "# A mine\n",
			expectedContentHash: theirs,
		});
		expect((await readLockFile(dir)).files["a.md"]?.sha256).toBe(
			sha256("# A mine\n"),
		);
		expect(result.stdout).toContain("Example Editor");
	});

	it("with --force, reports a second conflict as a conflict and does not try a third time", async () => {
		const dir = await makeFolder({ "a.md": "# A mine\n" });
		const before = await seedLock(dir, { "a.md": "# A v1\n" });
		mocks.upsertSyncedFile
			.mockRejectedValueOnce(
				conflictError("a.md", "# A mine\n", "1".repeat(64)),
			)
			.mockRejectedValueOnce(
				conflictError("a.md", "# A mine\n", "2".repeat(64)),
			);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(result.code).toBe(1);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(2);
		expect(result.stdout).toMatch(/conflict \(1\)/);
		expect((await readLockFile(dir)).files["a.md"]).toEqual(
			before.files["a.md"],
		);
	});

	it("with --force, skips the resend when the file is rewritten between the conflict and the resend", async () => {
		const dir = await makeFolder({ "a.md": "# A mine\n" });
		const before = await seedLock(dir, { "a.md": "# A v1\n" });
		mocks.upsertSyncedFile.mockImplementationOnce(async () => {
			// An editor saves a.md while the conflict is on its way back, so
			// the content read before the first request is no longer the file.
			await writeFile(path.join(dir, "a.md"), "# A newer\n");
			throw conflictError("a.md", "# A mine\n", "f".repeat(64));
		});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(result.stdout).toContain("a.md: changed-during-run");
		expect((await readLockFile(dir)).files["a.md"]).toEqual(
			before.files["a.md"],
		);
	});

	it("reports a file deleted on the server since the last push, and leaves its lock entry", async () => {
		const dir = await makeFolder({ "a.md": "# A mine\n" });
		const before = await seedLock(dir, { "a.md": "# A v1\n" });
		mocks.upsertSyncedFile.mockRejectedValue(
			deletedConflictError("a.md", "# A mine\n"),
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(1);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(result.stdout).toContain(
			"a.md: deleted on the server since your last push",
		);
		// --force sends it with no version, which may find the content stored
		// under another path instead of recreating it.
		expect(result.stderr).toMatch(
			/--force.*deleted file.*duplicate.*another path/,
		);
		expect((await readLockFile(dir)).files["a.md"]).toEqual(
			before.files["a.md"],
		);
	});

	it("with --force, reports a duplicate when the resend for a deleted file finds its content under another path", async () => {
		const dir = await makeFolder({ "a.md": "# A mine\n" });
		await seedLock(dir, { "a.md": "# A v1\n" });
		mocks.upsertSyncedFile
			.mockRejectedValueOnce(deletedConflictError("a.md", "# A mine\n"))
			.mockResolvedValueOnce(duplicateOf("a.md", "# A mine\n", "b.md"));

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(2);
		expect(mocks.upsertSyncedFile.mock.calls[1]?.[1]).toEqual({
			sourcePath: "a.md",
			content: "# A mine\n",
		});
		expect(result.stdout).toContain("a.md: duplicate of b.md");
		expect((await readLockFile(dir)).files["a.md"]).toEqual({
			sha256: sha256("# A mine\n"),
			state: "duplicate",
		});
	});

	it("with --force, recreates a file deleted on the server by resending once with no expected hash", async () => {
		const dir = await makeFolder({ "a.md": "# A mine\n" });
		await seedLock(dir, { "a.md": "# A v1\n" });
		mocks.upsertSyncedFile
			.mockRejectedValueOnce(deletedConflictError("a.md", "# A mine\n"))
			.mockResolvedValueOnce(stored("created", "a.md", "# A mine\n"));

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(2);
		expect(mocks.upsertSyncedFile.mock.calls[0]?.[1]).toEqual({
			sourcePath: "a.md",
			content: "# A mine\n",
			expectedContentHash: sha256("# A v1\n"),
		});
		expect(mocks.upsertSyncedFile.mock.calls[1]?.[1]).toEqual({
			sourcePath: "a.md",
			content: "# A mine\n",
		});
		expect((await readLockFile(dir)).files["a.md"]).toEqual({
			sha256: sha256("# A mine\n"),
			contextId: "ctx-a.md",
		});
	});

	it("with --force, cannot replace a server version that has no hash, and says so", async () => {
		const dir = await makeFolder({ "a.md": "# A mine\n" });
		mocks.upsertSyncedFile.mockRejectedValue(
			conflictError("a.md", "# A mine\n", null),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(result.code).toBe(1);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Repository-managed files (Living Memory design 2026-09-23 §6)
// ---------------------------------------------------------------------------
/** The server's 409 for a path a repository sync owns. */
function repositoryManagedError(
	sourcePath: string,
	repository: string | null = "example-org/handbook",
	ref: string | null = "main",
) {
	const origin = repository
		? ref
			? `${repository} @ ${ref}`
			: repository
		: "the connected repository";
	return new FabricError(
		`${sourcePath} is synced from ${origin}; change it in the repository and run Sync now.`,
		409,
		"REPOSITORY_MANAGED",
	);
}

describe("fabric context push — repository-managed files (Living Memory design 2026-09-23 §6)", () => {
	it("reports a new file a repository sync already owns as skipped, and records no lock entry (PUT create)", async () => {
		const dir = await makeFolder({ "docs/architecture.md": "# A\n" });
		mocks.upsertSyncedFile.mockRejectedValue(
			repositoryManagedError("docs/architecture.md"),
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(result.stdout).toContain("skipped (1)");
		expect(result.stdout).toContain(
			"docs/architecture.md is synced from example-org/handbook @ main; change it in the repository and run Sync now.",
		);
		expect(await lockExists(dir)).toBe(false);
	});

	it("reports a changed file a repository sync owns as skipped, and leaves its lock entry untouched (PUT replace)", async () => {
		const dir = await makeFolder({
			"docs/architecture.md": "# A mine\n",
		});
		const before = await seedLock(dir, {
			"docs/architecture.md": "# A v1\n",
		});
		mocks.upsertSyncedFile.mockRejectedValue(
			repositoryManagedError("docs/architecture.md"),
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledWith(
			"project-1",
			{
				sourcePath: "docs/architecture.md",
				content: "# A mine\n",
				expectedContentHash: sha256("# A v1\n"),
			},
			{ org: undefined },
		);
		expect(result.stdout).toContain("skipped (1)");
		expect(result.stdout).toContain(
			"docs/architecture.md is synced from example-org/handbook @ main; change it in the repository and run Sync now.",
		);
		// Lock untouched: the pre-sync version stays exactly as it was.
		expect((await readLockFile(dir)).files["docs/architecture.md"]).toEqual(
			before.files["docs/architecture.md"],
		);
	});

	it("with --force, does not retry a repository-managed refusal", async () => {
		const dir = await makeFolder({
			"docs/architecture.md": "# A mine\n",
		});
		const before = await seedLock(dir, {
			"docs/architecture.md": "# A v1\n",
		});
		mocks.upsertSyncedFile.mockRejectedValue(
			repositoryManagedError("docs/architecture.md"),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect((await readLockFile(dir)).files["docs/architecture.md"]).toEqual(
			before.files["docs/architecture.md"],
		);
	});

	it("names 'the connected repository' when the sync configuration was removed between the reads", async () => {
		const dir = await makeFolder({ "docs/architecture.md": "# A\n" });
		mocks.upsertSyncedFile.mockRejectedValue(
			repositoryManagedError("docs/architecture.md", null, null),
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			"docs/architecture.md is synced from the connected repository; change it in the repository and run Sync now.",
		);
	});
});

// ---------------------------------------------------------------------------
// Duplicates, removals, failures
// ---------------------------------------------------------------------------
describe("fabric context push — other outcomes", () => {
	it("reports a duplicate with the other path and records it as a duplicate, with no server row", async () => {
		const dir = await makeFolder({
			"copy.md": "# Same\n",
			"orig.md": "# Orig\n",
		});
		mocks.upsertSyncedFile.mockImplementation(
			async (
				_p: string,
				input: { sourcePath: string; content: string },
			) =>
				input.sourcePath === "copy.md"
					? duplicateOf("copy.md", input.content, "docs/same.md")
					: stored("created", input.sourcePath, input.content),
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("copy.md: duplicate of docs/same.md");
		const lock = await readLockFile(dir);
		// No contextId: the path has no row of its own to name.
		expect(lock.files["copy.md"]).toEqual({
			sha256: sha256("# Same\n"),
			state: "duplicate",
		});
		expect(lock.files["orig.md"]).toEqual({
			sha256: sha256("# Orig\n"),
			contextId: "ctx-orig.md",
		});
	});

	it("makes no request for an unchanged duplicate on the next run", async () => {
		const dir = await makeFolder({ "copy.md": "# Same\n" });
		mocks.upsertSyncedFile.mockResolvedValue(
			duplicateOf("copy.md", "# Same\n", "docs/same.md"),
		);
		await runCli(["push", dir, "--project", "project-1"]);
		const afterFirst = await readLockFile(dir);
		mocks.upsertSyncedFile.mockClear();

		const second = await runCli(["push", dir, "--project", "project-1"]);

		expect(second.code).toBe(0);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
		expect(await readLockFile(dir)).toEqual(afterFirst);
	});

	it("sends a duplicate whose content changed with no expected hash, since it never had a row", async () => {
		const dir = await makeFolder({ "copy.md": "# Now different\n" });
		await mkdir(path.join(dir, ".fabric"), { recursive: true });
		await writeFile(
			path.join(dir, LOCK),
			`${JSON.stringify({
				version: 1,
				projectId: "project-1",
				pushedAt: "2026-09-20T10:00:00.000Z",
				files: {
					"copy.md": {
						sha256: sha256("# Same\n"),
						state: "duplicate",
					},
				},
			})}\n`,
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(mocks.upsertSyncedFile.mock.calls[0]?.[1]).toEqual({
			sourcePath: "copy.md",
			content: "# Now different\n",
		});
		expect((await readLockFile(dir)).files["copy.md"]).toEqual({
			sha256: sha256("# Now different\n"),
			contextId: "ctx-copy.md",
		});
	});

	it("skips a file rewritten between planning and its push, and keeps going", async () => {
		const dir = await makeFolder({
			"a.md": "# A\n",
			"b.md": "# B v2\n",
			"c.md": "# C\n",
		});
		const before = await seedLock(dir, { "b.md": "# B v1\n" });
		mocks.upsertSyncedFile.mockImplementation(
			async (
				_p: string,
				input: { sourcePath: string; content: string },
			) => {
				// An editor saves b.md while a.md is on the wire, after the
				// plan hashed it and before it is sent.
				if (input.sourcePath === "a.md") {
					await writeFile(path.join(dir, "b.md"), "# B v3\n");
				}
				return stored("created", input.sourcePath, input.content);
			},
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(callsFor("b.md")).toHaveLength(0);
		expect(callsFor("c.md")).toHaveLength(1);
		expect(result.stdout).toContain("b.md: changed-during-run");
		const lock = await readLockFile(dir);
		expect(lock.files["b.md"]).toEqual(before.files["b.md"]);
		expect(lock.files).toHaveProperty("c.md");
	});

	it("reports a file deleted locally as removed, makes no call for it, and keeps its lock entry", async () => {
		const dir = await makeFolder({ "kept.md": "# Kept\n" });
		const before = await seedLock(dir, {
			"kept.md": "# Kept\n",
			"gone.md": "# Gone\n",
		});

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
		// Without --prune, nothing is ever deleted.
		expect(mocks.deleteSyncedFile).not.toHaveBeenCalled();
		expect(result.stdout).toContain(
			"gone.md: removed locally; server entry kept",
		);
		expect((await readLockFile(dir)).files["gone.md"]).toEqual(
			before.files["gone.md"],
		);
	});

	it("keeps pushing after a per-file failure, records the rest, and exits with that failure's code", async () => {
		const dir = await makeFolder({ "a.md": "# A\n", "b.md": "# B\n" });
		mocks.upsertSyncedFile.mockImplementation(
			async (
				_p: string,
				input: { sourcePath: string; content: string },
			) => {
				if (input.sourcePath === "a.md") {
					throw new FabricError("content is empty", 400);
				}
				return stored("created", input.sourcePath, input.content);
			},
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(7);
		expect(callsFor("b.md")).toHaveLength(1);
		const lock = await readLockFile(dir);
		expect(lock.files).toHaveProperty("b.md");
		expect(lock.files).not.toHaveProperty("a.md");
		expect(result.stdout).toContain("a.md: content is empty");
	});

	it("stops at a refusal that applies to every file, after recording what already landed", async () => {
		const dir = await makeFolder({ "a.md": "# A\n", "b.md": "# B\n" });
		mocks.upsertSyncedFile
			.mockResolvedValueOnce(stored("created", "a.md", "# A\n"))
			.mockRejectedValueOnce(
				Object.assign(
					new FabricError(
						"Missing required scope: projects:write",
						403,
						"MISSING_SCOPE",
					),
				),
			);
		const dir2 = dir;

		const result = await runCli(["push", dir2, "--project", "project-1"]);

		expect(result.code).toBe(5);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(2);
		expect(result.stderr).toContain(
			"Missing required scope: projects:write",
		);
		expect((await readLockFile(dir)).files).toHaveProperty("a.md");
	});
});

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------
describe("fabric context push — the lock", () => {
	it("writes the lock only after the last request", async () => {
		const dir = await makeFolder({ "a.md": "# A\n", "b.md": "# B\n" });
		const seenDuringPush: boolean[] = [];
		mocks.upsertSyncedFile.mockImplementation(
			async (
				_p: string,
				input: { sourcePath: string; content: string },
			) => {
				seenDuringPush.push(await lockExists(dir));
				return stored("created", input.sourcePath, input.content);
			},
		);

		await runCli(["push", dir, "--project", "project-1"]);

		expect(seenDuringPush).toEqual([false, false]);
		expect(await lockExists(dir)).toBe(true);
	});

	it("--dry-run makes no request and writes no lock", async () => {
		const dir = await makeFolder({ "a.md": "# A\n", "b.md": "# B v2\n" });
		await seedLock(dir, { "b.md": "# B v1\n", "gone.md": "# Gone\n" });
		const before = await readFile(path.join(dir, LOCK), "utf8");

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--dry-run",
		]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
		expect(await readFile(path.join(dir, LOCK), "utf8")).toBe(before);
		expect(result.stdout).toMatch(/dry run/i);
		expect(result.stdout).toContain("a.md");
		expect(result.stdout).toContain("b.md");
		expect(result.stdout).toContain("gone.md");
	});

	it("--dry-run on a first run creates no lock", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });

		await runCli(["push", dir, "--project", "project-1", "--dry-run"]);

		expect(await lockExists(dir)).toBe(false);
	});

	it("refuses a lock that belongs to another project, naming both, before any request", async () => {
		const dir = await makeFolder({ "a.md": "# A v2\n" });
		await seedLock(dir, { "a.md": "# A v1\n" }, "project-A");

		const result = await runCli(["push", dir, "--project", "project-B"]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("project-A");
		expect(result.stderr).toContain("project-B");
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
	});

	it("refuses a damaged lock rather than treating it as a first run", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });
		await mkdir(path.join(dir, ".fabric"), { recursive: true });
		await writeFile(path.join(dir, LOCK), "{ not json");

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(7);
		expect(result.stderr).toMatch(/not valid JSON/);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Arguments, output, hook mode
// ---------------------------------------------------------------------------
describe("fabric context push — arguments and output", () => {
	it("requires <dir> rather than defaulting to the working directory", async () => {
		const result = await runCli(["push", "--project", "project-1"]).catch(
			(error: unknown) => ({
				code: -1,
				stdout: "",
				stderr: String(error),
			}),
		);

		expect(result.code).not.toBe(0);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
	});

	it("refuses a directory that does not exist with a usage error", async () => {
		const missing = path.join(
			tmpdir(),
			"fabric-context-does-not-exist-xyz",
		);

		const result = await runCli([
			"push",
			missing,
			"--project",
			"project-1",
		]);

		expect(result.code).toBe(2);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
	});

	it("exits 3 without an API key", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });
		mocks.getApiKey.mockReturnValue(undefined);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(3);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
	});

	it("prints the plan and the results as one JSON object with --format json", async () => {
		const dir = await makeFolder({
			"a.md": "# A\n",
			"pic.png": "not really",
		});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--format",
			"json",
		]);

		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout) as {
			projectId: string;
			dryRun: boolean;
			plan: {
				push: { sourcePath: string; sha256: string }[];
				skipped: { path: string; reason: string }[];
			};
			results: { sourcePath: string; status: string }[];
			counts: Record<string, number>;
		};
		expect(parsed.projectId).toBe("project-1");
		expect(parsed.dryRun).toBe(false);
		expect(parsed.plan.push).toEqual([
			expect.objectContaining({
				sourcePath: "a.md",
				sha256: sha256("# A\n"),
			}),
		]);
		// The content itself is never echoed.
		expect(result.stdout).not.toContain("# A\\n");
		expect(parsed.plan.skipped).toEqual([
			{ path: "pic.png", reason: "unsupported-type" },
		]);
		expect(parsed.results).toEqual([
			expect.objectContaining({ sourcePath: "a.md", status: "created" }),
		]);
		expect(parsed.counts.created).toBe(1);
	});

	it("uses the SDK's retry policy outside hook mode: the route answers a retry 'unchanged'", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });

		await runCli(["push", dir, "--project", "project-1"]);

		const overrides = mocks.clientOverrides.mock.calls[0]?.[0] as {
			retry?: unknown;
		};
		expect(overrides.retry).toBeUndefined();
	});
});

describe("fabric context push --hook", () => {
	it("swallows a failure into one line on stderr and exits 0", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });
		mocks.upsertSyncedFile.mockRejectedValue(
			new FabricError("fetch failed: ECONNREFUSED", 0, "NETWORK_ERROR"),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--hook",
		]);

		expect(result.code).toBe(0);
		const lines = result.stderr.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^fabric: context push /);
		expect(lines[0]).toContain("ECONNREFUSED");
	});

	it("swallows a conflict too", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });
		mocks.upsertSyncedFile.mockRejectedValue(
			conflictError("a.md", "# A\n"),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr.split("\n").filter(Boolean)).toHaveLength(1);
	});

	it("swallows a missing API key instead of exiting 3", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });
		mocks.getApiKey.mockReturnValue(undefined);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toMatch(
			/^fabric: context push .*Not authenticated/,
		);
	});

	it("turns retries off and bounds the request by the hook deadline", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });

		await runCli(["push", dir, "--project", "project-1", "--hook"]);

		const overrides = mocks.clientOverrides.mock.calls[0]?.[0] as {
			retry?: { maxRetries: number };
			timeoutMs?: number;
		};
		expect(overrides.retry).toEqual({ maxRetries: 0 });
		expect(overrides.timeoutMs).toBeLessThanOrEqual(10_000);
	});
});

// ---------------------------------------------------------------------------
// Moves (Fizzy #2636)
// ---------------------------------------------------------------------------
const A = "# A\n";

/** The server's answer for a move that renamed the row. */
function moved(from: string, to: string, content: string) {
	return {
		status: "moved" as const,
		contextId: `ctx-${from}`,
		sourcePath: to,
		contentHash: sha256(content),
		movedFromSourcePath: from,
	};
}

/** A 409 for a move whose old path changed on the server. */
function sourceChangedConflict(
	from: string,
	to: string,
	content: string,
	current: {
		contentHash: string | null;
	} | null = { contentHash: "e".repeat(64) },
) {
	return new FabricContextConflictError(
		`The file at ${from} was changed on the server since the version you are moving, so nothing was written and it was not moved.`,
		{
			status: "conflict",
			contextId: current === null ? null : `ctx-${from}`,
			sourcePath: to,
			contentHash: sha256(content),
			current:
				current === null
					? null
					: {
							contextId: `ctx-${from}`,
							contentHash: current.contentHash,
							contentUpdatedAt: "2026-09-22T09:30:00.000Z",
							contentUpdatedBy: {
								id: "user-2",
								name: "Example Editor",
							},
						},
			moveNotApplied: {
				movedFromSourcePath: from,
				reason: "source-changed",
			},
		},
	);
}

describe("fabric context push — moves", () => {
	it("sends a moved file as one rename naming the old path and its version, and moves the lock entry", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		await seedLock(dir, { "a.md": A });
		mocks.upsertSyncedFile.mockResolvedValue(moved("a.md", "docs/a.md", A));

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledWith(
			"project-1",
			{
				sourcePath: "docs/a.md",
				content: A,
				expectedContentHash: sha256(A),
				movedFromSourcePath: "a.md",
			},
			{ org: undefined },
		);
		expect(mocks.deleteSyncedFile).not.toHaveBeenCalled();
		expect((await readLockFile(dir)).files).toEqual({
			"docs/a.md": { sha256: sha256(A), contextId: "ctx-a.md" },
		});
		expect(result.stdout).toContain("moved (1)");
		expect(result.stdout).toContain("a.md -> docs/a.md");
		expect(result.stdout).not.toContain("removed locally");
	});

	it("records the new path and drops the old one when the server had no row there any more", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		await seedLock(dir, { "a.md": A });
		mocks.upsertSyncedFile.mockResolvedValue({
			...stored("created", "docs/a.md", A),
			moveNotApplied: {
				movedFromSourcePath: "a.md",
				reason: "source-missing",
			},
		});

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect((await readLockFile(dir)).files).toEqual({
			"docs/a.md": { sha256: sha256(A), contextId: "ctx-docs/a.md" },
		});
		expect(result.stdout).toContain(
			"a.md: gone on the server; docs/a.md pushed as created",
		);
	});

	it("records the new path and keeps the old entry as a removal when the new path already had its own row", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		const before = await seedLock(dir, { "a.md": A });
		mocks.upsertSyncedFile.mockResolvedValue({
			...stored("unchanged", "docs/a.md", A),
			moveNotApplied: {
				movedFromSourcePath: "a.md",
				reason: "target-exists",
			},
		});

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		const lock = await readLockFile(dir);
		expect(lock.files["docs/a.md"]).toEqual({
			sha256: sha256(A),
			contextId: "ctx-docs/a.md",
		});
		expect(lock.files["a.md"]).toEqual(before.files["a.md"]);
		expect(result.stdout).toContain(
			"a.md: not moved, docs/a.md is already on the server; docs/a.md pushed as unchanged; a.md kept",
		);
		expect(mocks.deleteSyncedFile).not.toHaveBeenCalled();
	});

	it("reports a conflict on the old path when it changed on the server, and leaves the lock and the new path alone", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		const before = await seedLock(dir, { "a.md": A });
		mocks.upsertSyncedFile.mockRejectedValue(
			sourceChangedConflict("a.md", "docs/a.md", A),
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(1);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(await readLockFile(dir)).toEqual(before);
		expect(result.stdout).toContain(
			"a.md: changed on the server by Example Editor at 2026-09-22T09:30:00.000Z since your last push; not moved to docs/a.md",
		);
	});

	it("with --force, resends the move once naming the old path's current version", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		const before = await seedLock(dir, { "a.md": A });
		mocks.upsertSyncedFile
			.mockRejectedValueOnce(
				sourceChangedConflict("a.md", "docs/a.md", A),
			)
			// A move never replaces content: the server keeps the edited old
			// row and stores this folder's version at the new path.
			.mockResolvedValueOnce({
				...stored("created", "docs/a.md", A),
				moveNotApplied: {
					movedFromSourcePath: "a.md",
					reason: "content-differs",
				},
			});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(2);
		expect(mocks.upsertSyncedFile.mock.calls[1]?.[1]).toEqual({
			sourcePath: "docs/a.md",
			content: A,
			expectedContentHash: "e".repeat(64),
			movedFromSourcePath: "a.md",
		});
		const lock = await readLockFile(dir);
		expect(lock.files["docs/a.md"]?.sha256).toBe(sha256(A));
		// The old row still holds the edit: its entry stays, as a removal.
		expect(lock.files["a.md"]).toEqual(before.files["a.md"]);
	});

	it("with --force, pushes the new path as an ordinary new file and drops the old one when the old row is gone", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		await seedLock(dir, { "a.md": A });
		mocks.upsertSyncedFile
			.mockRejectedValueOnce(
				sourceChangedConflict("a.md", "docs/a.md", A, null),
			)
			.mockResolvedValueOnce(stored("created", "docs/a.md", A));

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile.mock.calls[1]?.[1]).toEqual({
			sourcePath: "docs/a.md",
			content: A,
		});
		expect((await readLockFile(dir)).files).toEqual({
			"docs/a.md": { sha256: sha256(A), contextId: "ctx-docs/a.md" },
		});
	});

	it("with --force, reports a second conflict on the old path and does not try a third time", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		const before = await seedLock(dir, { "a.md": A });
		mocks.upsertSyncedFile.mockRejectedValue(
			sourceChangedConflict("a.md", "docs/a.md", A),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(result.code).toBe(1);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(2);
		expect(await readLockFile(dir)).toEqual(before);
		expect(result.stdout).toContain("while --force was moving it");
	});

	it("does not send a move whose new file changed after planning, keeps its lock entry and does not prune it", async () => {
		const B = "# B\n";
		const dir = await makeFolder({ "docs/a.md": A, "docs/b.md": B });
		const before = await seedLock(dir, { "a.md": A, "b.md": B });
		mocks.upsertSyncedFile.mockImplementation(
			async (_p: string, input: { sourcePath: string }) => {
				// docs/b.md is saved again while the first move is on the wire.
				if (input.sourcePath === "docs/a.md") {
					await writeFile(path.join(dir, "docs", "b.md"), "# B v2\n");
				}
				return moved("a.md", "docs/a.md", A);
			},
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
		]);

		expect(result.code).toBe(0);
		expect(callsFor("docs/b.md")).toHaveLength(0);
		expect(mocks.deleteSyncedFile).not.toHaveBeenCalled();
		const lock = await readLockFile(dir);
		expect(lock.files["b.md"]).toEqual(before.files["b.md"]);
		expect(lock.files).not.toHaveProperty("docs/b.md");
		expect(result.stdout).toContain("docs/b.md: changed-during-run");
	});

	it("--dry-run lists a move and sends nothing", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		await seedLock(dir, { "a.md": A });

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--dry-run",
		]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
		expect(result.stdout).toContain("moved (1)");
		expect(result.stdout).toContain("a.md -> docs/a.md");
	});

	it("drops the old entry, and leaves the new path unrecorded, when the new path's conflict says the old row is gone", async () => {
		// Lock: old.md at A. Disk: new.md at A. Server: no old.md, and its own
		// new.md at B, so the move is answered as a conflict about new.md.
		const B = "# B, stored on the server\n";
		const dir = await makeFolder({ "new.md": A });
		await seedLock(dir, { "old.md": A });
		mocks.upsertSyncedFile.mockRejectedValue(
			new FabricContextConflictError(
				"This file is already on the server with different content, so nothing was written.",
				{
					status: "conflict",
					contextId: "ctx-new.md",
					sourcePath: "new.md",
					contentHash: sha256(A),
					current: {
						contextId: "ctx-new.md",
						contentHash: sha256(B),
						contentUpdatedAt: "2026-09-22T09:30:00.000Z",
						contentUpdatedBy: {
							id: "user-2",
							name: "Example Editor",
						},
					},
					moveNotApplied: {
						movedFromSourcePath: "old.md",
						reason: "source-missing",
					},
				},
			),
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(1);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		// The old path has nothing left to name; new.md was not stored.
		expect((await readLockFile(dir)).files).toEqual({});
		expect(result.stdout).toContain(
			"new.md: already on the server with different content, last changed by Example Editor at 2026-09-22T09:30:00.000Z; old.md gone on the server",
		);

		// The next run no longer plans the same move: new.md is an ordinary
		// new file, sent naming no old path.
		mocks.upsertSyncedFile.mockClear();
		await runCli(["push", dir, "--project", "project-1"]);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(mocks.upsertSyncedFile.mock.calls[0]?.[1]).toEqual({
			sourcePath: "new.md",
			content: A,
		});
	});

	it("with --force, still drops the old entry when the replace of the new path conflicts again", async () => {
		const B = "# B, stored on the server\n";
		const dir = await makeFolder({ "new.md": A });
		await seedLock(dir, { "old.md": A });
		mocks.upsertSyncedFile
			.mockRejectedValueOnce(
				new FabricContextConflictError(
					"This file is already on the server with different content, so nothing was written.",
					{
						status: "conflict",
						contextId: "ctx-new.md",
						sourcePath: "new.md",
						contentHash: sha256(A),
						current: {
							contextId: "ctx-new.md",
							contentHash: sha256(B),
							contentUpdatedAt: "2026-09-22T09:30:00.000Z",
							contentUpdatedBy: {
								id: "user-2",
								name: "Example Editor",
							},
						},
						moveNotApplied: {
							movedFromSourcePath: "old.md",
							reason: "source-missing",
						},
					},
				),
			)
			// The replace of new.md (not a move) loses to yet another edit.
			.mockRejectedValueOnce(conflictError("new.md", A));

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--force",
		]);

		expect(result.code).toBe(1);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(2);
		expect((await readLockFile(dir)).files).toEqual({});
	});

	it("recognises a server that does not support moves, sends nothing more even with --force, and keeps the lock", async () => {
		// A server from before moves ignores movedFromSourcePath, so it
		// answers the new path as an ordinary push naming a version: a
		// conflict with no current version and no moveNotApplied.
		for (const force of [false, true]) {
			mocks.upsertSyncedFile.mockReset();
			mocks.deleteSyncedFile.mockReset();
			const dir = await makeFolder({ "docs/a.md": A });
			const before = await seedLock(dir, { "a.md": A });
			mocks.upsertSyncedFile.mockRejectedValue(
				deletedConflictError("docs/a.md", A),
			);

			const result = await runCli([
				"push",
				dir,
				"--project",
				"project-1",
				"--prune",
				...(force ? ["--force"] : []),
			]);

			expect(result.code).toBe(1);
			expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
			expect(mocks.deleteSyncedFile).not.toHaveBeenCalled();
			expect(await readLockFile(dir)).toEqual(before);
			expect(result.stdout).toContain(
				"a.md -> docs/a.md: the server does not support moves yet; a.md kept, docs/a.md not pushed",
			);
			expect(result.stdout).not.toContain("deleted on the server");
			expect(result.stderr).toContain("does not support moves yet");
		}
	});

	it("reports a move whose new path a repository sync owns as skipped, and leaves both lock entries untouched", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		const before = await seedLock(dir, { "a.md": A });
		mocks.upsertSyncedFile.mockRejectedValue(
			new FabricError(
				"docs/a.md is synced from example-org/handbook @ main; change it in the repository and run Sync now.",
				409,
				"REPOSITORY_MANAGED",
			),
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(mocks.deleteSyncedFile).not.toHaveBeenCalled();
		expect(result.stdout).toContain("skipped (1)");
		expect(result.stdout).toContain(
			"docs/a.md is synced from example-org/handbook @ main; change it in the repository and run Sync now.",
		);
		// Neither the old path's entry nor (absent) a new one changed.
		expect(await readLockFile(dir)).toEqual(before);
	});
});

// ---------------------------------------------------------------------------
// --prune (Fizzy #2636)
// ---------------------------------------------------------------------------
function deleteConflict(sourcePath: string, lockedContent: string) {
	return new FabricContextConflictError(
		"This file was changed on the server since the version you are deleting, so nothing was deleted.",
		{
			status: "conflict",
			contextId: `ctx-${sourcePath}`,
			sourcePath,
			contentHash: sha256(lockedContent),
			current: {
				contextId: `ctx-${sourcePath}`,
				contentHash: "e".repeat(64),
				contentUpdatedAt: "2026-09-22T09:30:00.000Z",
				contentUpdatedBy: { id: "user-2", name: "Example Editor" },
			},
		},
	);
}

const GONE = "# Gone\n";

describe("fabric context push --prune", () => {
	it("deletes a removed file's server entry in the version the lock names, and drops it from the lock", async () => {
		const dir = await makeFolder({ "kept.md": "# Kept\n" });
		await seedLock(dir, { "kept.md": "# Kept\n", "gone.md": GONE });
		mocks.deleteSyncedFile.mockResolvedValue({
			status: "deleted",
			contextId: "ctx-gone.md",
			sourcePath: "gone.md",
			contentHash: sha256(GONE),
		});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
		]);

		expect(result.code).toBe(0);
		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(1);
		expect(mocks.deleteSyncedFile).toHaveBeenCalledWith(
			"project-1",
			{ sourcePath: "gone.md", expectedContentHash: sha256(GONE) },
			{ org: undefined },
		);
		expect(Object.keys((await readLockFile(dir)).files)).toEqual([
			"kept.md",
		]);
		expect(result.stdout).toContain("deleted (1)");
		expect(result.stdout).toMatch(/deleted \(1\)\n {2}gone\.md\n/);
		expect(result.stdout).not.toContain("removed locally");
	});

	it("drops an entry the server no longer has, and says so", async () => {
		const dir = await makeFolder({});
		await seedLock(dir, { "gone.md": GONE });
		mocks.deleteSyncedFile.mockResolvedValue({
			status: "absent",
			sourcePath: "gone.md",
		});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
		]);

		expect(result.code).toBe(0);
		expect((await readLockFile(dir)).files).toEqual({});
		expect(result.stdout).toContain("already gone (1)");
		expect(result.stdout).toContain("gone.md: already gone on the server");
	});

	it("does not delete a file changed on the server since the last push, keeps its entry, and exits 1", async () => {
		const dir = await makeFolder({});
		const before = await seedLock(dir, { "gone.md": GONE });
		mocks.deleteSyncedFile.mockRejectedValue(
			deleteConflict("gone.md", GONE),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
		]);

		expect(result.code).toBe(1);
		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(1);
		expect(await readLockFile(dir).catch(() => before)).toEqual(before);
		expect(result.stdout).toContain(
			"gone.md: changed on the server by Example Editor at 2026-09-22T09:30:00.000Z since your last push; not deleted",
		);
		expect(result.stderr).toMatch(/not deleted/);
	});

	it("with --force, deletes the version the conflict reported, once", async () => {
		const dir = await makeFolder({});
		await seedLock(dir, { "gone.md": GONE });
		mocks.deleteSyncedFile
			.mockRejectedValueOnce(deleteConflict("gone.md", GONE))
			.mockResolvedValueOnce({
				status: "deleted",
				contextId: "ctx-gone.md",
				sourcePath: "gone.md",
				contentHash: "e".repeat(64),
			});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--force",
		]);

		expect(result.code).toBe(0);
		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(2);
		expect(mocks.deleteSyncedFile.mock.calls[1]?.[1]).toEqual({
			sourcePath: "gone.md",
			expectedContentHash: "e".repeat(64),
		});
		expect((await readLockFile(dir)).files).toEqual({});
		expect(result.stdout).toContain(
			"gone.md: deleted the version Example Editor changed at 2026-09-22T09:30:00.000Z (--force)",
		);
	});

	it("with --force, reports a second conflict and does not try a third time", async () => {
		const dir = await makeFolder({});
		const before = await seedLock(dir, { "gone.md": GONE });
		mocks.deleteSyncedFile.mockRejectedValue(
			deleteConflict("gone.md", GONE),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--force",
		]);

		expect(result.code).toBe(1);
		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(2);
		expect(await readLockFile(dir)).toEqual(before);
		expect(result.stdout).toContain("while --force was deleting it");
	});

	it("reports a prune target a repository sync owns as skipped, keeps its lock entry, and never retries with --force", async () => {
		const dir = await makeFolder({});
		const before = await seedLock(dir, { "gone.md": GONE });
		mocks.deleteSyncedFile.mockRejectedValue(
			new FabricError(
				"gone.md is synced from example-org/handbook @ main; change it in the repository and run Sync now.",
				409,
				"REPOSITORY_MANAGED",
			),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--force",
		]);

		expect(result.code).toBe(0);
		// Final: the one attempt, never a --force resend.
		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(1);
		expect(result.stdout).toContain("skipped (1)");
		expect(result.stdout).toContain(
			"gone.md is synced from example-org/handbook @ main; change it in the repository and run Sync now.",
		);
		expect(result.stdout).not.toContain("removed locally");
		// The lock entry is kept, exactly as it was.
		expect(await readLockFile(dir)).toEqual(before);
	});

	it("stops at a missing delete permission with exit 5, after recording what already landed", async () => {
		const dir = await makeFolder({ "new.md": "# New\n" });
		await seedLock(dir, { "a-gone.md": GONE, "b-gone.md": GONE });
		mocks.deleteSyncedFile.mockRejectedValue(
			new FabricError(
				"No permission to delete context sources from this project",
				403,
			),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
		]);

		expect(result.code).toBe(5);
		// One refusal is enough: it would repeat for every file.
		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(1);
		expect(result.stderr).toContain(
			"No permission to delete context sources from this project",
		);
		const lock = await readLockFile(dir);
		expect(lock.files).toHaveProperty("new.md");
		expect(lock.files).toHaveProperty("a-gone.md");
		expect(lock.files).toHaveProperty("b-gone.md");
	});

	it("prunes after every push and move, so a run that stops early deletes nothing", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });
		await seedLock(dir, { "gone.md": GONE });
		mocks.upsertSyncedFile.mockRejectedValue(
			new FabricError(
				"Missing required scope: projects:write",
				403,
				"MISSING_SCOPE",
			),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
		]);

		expect(result.code).toBe(5);
		expect(mocks.deleteSyncedFile).not.toHaveBeenCalled();
	});

	it("deletes the old path in the same run when a move fell back because the new path already existed", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		await seedLock(dir, { "a.md": A });
		mocks.upsertSyncedFile.mockResolvedValue({
			...stored("unchanged", "docs/a.md", A),
			moveNotApplied: {
				movedFromSourcePath: "a.md",
				reason: "target-exists",
			},
		});
		mocks.deleteSyncedFile.mockResolvedValue({
			status: "deleted",
			contextId: "ctx-a.md",
			sourcePath: "a.md",
			contentHash: sha256(A),
		});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
		]);

		expect(result.code).toBe(0);
		expect(mocks.deleteSyncedFile).toHaveBeenCalledWith(
			"project-1",
			{ sourcePath: "a.md", expectedContentHash: sha256(A) },
			{ org: undefined },
		);
		expect(Object.keys((await readLockFile(dir)).files)).toEqual([
			"docs/a.md",
		]);
	});

	it("never deletes the old path of a move that was applied", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		await seedLock(dir, { "a.md": A });
		mocks.upsertSyncedFile.mockResolvedValue(moved("a.md", "docs/a.md", A));

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
		]);

		expect(result.code).toBe(0);
		expect(mocks.deleteSyncedFile).not.toHaveBeenCalled();
	});

	it("--dry-run lists what would be deleted and sends nothing", async () => {
		const dir = await makeFolder({ "kept.md": "# Kept\n" });
		const before = await seedLock(dir, {
			"kept.md": "# Kept\n",
			"gone.md": GONE,
		});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--dry-run",
		]);

		expect(result.code).toBe(0);
		expect(mocks.deleteSyncedFile).not.toHaveBeenCalled();
		expect(result.stdout).toContain("would delete (1)");
		expect(result.stdout).toContain("gone.md");
		expect(result.stdout).not.toContain("server entry would be kept");
		expect(await readLockFile(dir)).toEqual(before);
	});

	it("keeps the entry of a deletion still running on the server, says to run again, counts it as not deleted and exits 1", async () => {
		const dir = await makeFolder({});
		const before = await seedLock(dir, {
			"a-gone.md": GONE,
			"b-gone.md": GONE,
		});
		mocks.deleteSyncedFile
			.mockResolvedValueOnce({
				status: "deleted",
				contextId: "ctx-a-gone.md",
				sourcePath: "a-gone.md",
				contentHash: sha256(GONE),
			})
			.mockResolvedValueOnce({
				status: "in-progress",
				sourcePath: "b-gone.md",
			});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
		]);

		expect(result.code).toBe(1);
		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(2);
		// The server may or may not have deleted it yet: the entry stays, so
		// the next --prune names the same version and confirms.
		const lock = await readLockFile(dir);
		expect(Object.keys(lock.files)).toEqual(["b-gone.md"]);
		expect(lock.files["b-gone.md"]).toEqual(before.files["b-gone.md"]);
		expect(result.stdout).toMatch(
			/deletion still running \(1\)\n {2}b-gone\.md: deletion still running on the server; run again to confirm\n/,
		);
		expect(result.stdout).not.toContain("b-gone.md: removed locally");
		expect(result.stderr).toContain(
			"--prune: 1 deleted, 0 already gone, 1 not deleted",
		);
		expect(result.stderr).toMatch(/run again to confirm/);
	});

	it("never forces a deletion that is still running: --force resends only a conflict", async () => {
		const dir = await makeFolder({});
		await seedLock(dir, { "gone.md": GONE });
		mocks.deleteSyncedFile.mockResolvedValue({
			status: "in-progress",
			sourcePath: "gone.md",
		});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--force",
		]);

		expect(result.code).toBe(1);
		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(1);
		expect(Object.keys((await readLockFile(dir)).files)).toEqual([
			"gone.md",
		]);
	});

	it("keeps the entry when the --force resend after a conflict is still running", async () => {
		const dir = await makeFolder({});
		const before = await seedLock(dir, { "gone.md": GONE });
		mocks.deleteSyncedFile
			.mockRejectedValueOnce(deleteConflict("gone.md", GONE))
			.mockResolvedValueOnce({
				status: "in-progress",
				sourcePath: "gone.md",
			});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--force",
		]);

		expect(result.code).toBe(1);
		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(2);
		expect(await readLockFile(dir).catch(() => before)).toEqual(before);
		expect(result.stdout).toContain(
			"gone.md: deletion still running on the server; run again to confirm",
		);
	});

	it("counts a deletion still running as not deleted in the --hook line and in --format json", async () => {
		const dir = await makeFolder({});
		await seedLock(dir, { "gone.md": GONE });
		mocks.deleteSyncedFile.mockResolvedValue({
			status: "in-progress",
			sourcePath: "gone.md",
		});

		const hook = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--hook",
		]);
		const lines = hook.stderr.split("\n").filter(Boolean);
		expect(hook.code).toBe(0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(
			"--prune: 0 deleted, 0 already gone, 1 not deleted",
		);

		const json = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--format",
			"json",
		]);
		const parsed = JSON.parse(json.stdout) as {
			results: { sourcePath: string; status: string }[];
			counts: Record<string, number>;
		};
		expect(parsed.results).toEqual([
			{ sourcePath: "gone.md", status: "delete-in-progress" },
		]);
		expect(parsed.counts.deleteInProgress).toBe(1);
		expect(parsed.counts.deleted).toBe(0);
	});

	it("reports moves, prunes and their outcomes in --format json", async () => {
		const dir = await makeFolder({ "docs/a.md": A });
		await seedLock(dir, { "a.md": A, "gone.md": GONE });
		mocks.upsertSyncedFile.mockResolvedValue(moved("a.md", "docs/a.md", A));
		mocks.deleteSyncedFile.mockResolvedValue({
			status: "deleted",
			contextId: "ctx-gone.md",
			sourcePath: "gone.md",
			contentHash: sha256(GONE),
		});

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--format",
			"json",
		]);

		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout) as {
			prune: boolean;
			plan: { moves: unknown[]; removed: string[] };
			results: {
				sourcePath: string;
				status: string;
				movedFrom?: string;
			}[];
			counts: Record<string, number>;
		};
		expect(parsed.prune).toBe(true);
		expect(parsed.plan.moves).toEqual([
			{
				from: "a.md",
				to: "docs/a.md",
				sha256: sha256(A),
				contextId: "ctx-a.md",
			},
		]);
		expect(parsed.plan.removed).toEqual(["gone.md"]);
		expect(parsed.results).toEqual([
			expect.objectContaining({
				sourcePath: "docs/a.md",
				status: "moved",
				movedFrom: "a.md",
			}),
			expect.objectContaining({
				sourcePath: "gone.md",
				status: "deleted",
			}),
		]);
		expect(parsed.counts.moved).toBe(1);
		expect(parsed.counts.deleted).toBe(1);
	});

	it("names deletions in the one line a --hook run leaves on stderr", async () => {
		const dir = await makeFolder({});
		await seedLock(dir, { "a-gone.md": GONE, "b-gone.md": GONE });
		mocks.deleteSyncedFile
			.mockResolvedValueOnce({
				status: "deleted",
				contextId: "ctx-a-gone.md",
				sourcePath: "a-gone.md",
				contentHash: sha256(GONE),
			})
			.mockRejectedValueOnce(deleteConflict("b-gone.md", GONE));

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--hook",
		]);

		expect(result.code).toBe(0);
		const lines = result.stderr.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^fabric: context push /);
		expect(lines[0]).toMatch(/1 deleted/);
		expect(lines[0]).toMatch(/1 not deleted/);
	});

	it("counts a deletion a run-level refusal stopped before it was tried as not deleted, in the --hook line", async () => {
		const dir = await makeFolder({});
		await seedLock(dir, { "a-gone.md": GONE, "b-gone.md": GONE });
		mocks.deleteSyncedFile
			.mockResolvedValueOnce({
				status: "deleted",
				contextId: "ctx-a-gone.md",
				sourcePath: "a-gone.md",
				contentHash: sha256(GONE),
			})
			.mockRejectedValueOnce(
				new FabricError(
					"No permission to delete context sources from this project",
					403,
				),
			);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--hook",
		]);

		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(2);
		const lines = result.stderr.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(
			"No permission to delete context sources from this project",
		);
		expect(lines[0]).toContain(
			"--prune: 1 deleted, 0 already gone, 1 not deleted",
		);
		const lock = await readLockFile(dir);
		expect(lock.files).not.toHaveProperty("a-gone.md");
		expect(lock.files).toHaveProperty("b-gone.md");
	});

	it("counts every removed file as not deleted when the run stops before the deletions", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });
		await seedLock(dir, { "gone.md": GONE });
		mocks.upsertSyncedFile.mockRejectedValue(
			new FabricError(
				"Missing required scope: projects:write",
				403,
				"MISSING_SCOPE",
			),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
			"--hook",
		]);

		expect(mocks.deleteSyncedFile).not.toHaveBeenCalled();
		expect(result.stderr).toContain(
			"--prune: 0 deleted, 0 already gone, 1 not deleted",
		);
	});

	it("lists the kept old path of a declined move when the run stops before deleting it", async () => {
		const dir = await makeFolder({ "docs/b.md": A });
		await seedLock(dir, { "aaa-gone.md": GONE, "b.md": A });
		mocks.upsertSyncedFile.mockResolvedValue({
			...stored("unchanged", "docs/b.md", A),
			moveNotApplied: {
				movedFromSourcePath: "b.md",
				reason: "target-exists",
			},
		});
		// The first deletion (aaa-gone.md sorts first) stops the run.
		mocks.deleteSyncedFile.mockRejectedValue(
			new FabricError(
				"No permission to delete context sources from this project",
				403,
			),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--prune",
		]);

		expect(result.code).toBe(5);
		expect(mocks.deleteSyncedFile).toHaveBeenCalledTimes(1);
		expect(result.stdout).toContain(
			"aaa-gone.md: removed locally; server entry kept",
		);
		expect(result.stdout).toContain(
			"b.md: removed locally; server entry kept",
		);
		expect(result.stderr).toContain(
			"--prune: 0 deleted, 0 already gone, 2 not deleted",
		);
	});
});
