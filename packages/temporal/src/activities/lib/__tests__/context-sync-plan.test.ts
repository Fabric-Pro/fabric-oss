/**
 * The Living Memory sync's planner (design 2026-09-23 §4.3, §5.3.1 steps
 * 4–7): identities, collisions, the receipt's caps, prune eligibility and a
 * retry's key-to-path mapping, and the member's left-out paths (Fizzy #2750
 * §5.5). Pure functions; the activity's behaviour is pinned in
 * `__tests__/project-context-repository-sync-tree.test.ts`.
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
	excludedPaths: string[] = [],
) {
	const shapes = selectedPathShapes(paths, entries);
	const map = new Map<string, ContextIgnorePolicy>(
		shapes
			.filter((s) => s.kind === "folder")
			.map((s) => [s.path, policies[s.path] ?? { kind: "defaults" }]),
	);
	return planContextTree({
		paths,
		excludedPaths,
		entries,
		shapes,
		policies: map,
	});
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

	it("excludes a directly selected .fabric file, in any case, from a stored configuration", () => {
		const result = plan(
			[
				".fabric/notes.md",
				".FABRIC/x.md",
				"docs/.Fabric/state.json",
				"docs/guide.md",
			],
			[
				file(".fabric/notes.md"),
				file(".FABRIC/x.md"),
				file("docs/.Fabric/state.json"),
				file("docs/guide.md"),
			],
		);
		expect(result.candidates.map((c) => c.key)).toEqual(["docs/guide.md"]);
		expect(result.excludedCount).toBe(3);
		expect(result.attention).toEqual([]);
	});

	it("excludes everything under a selected folder that is, or is inside, .fabric", () => {
		const result = plan(
			[".FABRIC", "docs/.fabric/state"],
			[
				file(".FABRIC/x.md"),
				file(".FABRIC/sub/y.md"),
				file("docs/.fabric/state/z.md"),
			],
		);
		expect(result.candidates).toEqual([]);
		expect(result.excludedCount).toBe(3);
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

describe("planContextTree, the member's left-out paths (Fizzy #2750 §5.5)", () => {
	it("leaves out an excluded file and everything under an excluded folder — whole segments, case-sensitive — counting them excluded", () => {
		const result = plan(
			["docs"],
			[
				file("docs/a.md"),
				file("docs/drafts/x.md"),
				file("docs/drafts/deep/y.md"),
				file("docs/drafts-2/z.md"),
				file("docs/Drafts/w.md"),
				file("docs/old.md"),
				file("docs/old.md.bak.md"),
			],
			{},
			["docs/drafts", "docs/old.md"],
		);
		expect(result.candidates.map((c) => c.key)).toEqual([
			"docs/Drafts/w.md",
			"docs/a.md",
			"docs/drafts-2/z.md",
			"docs/old.md.bak.md",
		]);
		expect(result.excludedCount).toBe(3);
		expect(result.excludedKeys).toEqual(["docs/drafts", "docs/old.md"]);
		expect(result.attention).toEqual([]);
		expect(result.protectedKeys.size).toBe(0);
	});

	it("compares storage keys, never raw bytes: one NFC exclusion leaves out NFC and NFD repository paths", () => {
		const result = plan(
			["docs"],
			[
				file("docs/caf\u00e9/a.md"),
				file("docs/cafe\u0301/b.md"),
				file("docs/keep.md"),
			],
			{},
			["docs/caf\u00e9"],
		);
		expect(result.candidates.map((c) => c.key)).toEqual(["docs/keep.md"]);
		expect(result.excludedCount).toBe(2);
		expect(result.attention).toEqual([]);
	});

	it("keeps a selected folder whose contents are all left out present: it is not a missing path", () => {
		const entries = [file("docs/drafts/x.md"), file("docs/old.md")];
		expect(selectedPathShapes(["docs"], entries)).toEqual([
			{ path: "docs", kind: "folder" },
		]);
		const result = plan(["docs"], entries, {}, [
			"docs/drafts",
			"docs/old.md",
		]);
		expect(result).toMatchObject({
			candidates: [],
			excludedCount: 2,
			missingPaths: [],
			attention: [],
		});
	});

	it("an exclusion under a selected path that is a FILE is dormant: the file is kept and nothing is frozen", () => {
		const result = plan(
			["docs/a.md", "notes"],
			[file("docs/a.md"), file("notes/n.md")],
			{},
			["docs/a.md/x"],
		);
		expect(result.candidates.map((c) => c.key)).toEqual([
			"docs/a.md",
			"notes/n.md",
		]);
		expect(result.excludedCount).toBe(0);
		expect(result.excludedKeys).toEqual([]);
	});

	it("beats an unreadable policy: what is left out is counted excluded, the rest stays behind the protected prefix", () => {
		const result = plan(
			["docs"],
			[
				file("docs/.contextignore", { mode: "120000" }),
				file("docs/a.md"),
				file("docs/drafts/x.md"),
				file("docs/drafts/link.md", { mode: "120000" }),
			],
			{ docs: { kind: "unreadable" } },
			["docs/drafts"],
		);
		expect(result).toMatchObject({
			candidates: [],
			excludedCount: 2,
			protectedPrefixes: ["docs/"],
			attention: [{ key: "docs", reason: "ignore-policy-unreadable" }],
			excludedKeys: ["docs/drafts"],
		});
		expect(result.protectedKeys.size).toBe(0);
	});

	it("finds a key collision before anything is left out or short-circuited: the key stays protected, with attention", () => {
		const composed = "docs/drafts/caf\u00e9.md";
		const decomposed = "docs/drafts/cafe\u0301.md";
		const readable: Record<string, ContextIgnorePolicy> = {};
		const unreadable: Record<string, ContextIgnorePolicy> = {
			docs: { kind: "unreadable" },
		};
		for (const policies of [readable, unreadable]) {
			const result = plan(
				["docs"],
				[file(composed), file(decomposed), file("docs/drafts/x.md")],
				policies,
				["docs/drafts"],
			);
			expect(result.candidates).toEqual([]);
			expect(
				result.attention.filter((a) => a.reason === "invalid-path"),
			).toEqual([
				{ key: composed, reason: "invalid-path" },
				{ key: decomposed, reason: "invalid-path" },
			]);
			expect([...result.protectedKeys]).toEqual([composed]);
			// The two colliding paths are attention, not exclusions.
			expect(result.excludedCount).toBe(1);

			const eligible = createPruneEligibility(
				buildContextSyncPlan({
					keptKeys: [],
					excludedCount: result.excludedCount,
					attention: result.attention,
					protectedKeys: result.protectedKeys,
					protectedPrefixes: result.protectedPrefixes,
					missingPaths: result.missingPaths,
					excludedKeys: result.excludedKeys,
				}),
			);
			expect(eligible(composed)).toBe(false);
			expect(eligible("docs/drafts/x.md")).toBe(true);
		}
	});

	describe("a collision is found over the whole owned inventory, before any filter (§5.5)", () => {
		const composed = "docs/café.md";
		const decomposed = "docs/café.md";

		/** The plan's prune verdict on a key, as the run would freeze it. */
		const pruneEligible = (
			result: ReturnType<typeof plan>,
			keptKeys: string[] = result.candidates.map((c) => c.key),
		) =>
			createPruneEligibility(
				buildContextSyncPlan({
					keptKeys,
					excludedCount: result.excludedCount,
					attention: result.attention,
					protectedKeys: result.protectedKeys,
					protectedPrefixes: result.protectedPrefixes,
					missingPaths: result.missingPaths,
					excludedKeys: result.excludedKeys,
				}),
			);

		const cases: Array<{
			name: string;
			/** The key both entries share. */
			key: string;
			entries: ContextInventoryEntry[];
			policies?: Record<string, ContextIgnorePolicy>;
		}> = [
			{
				name: "a symlink",
				key: composed,
				entries: [
					file(composed),
					file(decomposed, { mode: "120000" }),
					file("docs/keep.md"),
				],
			},
			{
				// The ASCII spelling is the canonical key and matches the
				// default `skills/` rule; the KELVIN SIGN twin normalizes to
				// the same key but no default rule matches its raw bytes.
				name: "default-ignored",
				key: "docs/sKills/x.md",
				entries: [
					file("docs/sKills/x.md"),
					file("docs/sKills/x.md"),
					file("docs/keep.md"),
				],
			},
			{
				// Text extensions are ASCII and NFC keeps them, so a twin can
				// be non-text only when both spellings are.
				name: "non-text",
				key: "docs/café.png",
				entries: [
					file("docs/café.png"),
					file("docs/café.png"),
					file("docs/keep.md"),
				],
			},
			{
				name: "beneath an unreadable policy",
				key: composed,
				entries: [
					file(composed),
					file(decomposed, { mode: "120000" }),
					file("docs/keep.md"),
				],
				policies: { docs: { kind: "unreadable" } },
			},
		];

		for (const { name, key, entries, policies } of cases) {
			it(`keeps the key protected, with attention, when the twin is ${name} and the key is left out`, () => {
				const result = plan(["docs"], entries, policies ?? {}, [key]);
				expect(result.candidates.map((c) => c.key)).not.toContain(key);
				expect([...result.protectedKeys]).toEqual([key]);
				expect(
					result.attention.filter((a) => a.reason === "invalid-path"),
				).toEqual(
					entries
						.filter((e) => e.path !== "docs/keep.md")
						.map((e) => ({ key: e.path, reason: "invalid-path" })),
				);
				// The managed row is kept with attention, never pruned.
				expect(pruneEligible(result)(key)).toBe(false);
			});
		}

		it("changes a plan without left-out paths only by the collision's own attention and protection", () => {
			const result = plan(
				["docs"],
				[
					file(composed),
					file(decomposed, { mode: "120000" }),
					file("docs/keep.md"),
					file("docs/link.md", { mode: "120000" }),
					file("docs/logo.png"),
				],
			);
			expect(result.candidates).toEqual([
				{ key: "docs/keep.md", repoPath: "docs/keep.md" },
			]);
			expect(result.attention).toEqual([
				{ key: composed, reason: "invalid-path" },
				{ key: decomposed, reason: "invalid-path" },
			]);
			expect([...result.protectedKeys]).toEqual([composed]);
			// The unrelated symlink and non-text file are excluded as ever.
			expect(result.excludedCount).toBe(2);
			expect(result.excludedKeys).toEqual([]);
			const eligible = pruneEligible(result);
			expect(eligible(composed)).toBe(false);
			expect(eligible("docs/keep.md")).toBe(false);
			expect(eligible("docs/gone.md")).toBe(true);
		});
	});

	it("reads each selected folder's policy as ever: it still governs what is not left out", () => {
		const result = plan(
			["docs"],
			[
				file("docs/.contextignore"),
				file("docs/a.md"),
				file("docs/b.tmp.md"),
				file("docs/drafts/c.md"),
			],
			{ docs: { kind: "file", text: "*.tmp.md\n" } },
			["docs/drafts"],
		);
		expect(result.candidates.map((c) => c.key)).toEqual(["docs/a.md"]);
		// The policy file (a default exclusion), the ignored file, the draft.
		expect(result.excludedCount).toBe(3);
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

	it("freezes the left-out keys, sorted, beside the kept and protected keys (Fizzy #2750 §5.5)", () => {
		const receipt = buildContextSyncPlan({
			keptKeys: [],
			excludedCount: 0,
			attention: [],
			protectedKeys: new Set(),
			protectedPrefixes: [],
			missingPaths: [],
			excludedKeys: ["docs/old.md", "docs/drafts"],
		});
		expect(receipt.excludedKeys).toEqual(["docs/drafts", "docs/old.md"]);
		expect(
			buildContextSyncPlan({
				keptKeys: [],
				excludedCount: 0,
				attention: [],
				protectedKeys: new Set(),
				protectedPrefixes: [],
				missingPaths: [],
			}).excludedKeys,
		).toEqual([]);
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

	it("a left-out key, or one under it, is eligible even under a protected prefix — never when kept or protected by key (Fizzy #2750 §5.5)", () => {
		const eligible = createPruneEligibility(
			buildContextSyncPlan({
				keptKeys: ["docs/drafts/kept.md"],
				excludedCount: 0,
				attention: [],
				protectedKeys: new Set(["docs/drafts/caf\u00e9.md"]),
				protectedPrefixes: ["docs/"],
				missingPaths: [],
				excludedKeys: ["docs/drafts", "docs/old.md"],
			}),
		);
		expect(eligible("docs/drafts")).toBe(true);
		expect(eligible("docs/drafts/x.md")).toBe(true);
		expect(eligible("docs/drafts/deep/y.md")).toBe(true);
		expect(eligible("docs/old.md")).toBe(true);
		expect(eligible("docs/drafts/kept.md")).toBe(false);
		expect(eligible("docs/drafts/caf\u00e9.md")).toBe(false);
		// Protection still guards every key not explicitly left out.
		expect(eligible("docs/other.md")).toBe(false);
		expect(eligible("docs/drafts-2/x.md")).toBe(false);
		expect(eligible("docs/old.md.bak")).toBe(false);
		expect(eligible("docs/Drafts/x.md")).toBe(false);
	});

	it("a left-out key beats the whole-repository prefix too", () => {
		const eligible = createPruneEligibility(
			buildContextSyncPlan({
				keptKeys: [],
				excludedCount: 0,
				attention: [],
				protectedKeys: new Set(),
				protectedPrefixes: [""],
				missingPaths: [],
				excludedKeys: ["drafts"],
			}),
		);
		expect(eligible("drafts/x.md")).toBe(true);
		expect(eligible("a.md")).toBe(false);
	});

	it("a plan written before left-out paths existed leaves nothing out", () => {
		const historical = {
			keptCount: 0,
			excludedCount: 0,
			attentionCount: 0,
			attention: [],
			protectedPrefixes: ["docs/"],
			missingPaths: [],
			keptKeys: [],
			protectedKeys: [],
		};
		expect(createPruneEligibility(historical)("docs/drafts/x.md")).toBe(
			false,
		);
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
