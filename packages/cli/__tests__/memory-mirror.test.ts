import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FabricClient } from "@fabricorg/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitBlobOid } from "../src/lib/git-blob.js";
import { resolveDestinationRoot } from "../src/lib/instructions/safe-write.js";
import type { MirrorContext } from "../src/lib/memory/context.js";
import { readMemoryLock, writeMemoryLock } from "../src/lib/memory/lock.js";
import { pull } from "../src/lib/memory/pull.js";
import { push } from "../src/lib/memory/push.js";
import { gitFor } from "../src/lib/memory/runtime.js";
import { status } from "../src/lib/memory/status.js";
import { FakeMemoryServer, sha256 } from "./helpers/fake-memory.js";

const PROJECT = "cmexampleproject0123456789";
const encode = (text: string) => new TextEncoder().encode(text);

let directory: string;
let root: string;
let server: FakeMemoryServer;

function git(...args: string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Example",
			GIT_AUTHOR_EMAIL: "dev@example.com",
			GIT_COMMITTER_NAME: "Example",
			GIT_COMMITTER_EMAIL: "dev@example.com",
		},
	});
}

function context(overrides: Partial<MirrorContext> = {}): MirrorContext {
	return {
		client: { memory: server.memory } as unknown as Pick<
			FabricClient,
			"memory"
		>,
		projectId: PROJECT,
		root,
		git: gitFor(root),
		now: () => new Date("2026-10-16T12:00:00Z"),
		...overrides,
	};
}

async function write(relative: string, text: string): Promise<void> {
	const file = path.join(root, ...relative.split("/"));
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, text);
}

async function read(relative: string): Promise<string | null> {
	return readFile(path.join(root, ...relative.split("/")), "utf8").catch(
		() => null,
	);
}

async function lock() {
	const found = await readMemoryLock(root, PROJECT);
	if (found === null) {
		throw new Error("no lock");
	}
	return found;
}

beforeEach(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "fabric-mirror-"));
	root = await resolveDestinationRoot(path.join(directory, "project"));
	await mkdir(root, { recursive: true });
	git("init", "-q");
	server = new FakeMemoryServer();
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("pull", () => {
	it("writes the folder's files at their repository paths and records the lock", async () => {
		server.set("docs/ai/spec.md", "# Spec\n");
		server.set("docs/ai/tasks/one.md", "one\n");

		const result = await pull(context());

		expect(result.written).toEqual([
			"docs/ai/spec.md",
			"docs/ai/tasks/one.md",
		]);
		expect(await read("docs/ai/spec.md")).toBe("# Spec\n");
		expect(await read("docs/ai/tasks/one.md")).toBe("one\n");
		const held = await lock();
		expect(held.files["docs/ai/spec.md"]).toEqual({
			targetId: "t1",
			blobOid: server.blobOf("docs/ai/spec.md"),
			contentHash: sha256("# Spec\n"),
			origin: "pull",
		});
	});

	it("keeps the folder and .fabric out of the developer's commits", async () => {
		server.set("docs/ai/spec.md", "# Spec\n");

		await pull(context());

		expect(git("status", "--porcelain")).toBe("");
		expect(
			git("check-ignore", "docs/ai/spec.md", ".fabric/memory.lock").split(
				"\n",
			),
		).toEqual(
			expect.arrayContaining(["docs/ai/spec.md", ".fabric/memory.lock"]),
		);
	});

	it("does nothing the second time, and replaces an unmodified file the server changed", async () => {
		server.set("docs/ai/spec.md", "v1\n");
		await pull(context());
		expect((await pull(context())).written).toEqual([]);

		server.set("docs/ai/spec.md", "v2\n");
		const result = await pull(context());

		expect(result.written).toEqual(["docs/ai/spec.md"]);
		expect(await read("docs/ai/spec.md")).toBe("v2\n");
		expect((await lock()).files["docs/ai/spec.md"]?.contentHash).toBe(
			sha256("v2\n"),
		);
	});

	it("never overwrites a file you changed, and says so", async () => {
		server.set("docs/ai/spec.md", "v1\n");
		await pull(context());
		await write("docs/ai/spec.md", "my edit\n");
		server.set("docs/ai/spec.md", "v2\n");

		const result = await pull(context());

		expect(await read("docs/ai/spec.md")).toBe("my edit\n");
		expect(result.kept).toEqual([
			{ path: "docs/ai/spec.md", reason: "modified" },
		]);
		expect(result.written).toEqual([]);
		expect((await lock()).files["docs/ai/spec.md"]?.contentHash).toBe(
			sha256("v1\n"),
		);
	});

	it("takes the server's version for a path you name with accept-remote", async () => {
		server.set("docs/ai/spec.md", "v1\n");
		await pull(context());
		await write("docs/ai/spec.md", "my edit\n");
		server.set("docs/ai/spec.md", "v2\n");

		await pull(context(), { acceptRemote: ["docs/ai/spec.md"] });

		expect(await read("docs/ai/spec.md")).toBe("v2\n");
	});

	it("keeps a different file that is already there and the mirror did not write", async () => {
		await write("docs/ai/spec.md", "mine\n");
		server.set("docs/ai/spec.md", "theirs\n");

		const result = await pull(context());

		expect(await read("docs/ai/spec.md")).toBe("mine\n");
		expect(result.kept).toEqual([
			{ path: "docs/ai/spec.md", reason: "untracked-differs" },
		]);
	});

	it("adopts a local file that already equals the server's, writing nothing", async () => {
		await write("docs/ai/spec.md", "same\n");
		server.set("docs/ai/spec.md", "same\n");

		const result = await pull(context());

		expect(result.written).toEqual([]);
		expect((await lock()).files["docs/ai/spec.md"]?.origin).toBe("pull");
	});

	it("deletes an unmodified file the server removed, and keeps one you edited as a new local file", async () => {
		server.set("docs/ai/a.md", "a\n");
		server.set("docs/ai/b.md", "b\n");
		await pull(context());
		await write("docs/ai/b.md", "edited b\n");
		server.files.delete("docs/ai/a.md");
		server.files.delete("docs/ai/b.md");

		const result = await pull(context());

		expect(result.deleted).toEqual(["docs/ai/a.md"]);
		expect(await read("docs/ai/a.md")).toBeNull();
		expect(result.kept).toEqual([
			{ path: "docs/ai/b.md", reason: "modified-and-removed" },
		]);
		expect(await read("docs/ai/b.md")).toBe("edited b\n");
		const held = await lock();
		expect(held.files["docs/ai/a.md"]).toBeUndefined();
		expect(held.files["docs/ai/b.md"]).toBeUndefined();
	});

	it("keeps a file you deleted when the server changed it since", async () => {
		server.set("docs/ai/a.md", "a\n");
		await pull(context());
		await rm(path.join(root, "docs", "ai", "a.md"));
		server.set("docs/ai/a.md", "a2\n");

		const result = await pull(context());

		expect(await read("docs/ai/a.md")).toBeNull();
		expect(result.kept).toEqual([
			{
				path: "docs/ai/a.md",
				reason: "deleted-locally-changed-remotely",
			},
		]);
	});

	it("leaves a path git tracks to git", async () => {
		await write("docs/ai/tracked.md", "in the product repo\n");
		git("add", "docs/ai/tracked.md");
		git("commit", "-q", "-m", "tracked");
		server.set("docs/ai/tracked.md", "from memory\n");
		server.set("docs/ai/free.md", "free\n");

		const result = await pull(context());

		expect(result.trackedByGit).toEqual(["docs/ai/tracked.md"]);
		expect(await read("docs/ai/tracked.md")).toBe("in the product repo\n");
		expect(await read("docs/ai/free.md")).toBe("free\n");
		expect((await lock()).files["docs/ai/tracked.md"]).toBeUndefined();
	});

	it("follows the listing across pages", async () => {
		server.pageSize = 2;
		for (const name of ["a", "b", "c", "d", "e"]) {
			server.set(`docs/ai/${name}.md`, `${name}\n`);
		}

		const result = await pull(context());

		expect(result.written).toHaveLength(5);
		expect(server.calls.listFiles).toBe(3);
	});

	it("refuses a file whose bytes are not the hash the server listed, and writes nothing for it", async () => {
		server.set("docs/ai/bad.md", "bad\n");
		server.corrupt.add("docs/ai/bad.md");

		await expect(pull(context())).rejects.toThrow(/did not match/);
		expect(await read("docs/ai/bad.md")).toBeNull();
	});

	it("says when the project has no folders, and still works outside a git repository", async () => {
		server.targets = [];
		await rm(path.join(root, ".git"), { recursive: true, force: true });

		const result = await pull(context());

		expect(result.noFolders).toBe(true);
	});

	it("keeps a byte-order mark: the hash covers it", async () => {
		server.set("docs/ai/bom.md", "﻿heading\n");

		await pull(context());

		const bytes = await readFile(path.join(root, "docs", "ai", "bom.md"));
		expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		expect((await lock()).files["docs/ai/bom.md"]?.contentHash).toBe(
			sha256("﻿heading\n"),
		);
	});

	it("never writes through a link out of the folder", async () => {
		await mkdir(path.join(root, "docs"), { recursive: true });
		const outside = path.join(directory, "outside");
		await mkdir(outside, { recursive: true });
		const { symlink } = await import("node:fs/promises");
		await symlink(outside, path.join(root, "docs", "ai"), "junction").catch(
			() => undefined,
		);
		server.set("docs/ai/spec.md", "spec\n");

		await pull(context()).catch(() => undefined);

		expect(
			await stat(path.join(outside, "spec.md")).catch(() => null),
		).toBeNull();
	});
});

describe("push", () => {
	async function pulled(files: Record<string, string>) {
		for (const [name, text] of Object.entries(files)) {
			server.set(name, text);
		}
		await pull(context());
	}

	it("sends a new file with no ifMatchOid, a changed one with the lock's blob, and a deleted one with it too", async () => {
		await pulled({
			"docs/ai/changed.md": "c1\n",
			"docs/ai/gone.md": "g\n",
			"docs/ai/same.md": "s\n",
		});
		await write("docs/ai/new.md", "new\n");
		await write("docs/ai/changed.md", "c2\n");
		await rm(path.join(root, "docs", "ai", "gone.md"));

		const result = await push(context());

		expect(result.sent).toEqual([
			expect.objectContaining({
				folder: "docs/ai",
				fileCount: 3,
				mode: "PULL_REQUEST",
			}),
		]);
		expect(server.submitted).toHaveLength(1);
		const sent = server.submitted[0];
		expect(sent?.targetId).toBe("t1");
		expect(sent?.entries).toEqual([
			{
				path: "docs/ai/changed.md",
				op: "PUT",
				ifMatchOid: server.blobOf("docs/ai/changed.md"),
				content: "c2\n",
			},
			{
				path: "docs/ai/gone.md",
				op: "DELETE",
				ifMatchOid: server.blobOf("docs/ai/gone.md"),
			},
			{ path: "docs/ai/new.md", op: "PUT", content: "new\n" },
		]);
	});

	it("names the date and the count in the message unless told otherwise", async () => {
		await write("docs/ai/a.md", "a\n");
		await write("docs/ai/b.md", "b\n");

		await push(context());
		await push(context(), { message: "my words" });

		expect(server.submitted[0]?.message).toBe(
			"Update project memory (2 files, 2026-10-16)",
		);
	});

	it("remembers the write in the outbox and does not send the same content again", async () => {
		await write("docs/ai/a.md", "a\n");
		await push(context());

		const again = await push(context());

		expect(server.submitted).toHaveLength(1);
		expect(again.sent).toEqual([]);
		expect(again.skipped).toEqual([
			{ path: "docs/ai/a.md", reason: "already-sent" },
		]);
		const held = await lock();
		expect(held.outbox).toHaveLength(1);
		expect(held.outbox[0]).toMatchObject({
			writeId: "w1",
			status: "PENDING",
			paths: [
				{
					path: "docs/ai/a.md",
					op: "PUT",
					contentHash: sha256("a\n"),
					newBlobOid: gitBlobOid(encode("a\n")),
				},
			],
		});
	});

	it("sends later edits to a file that is already in flight", async () => {
		await write("docs/ai/a.md", "a\n");
		await push(context());
		await write("docs/ai/a.md", "a again\n");

		const result = await push(context());

		expect(result.sent).toHaveLength(1);
		expect(server.submitted).toHaveLength(2);
	});

	it("groups by folder: one write per folder", async () => {
		server.targets = [
			{ id: "t1", folder: "docs/ai", mode: "PULL_REQUEST", version: 1 },
			{ id: "t2", folder: "docs/notes", mode: "DIRECT_PUSH", version: 1 },
		];
		await write("docs/ai/a.md", "a\n");
		await write("docs/notes/n.md", "n\n");
		await write("docs/other/o.md", "outside every folder\n");

		const result = await push(context());

		expect(result.sent.map((sent) => [sent.folder, sent.mode])).toEqual([
			["docs/ai", "PULL_REQUEST"],
			["docs/notes", "DIRECT_PUSH"],
		]);
		expect(server.submitted.map((input) => input.targetId)).toEqual([
			"t1",
			"t2",
		]);
	});

	it("splits a large change into writes of fifty", async () => {
		for (let i = 0; i < 120; i++) {
			await write(
				`docs/ai/f${String(i).padStart(3, "0")}.md`,
				`file ${i}\n`,
			);
		}

		await push(context());

		expect(server.submitted.map((input) => input.entries.length)).toEqual([
			50, 50, 20,
		]);
	});

	it("stages content through upload URLs when it is too big to send inline", async () => {
		const big = "x".repeat(900 * 1024);
		for (const name of ["a", "b", "c"]) {
			await write(`docs/ai/${name}.md`, `${name}${big}`);
		}
		const puts: Array<{ url: string; length: number }> = [];
		const fetchImpl: typeof fetch = async (url, init) => {
			puts.push({
				url: String(url),
				length: (init?.body as Uint8Array).byteLength,
			});
			return new Response(null, { status: 200 });
		};

		await push(context({ fetchImpl }));

		expect(server.memory.createUploadUrls).toHaveBeenCalledTimes(1);
		expect(puts).toHaveLength(3);
		const entries = server.submitted[0]?.entries ?? [];
		expect(
			entries.every(
				(entry) =>
					entry.content === undefined &&
					entry.stagedKey !== undefined,
			),
		).toBe(true);
		expect(entries[0]).toMatchObject({
			path: "docs/ai/a.md",
			op: "PUT",
			bytes: 900 * 1024 + 1,
			sha256: sha256(`a${big}`),
		});
	});

	it("reports files the server would refuse instead of sending them", async () => {
		await write("docs/ai/ok.md", "ok\n");
		await write("docs/ai/image.png", "not text");
		await write("docs/ai/.hidden/secret.md", "hidden");
		await write("docs/ai/empty.md", "   \n");

		const result = await push(context());

		expect(result.sent[0]?.fileCount).toBe(1);
		expect(result.skipped).toEqual(
			expect.arrayContaining([
				{ path: "docs/ai/image.png", reason: "not-text-extension" },
				{ path: "docs/ai/empty.md", reason: "empty" },
			]),
		);
		expect(JSON.stringify(server.submitted)).not.toContain("secret");
	});

	it("leaves a path git tracks to git", async () => {
		await write("docs/ai/tracked.md", "t\n");
		git("add", "docs/ai/tracked.md");
		git("commit", "-q", "-m", "tracked");
		await write("docs/ai/tracked.md", "t2\n");

		const result = await push(context());

		expect(server.submitted).toHaveLength(0);
		expect(result.skipped).toEqual([
			{ path: "docs/ai/tracked.md", reason: "tracked" },
		]);
	});

	it("sends the files that are fine when the server names one it will not take, and keeps the problem", async () => {
		await write("docs/ai/good.md", "good\n");
		await write("docs/ai/leak.md", "token\n");
		server.refuse = (input) =>
			input.entries.some((entry) => entry.path === "docs/ai/leak.md")
				? [{ path: "docs/ai/leak.md", code: "SECRET_DETECTED" }]
				: null;

		const result = await push(context());

		expect(server.submitted).toHaveLength(1);
		expect(server.submitted[0]?.entries.map((entry) => entry.path)).toEqual(
			["docs/ai/good.md"],
		);
		expect(result.refused).toEqual([
			{
				folder: "docs/ai",
				problems: ["docs/ai/leak.md: SECRET_DETECTED"],
			},
		]);
		const held = await lock();
		expect(
			held.outbox.map((record) => [
				record.status,
				record.paths.map((p) => p.path),
			]),
		).toEqual([
			["REFUSED", ["docs/ai/leak.md"]],
			["PENDING", ["docs/ai/good.md"]],
		]);
		expect(held.outbox[0]?.paths[0]?.verdict).toEqual({
			code: "SECRET_DETECTED",
		});
	});

	it("does not send a refused file again until it changes", async () => {
		await write("docs/ai/leak.md", "token\n");
		server.refuse = () => [
			{ path: "docs/ai/leak.md", code: "SECRET_DETECTED" },
		];
		await push(context());
		server.refuse = null;

		const again = await push(context());

		expect(again.sent).toEqual([]);
		expect(again.skipped).toEqual([
			{ path: "docs/ai/leak.md", reason: "unresolved-problem" },
		]);

		await write("docs/ai/leak.md", "cleaned\n");
		expect((await push(context())).sent).toHaveLength(1);
		expect((await lock()).outbox.map((record) => record.status)).toEqual([
			"PENDING",
		]);
	});

	it("stops and counts what is left when too many writes are pending", async () => {
		server.busy = true;
		await write("docs/ai/a.md", "a\n");

		const result = await push(context());

		expect(result.busy).toBe(true);
		expect(result.remaining).toBe(1);
		expect((await lock()).outbox).toEqual([]);
	});

	it("costs no request at all when nothing changed and the folders are remembered", async () => {
		await pulled({ "docs/ai/a.md": "a\n" });
		const targets = server.calls.getTargets;

		const result = await push(context(), { cached: true });

		expect(result.sent).toEqual([]);
		expect(server.calls.getTargets).toBe(targets);
		expect(server.calls.submit).toBe(0);
	});

	it("asks for the folders again when the remembered ones went stale", async () => {
		await pulled({ "docs/ai/a.md": "a\n" });
		await write("docs/ai/new.md", "new\n");
		server.targets = [
			{ id: "t9", folder: "docs/ai", mode: "PULL_REQUEST", version: 2 },
		];
		server.refuse = (input) =>
			input.targetId === "t1" ? [{ code: "TARGET_NOT_FOUND" }] : null;

		const result = await push(context(), { cached: true });

		expect(result.sent).toHaveLength(1);
		expect(server.submitted.at(-1)?.targetId).toBe("t9");
	});

	it("does nothing, quietly, when there are no folders", async () => {
		server.targets = [];

		const result = await push(context());

		expect(result.noFolders).toBe(true);
		expect(server.calls.submit).toBe(0);
	});
});

describe("status and the outbox", () => {
	async function sendOne(text = "mine\n") {
		await write("docs/ai/note.md", text);
		await push(context());
	}

	it("folds a committed write into the lock, so the file is in step and a pull keeps it before the sync has read it", async () => {
		await sendOne();
		server.settle("w1", {
			status: "COMMITTED",
			sha: "a".repeat(40),
			ref: "main",
			fileCount: 1,
		});

		const result = await status(context());

		expect(result.settled.map((entry) => entry.status)).toEqual([
			"COMMITTED",
		]);
		const held = await lock();
		expect(held.outbox).toEqual([]);
		expect(held.files["docs/ai/note.md"]).toEqual({
			targetId: "t1",
			blobOid: gitBlobOid(encode("mine\n")),
			contentHash: sha256("mine\n"),
			origin: "push",
		});
		// The sync has not ingested the commit: the listing lacks the file.
		const pulledBefore = await pull(context());
		expect(await read("docs/ai/note.md")).toBe("mine\n");
		expect(pulledBefore.deleted).toEqual([]);
		// Once it has, the entry is the server's.
		server.set("docs/ai/note.md", "mine\n");
		await pull(context());
		expect((await lock()).files["docs/ai/note.md"]?.origin).toBe("pull");
	});

	it("folds a committed delete in by dropping the entry", async () => {
		server.set("docs/ai/note.md", "n\n");
		await pull(context());
		await rm(path.join(root, "docs", "ai", "note.md"));
		await push(context());
		server.settle("w1", {
			status: "COMMITTED",
			sha: "b".repeat(40),
			ref: "main",
			fileCount: 1,
		});

		await status(context());

		expect((await lock()).files["docs/ai/note.md"]).toBeUndefined();
	});

	it("reports a pull request with its link and keeps the file, until it is merged", async () => {
		await sendOne();
		server.settle("w1", {
			status: "PULL_REQUEST",
			sha: "a".repeat(40),
			ref: "main",
			branch: "fabric/memory/w1",
			url: "https://example.com/pr/1",
			externalId: "1",
			reason: "configured",
			fileCount: 1,
		});

		const open = await status(context());

		expect(open.pullRequests).toHaveLength(1);
		expect(open.pullRequests[0]).toMatchObject({
			url: "https://example.com/pr/1",
			status: "PULL_REQUEST",
		});
		expect(open.changes).toEqual([]);
		expect(await read("docs/ai/note.md")).toBe("mine\n");

		// Merged and ingested.
		server.set("docs/ai/note.md", "mine\n");
		const merged = await pull(context());

		expect(merged.pullRequests).toEqual([]);
		expect((await lock()).outbox).toEqual([]);
		expect((await lock()).files["docs/ai/note.md"]?.contentHash).toBe(
			sha256("mine\n"),
		);
	});

	it("keeps a conflict with the blob now at the path, never touches the local file, and does not resend", async () => {
		server.set("docs/ai/note.md", "v1\n");
		await pull(context());
		await write("docs/ai/note.md", "my edit\n");
		await push(context());
		server.set("docs/ai/note.md", "someone else\n");
		server.settle("w1", {
			status: "CONFLICT",
			paths: [
				{
					path: "docs/ai/note.md",
					code: "IF_MATCH_MISMATCH",
					currentOid: server.blobOf("docs/ai/note.md"),
				},
			],
		});

		const result = await status(context());

		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.paths[0]?.verdict).toEqual({
			code: "IF_MATCH_MISMATCH",
			currentOid: server.blobOf("docs/ai/note.md"),
		});
		expect(await read("docs/ai/note.md")).toBe("my edit\n");
		expect((await push(context())).skipped).toEqual([
			{ path: "docs/ai/note.md", reason: "unresolved-problem" },
		]);
		// The pull keeps the local edit and reports the same problem.
		const pulled = await pull(context());
		expect(pulled.kept).toEqual([
			{ path: "docs/ai/note.md", reason: "modified" },
		]);
		expect(pulled.problems).toHaveLength(1);
	});

	it("resolves a conflict when the person takes the server's version", async () => {
		server.set("docs/ai/note.md", "v1\n");
		await pull(context());
		await write("docs/ai/note.md", "my edit\n");
		await push(context());
		server.set("docs/ai/note.md", "someone else\n");
		server.settle("w1", {
			status: "CONFLICT",
			paths: [
				{
					path: "docs/ai/note.md",
					code: "IF_MATCH_MISMATCH",
					currentOid: "f".repeat(40),
				},
			],
		});
		await status(context());

		const result = await pull(context(), {
			acceptRemote: ["docs/ai/note.md"],
		});

		expect(await read("docs/ai/note.md")).toBe("someone else\n");
		expect(result.problems).toEqual([]);
	});

	it("resolves a conflict on a file the server removed since, when the person takes the server's version", async () => {
		server.set("docs/ai/note.md", "v1\n");
		await pull(context());
		await write("docs/ai/note.md", "my edit\n");
		await push(context());
		server.settle("w1", {
			status: "CONFLICT",
			paths: [
				{
					path: "docs/ai/note.md",
					code: "IF_MATCH_MISMATCH",
					currentOid: "f".repeat(40),
				},
			],
		});
		server.files.delete("docs/ai/note.md");
		expect((await pull(context())).kept).toEqual([
			{ path: "docs/ai/note.md", reason: "modified-and-removed" },
		]);

		const result = await pull(context(), {
			acceptRemote: ["docs/ai/note.md"],
		});

		expect(await read("docs/ai/note.md")).toBeNull();
		expect(result.deleted).toEqual(["docs/ai/note.md"]);
		expect(result.problems).toEqual([]);
		expect((await push(context())).sent).toEqual([]);
	});

	it("never removes a path outside the memory folders, whatever accept-remote names", async () => {
		server.set("docs/ai/note.md", "v1\n");
		await write("src/app.ts", "product code\n");

		await pull(context(), {
			acceptRemote: ["src/app.ts", "docs/ai/../../src/app.ts"],
		});

		expect(await read("src/app.ts")).toBe("product code\n");
	});

	it("keeps a refusal and a failure until dismissed, and a failure can be sent again", async () => {
		await sendOne();
		server.settle("w1", {
			status: "FAILED",
			code: "BRANCH_BUSY",
			retryable: true,
		});

		const failed = await status(context());

		expect(
			failed.problems.map((record) => [record.status, record.detail]),
		).toEqual([["FAILED", "BRANCH_BUSY"]]);
		expect((await push(context())).sent).toHaveLength(1);

		server.settle("w2", { status: "REFUSED", code: "NO_CHANGE" });
		const refused = await status(context());
		expect(refused.problems.map((record) => record.status)).toContain(
			"REFUSED",
		);

		const cleared = await status(context(), { clear: true });
		expect(cleared.cleared).toBeGreaterThan(0);
		expect(cleared.problems).toEqual([]);
	});

	it("drops a problem about content that has since changed", async () => {
		await sendOne("first\n");
		server.settle("w1", { status: "REFUSED", code: "PATH_REFUSED" });
		await status(context());
		await write("docs/ai/note.md", "second\n");

		const result = await status(context());

		expect(result.problems).toEqual([]);
		expect(result.changes.map((change) => change.path)).toEqual([
			"docs/ai/note.md",
		]);
	});

	it("leaves a write whose receipt the server no longer has in the outbox", async () => {
		await sendOne();
		server.receipts.set("w1", "missing");

		const result = await status(context());

		expect(result.pending).toBe(1);
	});

	it("keeps a pending write pending until the server settles it", async () => {
		await sendOne();

		const result = await status(context());

		expect(result.pending).toBe(1);
		expect(result.settled).toEqual([]);
	});

	it("settles the outbox first when a pull starts", async () => {
		await sendOne();
		server.settle("w1", {
			status: "COMMITTED",
			sha: "a".repeat(40),
			ref: "main",
			fileCount: 1,
		});

		const result = await pull(context());

		expect(result.settled.map((entry) => entry.status)).toEqual([
			"COMMITTED",
		]);
	});
});

describe("the lock", () => {
	it("refuses a lock of another project rather than mixing them", async () => {
		await writeMemoryLock(root, {
			version: 1,
			projectId: "someone-elses",
			files: {},
			outbox: [],
		});

		await expect(pull(context())).rejects.toThrow(/another project/);
	});

	it("refuses a damaged lock rather than guess", async () => {
		await mkdir(path.join(root, ".fabric"), { recursive: true });
		await writeFile(path.join(root, ".fabric", "memory.lock"), "{ nope");

		await expect(pull(context())).rejects.toThrow(/unreadable/);
	});
});

describe("the deadline", () => {
	it("stops work when the signal has aborted", async () => {
		server.set("docs/ai/a.md", "a\n");
		const controller = new AbortController();
		controller.abort(new Error("gave up"));

		await expect(
			pull(context({ signal: controller.signal })),
		).rejects.toThrow("gave up");
	});
});
