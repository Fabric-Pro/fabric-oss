/**
 * The Living Memory escape hatch from the CLI side, with the SDK client
 * mocked at the `getClient` boundary and real temp directories on disk:
 *
 *  - `fabric context reset` calls the reset route only once confirmed:
 *    `--yes`, or the project's name typed at a terminal. Without a terminal
 *    and without `--yes` it refuses and sends nothing;
 *  - `fabric context reset <dir>` leaves that folder an empty lock, and
 *    refuses a lock that belongs to another project before sending anything;
 *  - `--folder` sends the folder in the server's spelling, names it in the
 *    confirmation and the report, refuses a spelling the server would
 *    refuse before sending, and drops only that folder's lock entries;
 *  - `fabric context push --init` after a server wipe sends every file as
 *    new, naming no version, so a stale lock can never produce a "deleted on
 *    the server" conflict, and replaces the lock;
 *  - several folders push in order, each with its own lock, and one failing
 *    folder fails the run without stopping the next;
 *  - a missing API-key scope names the scope and says to create a key;
 *  - progress is reported per request, a `--force` resend included, and
 *    `--timeout` stops the run with what was confirmed kept.
 */
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type FabricClient,
	FabricContextConflictError,
	FabricError,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildContextCommand } from "../src/commands/context/index.js";
import { runReset } from "../src/commands/context/reset.js";
import type { ContextLock } from "../src/lib/context-sync/lock.js";
import { computeContextPlan } from "../src/lib/context-sync/plan.js";
import type { ContextPushProgressEvent } from "../src/lib/context-sync/progress.js";
import { pushContextPlan } from "../src/lib/context-sync/push.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		upsertSyncedFile: vi.fn(),
		deleteSyncedFile: vi.fn(),
		resetSyncedFiles: vi.fn(),
		getProject: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getConfigPath: () => path.join(tmpdir(), "fabricai", "config.json"),
	getBaseUrl: () => undefined,
	getDefaultContext: () => undefined,
	getOutputFormat: () => "table",
}));

const fakeClient = vi.hoisted(() => {
	const client: Record<string, unknown> = {};
	return client;
});

vi.mock("../src/lib/client.js", () => {
	Object.assign(fakeClient, {
		contexts: {
			upsertSyncedFile: mocks.upsertSyncedFile,
			deleteSyncedFile: mocks.deleteSyncedFile,
			resetSyncedFiles: mocks.resetSyncedFiles,
		},
		projects: { get: mocks.getProject },
		withoutContext: () => fakeClient,
	});
	return { getClient: () => fakeClient };
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
	const dir = await mkdtemp(path.join(tmpdir(), "fabric-context-reset-"));
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

async function seedLock(
	dir: string,
	files: Record<string, string>,
	projectId = "project-1",
): Promise<void> {
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
}

function created(sourcePath: string, content: string) {
	return {
		status: "created",
		contextId: `ctx-new-${sourcePath}`,
		sourcePath,
		contentHash: sha256(content),
	};
}

function conflictError(
	sourcePath: string,
	content: string,
	currentHash: string | null,
) {
	return new FabricContextConflictError("changed on the server", {
		status: "conflict",
		contextId: `ctx-${sourcePath}`,
		sourcePath,
		contentHash: sha256(content),
		current:
			currentHash === null
				? null
				: {
						contextId: `ctx-${sourcePath}`,
						contentHash: currentHash,
						contentUpdatedAt: "2026-09-21T10:00:00.000Z",
						contentUpdatedBy: {
							id: "user-2",
							name: "Example User",
						},
					},
	});
}

beforeEach(() => {
	mocks.upsertSyncedFile.mockReset();
	mocks.deleteSyncedFile.mockReset();
	mocks.resetSyncedFiles.mockReset();
	mocks.getProject.mockReset();
	mocks.getApiKey.mockReset();
	mocks.getApiKey.mockReturnValue("fab_example-key");
});

// ---------------------------------------------------------------------------
// fabric context reset
// ---------------------------------------------------------------------------
describe("fabric context reset", () => {
	it("resets with --yes and reports the count", async () => {
		mocks.resetSyncedFiles.mockResolvedValue({ deleted: 3 });

		const result = await runCli([
			"reset",
			"--project",
			"project-1",
			"--yes",
		]);

		expect(result.code).toBe(0);
		expect(mocks.resetSyncedFiles).toHaveBeenCalledWith("project-1", {});
		expect(result.stdout).toContain("3 synced files deleted");
		expect(result.stdout).toContain("--init");
	});

	it("refuses without --yes when there is no terminal, and sends nothing", async () => {
		const result = await runCli(["reset", "--project", "project-1"]);

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("Refusing to reset without --yes");
		expect(mocks.resetSyncedFiles).not.toHaveBeenCalled();
	});

	it("clears the folder's lock after the reset", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });
		await seedLock(dir, { "a.md": "# A\n" });
		mocks.resetSyncedFiles.mockResolvedValue({ deleted: 1 });

		const result = await runCli([
			"reset",
			dir,
			"--project",
			"project-1",
			"--yes",
		]);

		expect(result.code).toBe(0);
		const lock = await readLockFile(dir);
		expect(lock.projectId).toBe("project-1");
		expect(lock.files).toEqual({});
	});

	it("refuses a lock that belongs to another project before sending anything", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });
		await seedLock(dir, { "a.md": "# A\n" }, "project-other");

		const result = await runCli([
			"reset",
			dir,
			"--project",
			"project-1",
			"--yes",
		]);

		expect(result.code).toBe(7);
		expect(mocks.resetSyncedFiles).not.toHaveBeenCalled();
		expect((await readLockFile(dir)).projectId).toBe("project-other");
	});

	it("says to disconnect the repository sync when the server refuses for one", async () => {
		mocks.resetSyncedFiles.mockRejectedValue(
			new FabricError(
				"This project's Living Memory is synced from example-org/notes @ main. Disconnect the repository sync first, then reset.",
				409,
				"REPOSITORY_SYNC_ACTIVE",
			),
		);

		const result = await runCli([
			"reset",
			"--project",
			"project-1",
			"--yes",
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Disconnect the repository sync first");
	});

	it("names the missing scope and says to create a key with it", async () => {
		mocks.resetSyncedFiles.mockRejectedValue(
			new FabricError(
				"Missing required scope: projects:write",
				403,
				"MISSING_SCOPE",
			),
		);

		const result = await runCli([
			"reset",
			"--project",
			"project-1",
			"--yes",
		]);

		expect(result.code).toBe(5);
		expect(result.stderr).toContain(
			"This credential is missing the projects:write scope, which a browser sign-in does not carry. Create an API key with the projects:write scope and sign in with it: fabric auth login --key <api-key>",
		);
	});

	describe("--folder", () => {
		it("sends the folder in the server's spelling and names it in the report", async () => {
			mocks.resetSyncedFiles.mockResolvedValue({ deleted: 2 });

			const result = await runCli([
				"reset",
				"--project",
				"project-1",
				"--folder",
				"docs\\guides\\",
				"--yes",
			]);

			expect(result.code).toBe(0);
			expect(mocks.resetSyncedFiles).toHaveBeenCalledWith("project-1", {
				folder: "docs/guides",
			});
			expect(result.stdout).toContain(
				"Removed the folder docs/guides from the Living Memory of project project-1: 2 synced files deleted.",
			);
		});

		it.each([
			["the root", "."],
			["an absolute path", "/etc"],
			["a dot segment", "docs/../other"],
		])("refuses %s before sending anything", async (_label, folder) => {
			const result = await runCli([
				"reset",
				"--project",
				"project-1",
				"--folder",
				folder,
				"--yes",
			]);

			expect(result.code).toBe(2);
			expect(result.stderr).toContain("--folder must be a folder's path");
			expect(mocks.resetSyncedFiles).not.toHaveBeenCalled();
		});

		it("names the folder when it refuses without --yes", async () => {
			const result = await runCli([
				"reset",
				"--project",
				"project-1",
				"--folder",
				"docs",
			]);

			expect(result.code).toBe(2);
			expect(result.stderr).toContain("under the folder docs");
			expect(mocks.resetSyncedFiles).not.toHaveBeenCalled();
		});

		it("removes only the lock's entries under the folder", async () => {
			const files = {
				"docs/a.md": "# A\n",
				"docs/guides/b.md": "# B\n",
				"docs-archive/c.md": "# C\n",
				"README.md": "# R\n",
			};
			const dir = await makeFolder(files);
			await seedLock(dir, files);
			mocks.resetSyncedFiles.mockResolvedValue({ deleted: 2 });

			const result = await runCli([
				"reset",
				dir,
				"--project",
				"project-1",
				"--folder",
				"docs",
				"--yes",
			]);

			expect(result.code).toBe(0);
			const lock = await readLockFile(dir);
			expect(Object.keys(lock.files).sort()).toEqual([
				"README.md",
				"docs-archive/c.md",
			]);
		});

		it("names the folder in the typed confirmation", async () => {
			mocks.getProject.mockResolvedValue({ name: "Example Project" });
			mocks.resetSyncedFiles.mockResolvedValue({ deleted: 1 });
			let stderr = "";
			const outSpy = vi
				.spyOn(process.stdout, "write")
				.mockImplementation(() => true);
			const errSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation((chunk: unknown) => {
					stderr += String(chunk);
					return true;
				});
			try {
				await runReset(
					undefined,
					{ project: "project-1", folder: "docs" },
					false,
					{
						run: async (_opts, body) => body(),
						client: () => fakeClient as unknown as FabricClient,
						resolveFolder: async (dir: string) => dir,
						canPrompt: () => true,
						ask: async () => "Example Project",
					},
				);
			} finally {
				outSpy.mockRestore();
				errSpy.mockRestore();
			}

			expect(stderr).toContain(
				"This deletes every file synced into the Living Memory of project project-1 under the folder docs, for everyone.",
			);
			expect(mocks.resetSyncedFiles).toHaveBeenCalledWith("project-1", {
				folder: "docs",
			});
		});
	});

	describe("typed confirmation", () => {
		const deps = (typed: string) => ({
			run: async (_opts: { hook?: boolean }, body: () => Promise<void>) =>
				body(),
			client: () => fakeClient as unknown as FabricClient,
			resolveFolder: async (dir: string) => dir,
			canPrompt: () => true,
			ask: vi.fn(async () => typed),
		});

		it("resets once the project's name is typed", async () => {
			mocks.getProject.mockResolvedValue({ name: "Example Project" });
			mocks.resetSyncedFiles.mockResolvedValue({ deleted: 2 });
			const outSpy = vi
				.spyOn(process.stdout, "write")
				.mockImplementation(() => true);
			const errSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			try {
				await runReset(
					undefined,
					{ project: "project-1" },
					false,
					deps("Example Project"),
				);
			} finally {
				outSpy.mockRestore();
				errSpy.mockRestore();
			}

			expect(mocks.resetSyncedFiles).toHaveBeenCalledTimes(1);
		});

		it("sends nothing when another name is typed", async () => {
			mocks.getProject.mockResolvedValue({ name: "Example Project" });
			const errSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			try {
				await expect(
					runReset(
						undefined,
						{ project: "project-1" },
						false,
						deps("example project"),
					),
				).rejects.toThrow("Not confirmed");
			} finally {
				errSpy.mockRestore();
			}

			expect(mocks.resetSyncedFiles).not.toHaveBeenCalled();
		});
	});
});

// ---------------------------------------------------------------------------
// fabric context push --init, several folders
// ---------------------------------------------------------------------------
describe("fabric context push --init", () => {
	it("after a server wipe sends every file as new and reports no conflict", async () => {
		const dir = await makeFolder({
			"a.md": "# A changed\n",
			"b.md": "# B\n",
		});
		// The lock from before the reset names versions the server no longer
		// holds; without --init a changed file would name one and hear that
		// it was deleted on the server.
		await seedLock(dir, { "a.md": "# A\n", "b.md": "# B\n" });
		mocks.upsertSyncedFile.mockImplementation(
			async (
				_projectId: string,
				input: { sourcePath: string; content: string },
			) => created(input.sourcePath, input.content),
		);

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--init",
		]);

		expect(result.code).toBe(0);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(2);
		for (const [, input] of mocks.upsertSyncedFile.mock.calls) {
			expect(input).not.toHaveProperty("expectedContentHash");
		}
		const lock = await readLockFile(dir);
		expect(Object.keys(lock.files).sort()).toEqual(["a.md", "b.md"]);
		expect(lock.files["a.md"]).toEqual({
			sha256: sha256("# A changed\n"),
			contextId: "ctx-new-a.md",
		});
	});

	it("ignores a lock that belongs to another project and replaces it", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });
		await seedLock(dir, { "a.md": "# A\n" }, "project-other");
		mocks.upsertSyncedFile.mockResolvedValue(created("a.md", "# A\n"));

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--init",
		]);

		expect(result.code).toBe(0);
		expect((await readLockFile(dir)).projectId).toBe("project-1");
	});

	it("refuses --init with --prune", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--init",
			"--prune",
		]);

		expect(result.code).toBe(2);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
	});

	it("suggests --init when a stale lock meets a wiped server", async () => {
		const dir = await makeFolder({ "a.md": "# A changed\n" });
		await seedLock(dir, { "a.md": "# A\n" });
		mocks.upsertSyncedFile.mockRejectedValue(
			conflictError("a.md", "# A changed\n", null),
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("push again with --init");
	});
});

describe("fabric context push <dir...>", () => {
	it("pushes each folder in order, each with its own lock", async () => {
		const first = await makeFolder({ "a.md": "# A\n" });
		const second = await makeFolder({ "b.md": "# B\n" });
		mocks.upsertSyncedFile.mockImplementation(
			async (
				_projectId: string,
				input: { sourcePath: string; content: string },
			) => created(input.sourcePath, input.content),
		);

		const result = await runCli([
			"push",
			first,
			second,
			"--project",
			"project-1",
		]);

		expect(result.code).toBe(0);
		expect(
			mocks.upsertSyncedFile.mock.calls.map(
				([, input]) => input.sourcePath,
			),
		).toEqual(["a.md", "b.md"]);
		expect(Object.keys((await readLockFile(first)).files)).toEqual([
			"a.md",
		]);
		expect(Object.keys((await readLockFile(second)).files)).toEqual([
			"b.md",
		]);
	});

	it("still pushes the next folder after one fails, and exits non-zero", async () => {
		const first = await makeFolder({ "a.md": "# A\n" });
		const second = await makeFolder({ "b.md": "# B\n" });
		mocks.upsertSyncedFile
			.mockRejectedValueOnce(new FabricError("Bad request", 400))
			.mockResolvedValueOnce(created("b.md", "# B\n"));

		const result = await runCli([
			"push",
			first,
			second,
			"--project",
			"project-1",
		]);

		expect(result.code).toBe(7);
		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(2);
		expect(result.stderr).toContain(
			"1 of 2 folders did not push completely",
		);
		expect(Object.keys((await readLockFile(second)).files)).toEqual([
			"b.md",
		]);
	});

	it("reports progress on stderr, one line per request", async () => {
		const dir = await makeFolder({ "a.md": "# A\n", "b.md": "# B\n" });
		mocks.upsertSyncedFile.mockImplementation(
			async (
				_projectId: string,
				input: { sourcePath: string; content: string },
			) => created(input.sourcePath, input.content),
		);

		const result = await runCli(["push", dir, "--project", "project-1"]);

		expect(result.stderr).toContain("[1/2] push a.md");
		expect(result.stderr).toContain("[2/2] push b.md");
	});

	it("refuses a --timeout that is not a positive whole number", async () => {
		const dir = await makeFolder({ "a.md": "# A\n" });

		const result = await runCli([
			"push",
			dir,
			"--project",
			"project-1",
			"--timeout",
			"0",
		]).catch((error: unknown) => ({
			code: -1,
			stdout: "",
			stderr: String(error),
		}));

		expect(result.code).not.toBe(0);
		expect(mocks.upsertSyncedFile).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// pushContextPlan: progress and the overall bound
// ---------------------------------------------------------------------------
describe("pushContextPlan progress and --timeout", () => {
	const client = fakeClient as unknown as FabricClient;

	it("reports a --force resend under the same number", async () => {
		const root = await makeFolder({ "a.md": "# A\n" });
		const plan = await computeContextPlan({ root, lock: null });
		mocks.upsertSyncedFile
			.mockRejectedValueOnce(
				conflictError("a.md", "# A\n", "e".repeat(64)),
			)
			.mockResolvedValueOnce({
				status: "updated",
				contextId: "ctx-a.md",
				sourcePath: "a.md",
				contentHash: sha256("# A\n"),
			});
		const events: ContextPushProgressEvent[] = [];

		await pushContextPlan({
			client,
			projectId: "project-1",
			root,
			plan,
			force: true,
			onProgress: (event) => events.push(event),
		});

		expect(events).toEqual([
			{ index: 1, total: 1, action: "push", sourcePath: "a.md" },
			{ index: 1, total: 1, action: "force", sourcePath: "a.md" },
		]);
	});

	it("stops at the bound with what was confirmed kept", async () => {
		const root = await makeFolder({ "a.md": "# A\n", "b.md": "# B\n" });
		const plan = await computeContextPlan({ root, lock: null });
		let clock = 0;
		mocks.upsertSyncedFile.mockImplementation(
			async (
				_projectId: string,
				input: { sourcePath: string; content: string },
			) => {
				// The first request uses up the whole bound.
				clock += 5_000;
				return created(input.sourcePath, input.content);
			},
		);

		const run = await pushContextPlan({
			client,
			projectId: "project-1",
			root,
			plan,
			force: false,
			timeoutMs: 5_000,
			now: () => clock,
		});

		expect(mocks.upsertSyncedFile).toHaveBeenCalledTimes(1);
		expect(run.results).toEqual([
			expect.objectContaining({ sourcePath: "a.md", status: "created" }),
		]);
		expect(run.stoppedBy?.message).toContain("--timeout of 5 s");
		expect(run.stoppedBy?.message).toContain("1 of 2 requests sent");
	});
});
