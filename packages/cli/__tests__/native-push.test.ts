import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenInstructionProposal } from "@fabricorg/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { changedTrackedPaths } from "../src/lib/instructions/git.js";
import { computeNativePushPlan } from "../src/lib/instructions/native-push-plan.js";
import {
	materializePushChanges,
	setAsideProposed,
} from "../src/lib/instructions/push.js";

const roots: string[] = [];
function git(root: string, args: string[]) {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
}
async function checkout() {
	const root = await mkdtemp(path.join(tmpdir(), "fabric-native-push-"));
	roots.push(root);
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	git(root, ["config", "core.autocrlf", "true"]);
	await writeFile(path.join(root, "AGENTS.md"), "# Instructions\r\n");
	await writeFile(path.join(root, "unrelated.txt"), "source\r\n");
	git(root, ["add", "--all"]);
	git(root, ["commit", "-m", "Fixture"]);
	return root;
}
async function plan(root: string, added?: string[]) {
	const changed = await changedTrackedPaths(root, Date.now() + 10_000);
	expect(changed.kind).toBe("ok");
	if (changed.kind !== "ok") throw new Error("Fixture Git diff failed");
	return computeNativePushPlan({
		root,
		files: [{ path: "AGENTS.md", kind: "INSTRUCTIONS" }],
		changedPaths: changed.value,
		added,
	});
}
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

describe("native Git proposal planning", () => {
	it("refuses an oversized changed-path list instead of omitting late instruction edits", async () => {
		const root = await checkout();
		const paths = Array.from(
			{ length: 1_000 },
			(_, index) =>
				`${String(index).padStart(4, "0")}-${"x".repeat(80)}.md`,
		);
		paths.push("z-AGENTS.md");
		await Promise.all(
			paths.map((file) =>
				writeFile(path.join(root, file), "original\r\n"),
			),
		);
		git(root, ["add", "--all"]);
		git(root, ["commit", "-m", "Many tracked paths"]);
		await Promise.all(
			paths.map((file) =>
				writeFile(path.join(root, file), "changed\r\n"),
			),
		);
		const result = await changedTrackedPaths(root, Date.now() + 10_000);
		expect(result.kind).toBe("unavailable");
		if (result.kind === "unavailable") {
			expect(result.reason).toBe(
				"git output exceeded the supported size",
			);
		}
	});
	it("ignores checkout CRLF conversion and explicit unchanged additions", async () => {
		const root = await checkout();
		expect(await plan(root, ["AGENTS.md"])).toEqual({
			entries: [],
			unchanged: ["AGENTS.md"],
		});
	});
	it("selects working-tree edits only from the instruction listing and preserves the index", async () => {
		const root = await checkout();
		await writeFile(path.join(root, "AGENTS.md"), "staged\r\n");
		git(root, ["add", "AGENTS.md"]);
		await writeFile(path.join(root, "AGENTS.md"), "unstaged\r\n");
		await writeFile(path.join(root, "unrelated.txt"), "unrelated edit\r\n");
		const index = await readFile(path.join(root, ".git", "index"));
		const status = git(root, ["status", "--porcelain=v2"]);
		const planned = await plan(root);
		expect(planned.entries.map((entry) => entry.path)).toEqual([
			"AGENTS.md",
		]);
		expect(
			await materializePushChanges({ root, entries: planned.entries }),
		).toEqual([
			{
				op: "put",
				path: "AGENTS.md",
				content: "unstaged\r\n",
				encoding: "utf8",
			},
		]);
		expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
		expect(git(root, ["status", "--porcelain=v2"])).toBe(status);
	});
	it("requires explicit new paths and refuses a deletion that reappeared", async () => {
		const root = await checkout();
		await writeFile(path.join(root, "new.md"), "new\n");
		expect((await plan(root)).entries).toEqual([]);
		expect((await plan(root, ["new.md"])).entries).toMatchObject([
			{ path: "new.md", action: "put" },
		]);
		await rm(path.join(root, "AGENTS.md"));
		const planned = await plan(root);
		expect(planned.entries).toEqual([
			{ path: "AGENTS.md", action: "delete" },
		]);
		await writeFile(path.join(root, "AGENTS.md"), "");
		await expect(
			materializePushChanges({ root, entries: planned.entries }),
		).rejects.toThrow("reappeared");
	});
	it("skips only live native proposals at the exact Git pin and hash", async () => {
		const root = await checkout();
		await writeFile(path.join(root, "AGENTS.md"), "changed\n");
		const planned = await plan(root);
		const entry = planned.entries[0];
		if (entry?.action !== "put")
			throw new Error("Fixture must select a put");
		const nativeBase = { generation: 7, commitSha: "a".repeat(40) };
		const proposal: OpenInstructionProposal = {
			kind: "native",
			operationId: "native-receipt",
			nativeBase,
			status: "READY",
			pullRequest: {
				state: "OPEN",
				url: "https://example.invalid/pull/1",
			},
			changes: [{ path: entry.path, op: "put", sha256: entry.sha256 }],
		};
		expect(
			setAsideProposed(planned, [proposal], nativeBase).plan.entries,
		).toEqual([]);
		for (const other of [
			{ generation: 8, commitSha: nativeBase.commitSha },
			{ generation: 7, commitSha: "b".repeat(40) },
		]) {
			expect(
				setAsideProposed(planned, [proposal], other).plan.entries,
			).toEqual(planned.entries);
		}
		expect(
			setAsideProposed(
				planned,
				[
					{
						...proposal,
						changes: [
							{
								path: entry.path,
								op: "put",
								sha256: "b".repeat(64),
							},
						],
					},
				],
				nativeBase,
			).plan.entries,
		).toEqual(planned.entries);
	});
});
