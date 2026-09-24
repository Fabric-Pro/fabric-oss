/**
 * The Living Memory sync's planner (design 2026-09-23 §4.3, §5.3.1 steps
 * 4–7): identities, collisions, the receipt's caps, prune eligibility and a
 * retry's key-to-path mapping. Pure functions; the activity's behaviour is
 * pinned in `__tests__/project-context-repository-sync-tree.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock(
	"@repo/database",
	async () =>
		await import(
			"@repo/database/prisma/queries/projects/context-source-path"
		),
);

import type { ContextInventoryEntry } from "../context-sync-inventory";
import {
	buildContextSyncPlan,
	type ContextIgnorePolicy,
	createPruneEligibility,
	ignorePolicyForEntry,
	ignorePolicyFromBytes,
	planContextTree,
	repositoryPathsForKeys,
	selectedPathShapes,
} from "../context-sync-plan";

const file = (
	path: string,
	overrides: Partial<ContextInventoryEntry> = {},
): ContextInventoryEntry => ({
	path,
	utf8: true,
	mode: "100644",
	type: "blob",
	oid: "0".repeat(40),
	...overrides,
});

function plan(
	paths: string[],
	entries: ContextInventoryEntry[],
	policies: Record<string, ContextIgnorePolicy> = {},
) {
	const shapes = selectedPathShapes(paths, entries);
	const map = new Map<string, ContextIgnorePolicy>(
		shapes
			.filter((s) => s.kind === "folder")
			.map((s) => [s.path, policies[s.path] ?? { kind: "defaults" }]),
	);
	return planContextTree({ paths, entries, shapes, policies: map });
}

describe("selectedPathShapes", () => {
	it("matches whole segments: docs never owns docs-archive", () => {
		expect(
			selectedPathShapes(["docs"], [file("docs-archive/a.md")]),
		).toEqual([{ path: "docs", kind: "missing" }]);
	});

	it("a selected path present only as a symlink is a present file", () => {
		const link = file("notes/glossary.md", { mode: "120000" });
		expect(selectedPathShapes(["notes/glossary.md"], [link])).toEqual([
			{ path: "notes/glossary.md", kind: "file", entry: link },
		]);
	});
});

describe("planContextTree", () => {
	it("makes both of two paths whose keys collide byte for byte invalid-path, and protects the key", () => {
		const composed = "docs/caf\u00e9.md";
		const decomposed = "docs/cafe\u0301.md";
		const result = plan(
			["docs"],
			[file(composed), file(decomposed), file("docs/ok.md")],
		);
		expect(result.candidates).toEqual([
			{ key: "docs/ok.md", repoPath: "docs/ok.md" },
		]);
		expect(result.attention).toEqual([
			{ key: composed, reason: "invalid-path" },
			{ key: decomposed, reason: "invalid-path" },
		]);
		expect([...result.protectedKeys]).toEqual([composed]);
	});

	it("never folds case: README.md and readme.md are two files", () => {
		const result = plan(
			["docs"],
			[file("docs/README.md"), file("docs/readme.md")],
		);
		expect(result.candidates.map((c) => c.key)).toEqual([
			"docs/README.md",
			"docs/readme.md",
		]);
	});

	it("refuses a backslash or a non-UTF-8 name as invalid-path, with no key to protect", () => {
		const result = plan(
			["docs"],
			[file("docs/a\\b.md"), file("docs/\ufffd.md", { utf8: false })],
		);
		expect(result.candidates).toEqual([]);
		expect(result.attention.map((a) => a.reason)).toEqual([
			"invalid-path",
			"invalid-path",
		]);
		expect(result.protectedKeys.size).toBe(0);
	});

	it("judges an ignored or wrong-type entry excluded before its name, as the CLI's walk does", () => {
		const result = plan(
			["docs"],
			[
				file("docs/node_modules/x\\y.md"),
				file("docs/link.md", { mode: "120000" }),
				file("docs/tool.sh", { mode: "100755" }),
			],
		);
		expect(result.attention).toEqual([]);
		expect(result.excludedCount).toBe(3);
	});

	it("judges a directly selected file by its basename against the default exclusions only", () => {
		const result = plan(
			["skills/guide.md", "notes/CLAUDE.md"],
			[file("skills/guide.md"), file("notes/CLAUDE.md")],
		);
		expect(result.candidates.map((c) => c.key)).toEqual([
			"skills/guide.md",
		]);
		expect(result.excludedCount).toBe(1);
	});

	it("an unreadable policy contributes its prefix and one attention item, and nothing under it", () => {
		const result = plan(
			["docs"],
			[
				file("docs/a.md"),
				file("docs/.contextignore", { mode: "120000" }),
			],
			{ docs: { kind: "unreadable" } },
		);
		expect(result).toMatchObject({
			candidates: [],
			excludedCount: 0,
			protectedPrefixes: ["docs/"],
			attention: [{ key: "docs", reason: "ignore-policy-unreadable" }],
		});
	});
});

describe("ignore policies", () => {
	it("reads only a regular blob; a symlink or a submodule is unreadable; none is the defaults", () => {
		expect(ignorePolicyForEntry(undefined)).toEqual({ kind: "defaults" });
		expect(ignorePolicyForEntry(file("docs/.contextignore"))).toBe("read");
		expect(
			ignorePolicyForEntry(
				file("docs/.contextignore", { mode: "120000" }),
			),
		).toEqual({ kind: "unreadable" });
		expect(
			ignorePolicyForEntry(
				file("docs/.contextignore", { mode: "160000", type: "commit" }),
			),
		).toEqual({ kind: "unreadable" });
	});

	it("an over-cap (null) or non-UTF-8 file is unreadable", () => {
		expect(ignorePolicyFromBytes(null)).toEqual({ kind: "unreadable" });
		expect(ignorePolicyFromBytes(Uint8Array.from([0xff]))).toEqual({
			kind: "unreadable",
		});
		expect(ignorePolicyFromBytes(Buffer.from("drafts/\n"))).toEqual({
			kind: "file",
			text: "drafts/\n",
		});
	});
});

describe("buildContextSyncPlan", () => {
	it("counts every attention item but keeps 100, each key cut to 200 characters", () => {
		const attention = Array.from({ length: 130 }, (_, i) => ({
			key: `${"k".repeat(250)}-${i}`,
			reason: "binary" as const,
		}));
		const receipt = buildContextSyncPlan({
			keptKeys: ["b.md", "a.md"],
			excludedCount: 2,
			attention,
			protectedKeys: new Set(["z.md", "y.md"]),
			protectedPrefixes: [],
			missingPaths: [],
		});
		expect(receipt.attentionCount).toBe(130);
		expect(receipt.attention).toHaveLength(100);
		expect(receipt.attention[0]?.key).toHaveLength(200);
		expect(receipt.keptKeys).toEqual(["a.md", "b.md"]);
		expect(receipt.keptCount).toBe(2);
		expect(receipt.protectedKeys).toEqual(["y.md", "z.md"]);
	});
});

describe("createPruneEligibility", () => {
	it("prunes only keys neither kept, protected, nor under a protected prefix", () => {
		const eligible = createPruneEligibility(
			buildContextSyncPlan({
				keptKeys: ["docs/a.md"],
				excludedCount: 0,
				attention: [],
				protectedKeys: new Set(["docs/big.md"]),
				protectedPrefixes: ["notes/"],
				missingPaths: [],
			}),
		);
		expect(eligible("docs/a.md")).toBe(false);
		expect(eligible("docs/big.md")).toBe(false);
		expect(eligible("notes/x.md")).toBe(false);
		expect(eligible("notes-archive/x.md")).toBe(true);
		expect(eligible("docs/old.md")).toBe(true);
	});

	it("the whole-repository prefix protects every key", () => {
		const eligible = createPruneEligibility(
			buildContextSyncPlan({
				keptKeys: [],
				excludedCount: 0,
				attention: [],
				protectedKeys: new Set(),
				protectedPrefixes: [""],
				missingPaths: [],
			}),
		);
		expect(eligible("anything/at/all.md")).toBe(false);
	});
});

describe("repositoryPathsForKeys", () => {
	it("maps each planned key back to its exact repository path", () => {
		const decomposed = "docs/cafe\u0301.md";
		expect(
			repositoryPathsForKeys(["docs/caf\u00e9.md"], [file(decomposed)]),
		).toEqual(new Map([["docs/caf\u00e9.md", decomposed]]));
	});

	it("is null when a planned key is missing, not a regular file, or ambiguous", () => {
		expect(repositoryPathsForKeys(["docs/a.md"], [])).toBeNull();
		expect(
			repositoryPathsForKeys(
				["docs/a.md"],
				[file("docs/a.md", { mode: "120000" })],
			),
		).toBeNull();
		expect(
			repositoryPathsForKeys(
				["docs/caf\u00e9.md"],
				[file("docs/caf\u00e9.md"), file("docs/cafe\u0301.md")],
			),
		).toBeNull();
	});
});
