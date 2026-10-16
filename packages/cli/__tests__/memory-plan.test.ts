import { describe, expect, it } from "vitest";
import type { MemoryLock, MemoryLockEntry } from "../src/lib/memory/lock.js";
import { planPull, planPush, type RemoteFile } from "../src/lib/memory/plan.js";

const lockOf = (
	files: Record<string, Partial<MemoryLockEntry>> = {},
	outbox: MemoryLock["outbox"] = [],
): MemoryLock => ({
	version: 1,
	projectId: "p",
	files: Object.fromEntries(
		Object.entries(files).map(([path, entry]) => [
			path,
			{
				targetId: "t",
				blobOid: "b1",
				contentHash: "h1",
				origin: "pull",
				...entry,
			},
		]),
	),
	outbox,
});

const remote = (
	path: string,
	hash: string | null,
	blob: string | null = "b1",
): RemoteFile => ({
	path,
	targetId: "t",
	blobOid: blob,
	contentHash: hash,
	bytes: 1,
});

const none = new Set<string>();

describe("planPull", () => {
	it("writes what is new, replaces what is untouched and changed, and leaves what is the same", () => {
		const actions = planPull({
			remote: [
				remote("a", "h1"),
				remote("b", "h2", "b2"),
				remote("c", "h1"),
			],
			local: new Map([
				["b", "h1"],
				["c", "h1"],
			]),
			lock: lockOf({ b: {}, c: {} }),
			tracked: none,
			acceptRemote: none,
		});

		expect(
			actions.map((a) => [a.kind, "file" in a ? a.file.path : a.path]),
		).toEqual([
			["write", "a"],
			["write", "b"],
		]);
	});

	it("records the blob of an unchanged file the lock had no blob for", () => {
		const actions = planPull({
			remote: [remote("a", "h1", "b9")],
			local: new Map([["a", "h1"]]),
			lock: lockOf({ a: { blobOid: null } }),
			tracked: none,
			acceptRemote: none,
		});

		expect(actions).toEqual([
			{ kind: "adopt", file: remote("a", "h1", "b9") },
		]);
	});

	it("turns a pushed file into the server's once the listing shows it", () => {
		const actions = planPull({
			remote: [remote("a", "h1", "b1")],
			local: new Map([["a", "h1"]]),
			lock: lockOf({ a: { origin: "push" } }),
			tracked: none,
			acceptRemote: none,
		});

		expect(actions.map((a) => a.kind)).toEqual(["adopt"]);
	});

	it("keeps a pushed file the listing does not show yet", () => {
		const actions = planPull({
			remote: [],
			local: new Map([["a", "h1"]]),
			lock: lockOf({ a: { origin: "push" } }),
			tracked: none,
			acceptRemote: none,
		});

		expect(actions).toEqual([]);
	});

	it("forgets a file gone on both sides", () => {
		expect(
			planPull({
				remote: [],
				local: new Map(),
				lock: lockOf({ a: {} }),
				tracked: none,
				acceptRemote: none,
			}),
		).toEqual([{ kind: "forget", path: "a" }]);
	});

	it("leaves tracked paths to git whatever else is true", () => {
		const actions = planPull({
			remote: [remote("a", "h2", "b2")],
			local: new Map(),
			lock: lockOf(),
			tracked: new Set(["a"]),
			acceptRemote: none,
		});

		expect(actions).toEqual([{ kind: "tracked", path: "a" }]);
	});

	it("does not touch a file you edited even when the server's version is the one you started from", () => {
		const actions = planPull({
			remote: [remote("a", "h1")],
			local: new Map([["a", "mine"]]),
			lock: lockOf({ a: {} }),
			tracked: none,
			acceptRemote: none,
		});

		expect(actions).toEqual([
			{ kind: "keep", path: "a", reason: "modified" },
		]);
	});
});

describe("planPush", () => {
	const target = { id: "t", folder: "docs/ai" };

	it("sends new, changed and deleted files, in path order, and nothing that is in step", () => {
		const plan = planPush({
			targets: [target],
			local: new Map([
				["docs/ai/z.md", "h1"],
				["docs/ai/n.md", "hn"],
				["docs/ai/m.md", "h2"],
			]),
			lock: lockOf({
				"docs/ai/z.md": {},
				"docs/ai/m.md": { blobOid: "bm" },
				"docs/ai/gone.md": { blobOid: "bg" },
			}),
			tracked: none,
		});

		expect(plan.changes).toEqual([
			{
				path: "docs/ai/gone.md",
				targetId: "t",
				kind: "deleted",
				ifMatchOid: "bg",
			},
			{
				path: "docs/ai/m.md",
				targetId: "t",
				kind: "modified",
				ifMatchOid: "bm",
				contentHash: "h2",
			},
			{
				path: "docs/ai/n.md",
				targetId: "t",
				kind: "new",
				contentHash: "hn",
			},
		]);
	});

	it("cannot name a version it was never told", () => {
		const plan = planPush({
			targets: [target],
			local: new Map([["docs/ai/m.md", "h2"]]),
			lock: lockOf({
				"docs/ai/m.md": { blobOid: null },
				"docs/ai/g.md": { blobOid: null },
			}),
			tracked: none,
		});

		expect(plan.changes).toEqual([]);
		expect(plan.skipped.map((s) => s.reason)).toEqual([
			"version-unknown",
			"version-unknown",
		]);
	});

	it("ignores files outside every folder", () => {
		const plan = planPush({
			targets: [target],
			local: new Map([
				["docs/other/x.md", "h"],
				["docs/ai-archive/x.md", "h"],
			]),
			lock: lockOf(),
			tracked: none,
		});

		expect(plan.changes).toEqual([]);
	});

	it("resends a failed write but not a refused or conflicted one", () => {
		const record = (status: "FAILED" | "REFUSED" | "CONFLICT") => ({
			writeId: "w",
			targetId: "t",
			folder: "docs/ai",
			submittedAt: "2026-10-16T00:00:00Z",
			status,
			paths: [
				{
					path: "docs/ai/n.md",
					op: "PUT" as const,
					contentHash: "hn",
					newBlobOid: null,
				},
			],
		});
		const run = (status: "FAILED" | "REFUSED" | "CONFLICT") =>
			planPush({
				targets: [target],
				local: new Map([["docs/ai/n.md", "hn"]]),
				lock: lockOf({}, [record(status)]),
				tracked: none,
			});

		expect(run("FAILED").changes).toHaveLength(1);
		expect(run("REFUSED").changes).toHaveLength(0);
		expect(run("CONFLICT").skipped[0]?.reason).toBe("unresolved-problem");
	});
});
