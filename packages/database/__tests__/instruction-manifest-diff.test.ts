/**
 * `diffInstructionManifests` — what changed between the coding-instruction
 * snapshot an agent last installed and the one published now.
 *
 * The rule is small and the consequences are not: a connected agent asks for
 * this instead of re-downloading the whole tree, so a path the diff forgets is
 * a skill or rule that silently never reaches the agent's working copy.
 *
 * The diff rule itself is pure — two manifests in, three lists out — so the
 * first suite needs no database. The second suite covers the query that loads
 * those manifests, `getInstructionManifestDiff`, and asserts the part a mocked
 * caller cannot: that both tenant columns are in every WHERE clause, so a row
 * naming this project while carrying another organization is never read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
	snapshotFindFirst: vi.fn(),
	fileFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		projectInstructionSnapshot: { findFirst: prisma.snapshotFindFirst },
		projectInstructionFile: { findMany: prisma.fileFindMany },
	},
	Prisma: {},
}));

import {
	diffInstructionManifests,
	getInstructionManifestDiff,
} from "../prisma/queries/instructions";

/** A manifest entry, written the way the query selects it. */
function file(path: string, sha256: string, mode?: number | null) {
	return { path, sha256, mode };
}

describe("diffInstructionManifests", () => {
	it("reports a path only the head has as added", () => {
		expect(
			diffInstructionManifests(
				[file("AGENTS.md", "a")],
				[
					file("AGENTS.md", "a"),
					file(".claude/skills/x/SKILL.md", "b"),
				],
			),
		).toEqual({
			added: [".claude/skills/x/SKILL.md"],
			removed: [],
			changed: [],
		});
	});

	it("reports a path only the base has as removed", () => {
		expect(
			diffInstructionManifests(
				[file("AGENTS.md", "a"), file("CLAUDE.md", "b")],
				[file("AGENTS.md", "a")],
			),
		).toEqual({ added: [], removed: ["CLAUDE.md"], changed: [] });
	});

	// The case a path-only diff would miss entirely: same file, new content.
	it("reports a path both sides have at a different sha256 as changed", () => {
		expect(
			diffInstructionManifests(
				[file("AGENTS.md", "old")],
				[file("AGENTS.md", "new")],
			),
		).toEqual({ added: [], removed: [], changed: ["AGENTS.md"] });
	});

	it("reports nothing for two identical manifests", () => {
		const manifest = [file("AGENTS.md", "a"), file("CLAUDE.md", "b")];
		expect(diffInstructionManifests(manifest, manifest)).toEqual({
			added: [],
			removed: [],
			changed: [],
		});
	});

	it("reports every added path when the base is empty", () => {
		expect(
			diffInstructionManifests(
				[],
				[file("CLAUDE.md", "a"), file("AGENTS.md", "b")],
			),
		).toEqual({
			added: ["AGENTS.md", "CLAUDE.md"],
			removed: [],
			changed: [],
		});
	});

	it("reports nothing at all for two empty manifests", () => {
		expect(diffInstructionManifests([], [])).toEqual({
			added: [],
			removed: [],
			changed: [],
		});
	});

	// A caller diffing two responses of its own needs a stable order; the row
	// order the database happens to return is not one.
	it("sorts each list, whatever order the rows arrived in", () => {
		expect(
			diffInstructionManifests(
				[
					file("z-gone.md", "1"),
					file("a-gone.md", "2"),
					file("m-same.md", "3"),
					file("z-edit.md", "4"),
					file("a-edit.md", "5"),
				],
				[
					file("m-same.md", "3"),
					file("z-edit.md", "4-new"),
					file("a-edit.md", "5-new"),
					file("z-new.md", "6"),
					file("a-new.md", "7"),
				],
			),
		).toEqual({
			added: ["a-new.md", "z-new.md"],
			removed: ["a-gone.md", "z-gone.md"],
			changed: ["a-edit.md", "z-edit.md"],
		});
	});

	// Fizzy #2671: modes are now part of the digest, so a mode-only republish
	// (a chmod committed with no content change) is a real tree change and
	// must not read as `unchanged: []` here either — the same rule
	// `computeSnapshotDigest` applies.
	it("reports a path whose mode differs, even when sha256 matches, as changed", () => {
		expect(
			diffInstructionManifests(
				[file("scripts/run.sh", "same", 0o644)],
				[file("scripts/run.sh", "same", 0o755)],
			),
		).toEqual({ added: [], removed: [], changed: ["scripts/run.sh"] });
	});

	// `null`, `undefined` and `0o644` are all "no mode recorded" — the same
	// normalisation `computeSnapshotDigest` and `treesEqual` use — so none of
	// them may report a change against each other.
	it("does not report null vs 0o644 (or a missing field) as a mode change", () => {
		expect(
			diffInstructionManifests(
				[file("AGENTS.md", "same", null)],
				[file("AGENTS.md", "same", 0o644)],
			),
		).toEqual({ added: [], removed: [], changed: [] });
		expect(
			diffInstructionManifests(
				[{ path: "AGENTS.md", sha256: "same" }],
				[file("AGENTS.md", "same", null)],
			),
		).toEqual({ added: [], removed: [], changed: [] });
	});

	// Review round 2 (Fizzy #2671): the wire contract admits a full `st_mode`
	// — `isAllowedMode` (`packages/cli/src/lib/instructions/safe-write.ts`)
	// masks with `& 0o7777` and explicitly accepts e.g. `0o100644` — and the
	// installer applies both representations identically. A diff that told
	// them apart would report `changed` for two manifests describing the
	// same tree.
	it("does not report a full st_mode against its bare permission bits as changed", () => {
		expect(
			diffInstructionManifests(
				[file("AGENTS.md", "same", 0o644)],
				[file("AGENTS.md", "same", 0o100644)],
			),
		).toEqual({ added: [], removed: [], changed: [] });
		expect(
			diffInstructionManifests(
				[file("scripts/run.sh", "same", 0o755)],
				[file("scripts/run.sh", "same", 0o100755)],
			),
		).toEqual({ added: [], removed: [], changed: [] });
	});

	it("still reports a real permission difference under a full st_mode", () => {
		expect(
			diffInstructionManifests(
				[file("scripts/run.sh", "same", 0o100644)],
				[file("scripts/run.sh", "same", 0o100755)],
			),
		).toEqual({ added: [], removed: [], changed: ["scripts/run.sh"] });
	});
});

/**
 * `getInstructionManifestDiff` — the tenant filters, which are the half a
 * mocked caller cannot check.
 *
 * `ProjectInstructionFile`'s foreign key binds `(snapshotId, projectId)` only,
 * so a row carrying another tenant's `organizationId` satisfies the constraint
 * and comes back from a query that names the snapshot alone. The same is true
 * of the base snapshot lookup: `projectId` narrows it, but only
 * `organizationId` says whose it is. Both columns therefore belong in the
 * WHERE clause, not in a check afterwards — a mismatch has to be
 * indistinguishable from an unknown base, or the caller learns that a snapshot
 * it may not see exists.
 *
 * The fake below honours the `organizationId` filter it is given, so these
 * assert the behaviour and not just the shape of the query.
 */
describe("getInstructionManifestDiff tenant scoping", () => {
	const HOST_ORG = "org-example-host";
	const OTHER_ORG = "org-example-other";

	/**
	 * A database holding one READY base snapshot, owned by `ownerOrg`, whose
	 * file rows are likewise owned by `ownerOrg`. Both fakes apply the
	 * `organizationId` and `projectId` filters they are handed.
	 */
	function databaseHolding(ownerOrg: string) {
		prisma.snapshotFindFirst.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) =>
				where.projectId === "proj_1" &&
				where.organizationId === ownerOrg &&
				where.digest === "digest_base" &&
				where.status === "READY"
					? {
							id: "snap_base",
							version: 8,
							files: [{ path: "AGENTS.md", sha256: "old" }],
						}
					: null,
		);
		prisma.fileFindMany.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) =>
				where.snapshotId === "snap_head" &&
				where.projectId === "proj_1" &&
				where.organizationId === ownerOrg
					? [{ path: "AGENTS.md", sha256: "new" }]
					: [],
		);
	}

	function diffAsHost() {
		return getInstructionManifestDiff({
			projectId: "proj_1",
			organizationId: HOST_ORG,
			baseDigest: "digest_base",
			headSnapshotId: "snap_head",
		});
	}

	beforeEach(() => {
		prisma.snapshotFindFirst.mockReset();
		prisma.fileFindMany.mockReset();
	});

	it("diffs the base against the head when both belong to the caller's organization", async () => {
		databaseHolding(HOST_ORG);

		expect(await diffAsHost()).toEqual({
			base: { id: "snap_base", version: 8, digest: "digest_base" },
			added: [],
			removed: [],
			changed: ["AGENTS.md"],
		});
	});

	/**
	 * The direction the diff must NOT assume, now that History can roll the
	 * pointer back: the caller holds a NEWER version's digest than the one
	 * published.
	 *
	 * An agent installed v9, someone rolled the project back to v7, and the
	 * agent asks what changed since the copy it has. Nothing here compares
	 * version numbers — the base is found by digest and the head is the
	 * published snapshot — so the answer is the real delta from v9 to v7, the
	 * work the agent has to undo. The only thing that short-circuits to
	 * `unchanged` is an EQUAL digest, which would mean the two versions hold
	 * identical content and there is genuinely nothing to do. A base that has
	 * been pruned is the `null` case above: cannot say, take a full copy.
	 */
	it("diffs backwards when the caller's digest is a newer version than the published one", async () => {
		// v9's manifest, which the caller installed, against the published
		// v7's — the file v9 added is a removal, the file it edited a change.
		prisma.snapshotFindFirst.mockResolvedValue({
			id: "snap_v9",
			version: 9,
			files: [
				{ path: "AGENTS.md", sha256: "v9" },
				{ path: ".claude/skills/new/SKILL.md", sha256: "v9-only" },
			],
		});
		prisma.fileFindMany.mockResolvedValue([
			{ path: "AGENTS.md", sha256: "v7" },
		]);

		expect(await diffAsHost()).toEqual({
			base: { id: "snap_v9", version: 9, digest: "digest_base" },
			added: [],
			removed: [".claude/skills/new/SKILL.md"],
			changed: ["AGENTS.md"],
		});
	});

	// The case the organization filter exists for: the row names this project
	// and carries this digest, but belongs to another tenant.
	it("reports an unknown base for a snapshot on this project owned by another organization", async () => {
		databaseHolding(OTHER_ORG);

		expect(await diffAsHost()).toBeNull();
		// Nothing is reported about the row that was refused, and the head
		// files are never read on the way to saying so.
		expect(prisma.fileFindMany).not.toHaveBeenCalled();
	});

	it("puts both tenant columns in the base lookup's WHERE clause", async () => {
		databaseHolding(HOST_ORG);
		await diffAsHost();

		const where = prisma.snapshotFindFirst.mock.calls[0]?.[0]?.where;
		expect(where).toEqual({
			projectId: "proj_1",
			organizationId: HOST_ORG,
			digest: "digest_base",
			status: "READY",
		});
	});

	it("puts both tenant columns in each file read, base and head alike", async () => {
		databaseHolding(HOST_ORG);
		await diffAsHost();

		expect(
			prisma.snapshotFindFirst.mock.calls[0]?.[0]?.select?.files?.where,
		).toEqual({ projectId: "proj_1", organizationId: HOST_ORG });
		expect(prisma.fileFindMany.mock.calls[0]?.[0]?.where).toEqual({
			snapshotId: "snap_head",
			projectId: "proj_1",
			organizationId: HOST_ORG,
		});
	});

	// Fizzy #2671: both `select`s widened to carry `mode`, and the diff must
	// actually use it — a mode-only republish reported as `changed: []` here
	// is what left `sinceDigest` callers thinking a mode-only version was
	// unchanged, even after the digest itself started moving.
	it("reports a mode-only difference between base and head as changed", async () => {
		prisma.snapshotFindFirst.mockResolvedValue({
			id: "snap_base",
			version: 8,
			files: [{ path: "scripts/run.sh", sha256: "same", mode: 0o644 }],
		});
		prisma.fileFindMany.mockResolvedValue([
			{ path: "scripts/run.sh", sha256: "same", mode: 0o755 },
		]);

		expect(await diffAsHost()).toEqual({
			base: { id: "snap_base", version: 8, digest: "digest_base" },
			added: [],
			removed: [],
			changed: ["scripts/run.sh"],
		});
	});
});
