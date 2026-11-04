/**
 * Which ticked folders' `.contextignore` Living Memory's configure dialog
 * reads, and what it makes of each answer: only a ticked folder's own file
 * counts, a listed folder or symbolic link there is a policy the run cannot
 * evaluate, and a truncated listing reads what it cannot rule out.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

import type { ContextRepositoryTreeEntry } from "../lib/context-selection";
import { indexRepositoryTree } from "../lib/repository-tree";
import {
	contextFolderPolicyOf,
	contextIgnoreReads,
} from "../useContextIgnorePolicies";

const ENTRIES: ContextRepositoryTreeEntry[] = [
	{ path: ".contextignore", type: "file" },
	{ path: "docs", type: "dir" },
	{ path: "docs/.contextignore", type: "file" },
	{ path: "docs/guide.md", type: "file" },
	{ path: "docs/api", type: "dir" },
	{ path: "docs/api/.contextignore", type: "file" },
	{ path: "notes", type: "dir" },
	{ path: "notes/n.md", type: "file" },
	{ path: "linked", type: "dir" },
	{ path: "linked/.contextignore", type: "file", regular: false },
	{ path: "nested", type: "dir" },
	{ path: "nested/.contextignore", type: "dir" },
];

function reads(paths: string[], truncated = false) {
	return contextIgnoreReads({
		tree: indexRepositoryTree(ENTRIES),
		truncated,
		paths,
	});
}

describe("contextIgnoreReads", () => {
	it("reads a ticked folder's own listed file, and only that folder's", () => {
		const plan = reads(["docs"]);
		// `docs/api/.contextignore` is not one the run reads for `docs`.
		expect(plan.read).toEqual(["docs"]);
		expect(plan.known.size).toBe(0);
	});

	it("reads the repository root's file when the whole repository is ticked", () => {
		expect(reads([""]).read).toEqual([""]);
	});

	it("reads nothing for a folder whose complete listing shows no file, or for a ticked file", () => {
		expect(reads(["notes", "docs/guide.md", "README.md"])).toEqual({
			read: [],
			known: new Map(),
		});
	});

	it("knows without reading that a symbolic link or a folder there cannot be applied", () => {
		const plan = reads(["linked", "nested"]);
		expect(plan.read).toEqual([]);
		expect(plan.known).toEqual(
			new Map([
				["linked", { kind: "unreadable", reason: "notRegular" }],
				["nested", { kind: "unreadable", reason: "notRegular" }],
			]),
		);
	});

	it("reads, under a truncated listing, every ticked folder it cannot rule out, in order", () => {
		const plan = reads(["notes", "unlisted", "docs/guide.md"], true);
		expect(plan.read).toEqual(["notes", "unlisted"]);
	});
});

describe("contextFolderPolicyOf", () => {
	it("maps each answer to the policy the rows are judged by", () => {
		expect(contextFolderPolicyOf({ state: "absent" })).toEqual({
			kind: "defaults",
		});
		expect(
			contextFolderPolicyOf({ state: "rules", text: "drafts/\n" }),
		).toEqual({ kind: "rules", text: "drafts/\n" });
		expect(contextFolderPolicyOf({ state: "tooLarge" })).toEqual({
			kind: "unreadable",
			reason: "tooLarge",
		});
		expect(contextFolderPolicyOf({ state: "encoding" })).toEqual({
			kind: "unreadable",
			reason: "encoding",
		});
		expect(
			contextFolderPolicyOf({ state: "ruleRejected", line: 4 }),
		).toEqual({ kind: "rejected", line: 4 });
	});
});
