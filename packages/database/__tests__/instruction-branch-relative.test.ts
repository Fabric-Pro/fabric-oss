/**
 * Branch-relative Coding Instructions changes: which files Fabric wrote on a
 * member's OWN accepting proposal branch, with the blob and mode it wrote.
 * The branch reads are mocks; the projection is the real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getAcceptingBranchForMember: vi.fn(),
	listEstablishedBranchOps: vi.fn(),
}));

vi.mock(
	"../prisma/queries/instruction-proposal-branches",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../prisma/queries/instruction-proposal-branches")
		>()),
		getAcceptingBranchForMember: m.getAcceptingBranchForMember,
		listEstablishedBranchOps: m.listEstablishedBranchOps,
	}),
);

import {
	readMemberBranchDeletedPaths,
	readMemberBranchWrittenPaths,
} from "../prisma/queries/instruction-branch-relative";
import type {
	BranchOperationEntryRecord,
	BranchTreeEntry,
	ProjectionOp,
} from "../prisma/queries/instruction-proposal-branches";

const MEMBER = "user_example_member";
const OTHER = "user_example_other";

const blob = (oid: string, mode = "100644"): BranchTreeEntry => ({
	type: "blob",
	mode,
	oid,
});

function e(
	path: string,
	over: Partial<BranchOperationEntryRecord>,
): BranchOperationEntryRecord {
	return {
		path,
		rawPath: path,
		before: null,
		after: null,
		afterSha256: null,
		afterSource: null,
		beforeSource: null,
		...over,
	};
}

const added: ProjectionOp = {
	kind: "APPEND",
	executionSeq: 1,
	outcome: "acked",
	entries: [
		e("rules/new.md", {
			after: blob("o_new"),
			afterSha256: "h_new",
			afterSource: "snap_add",
		}),
		e("scripts/tool.sh", {
			after: blob("o_tool", "100755"),
			afterSha256: "h_tool",
			afterSource: "snap_add",
		}),
	],
};

const deleted: ProjectionOp = {
	kind: "APPEND",
	executionSeq: 2,
	outcome: "acked",
	entries: [
		e("rules/new.md", {
			before: blob("o_new"),
			beforeSource: "snap_add",
		}),
	],
};

const query = (paths: string[], userId = MEMBER) =>
	readMemberBranchWrittenPaths({
		projectId: "proj_example",
		userId,
		organizationId: "org_example",
		paths,
	});

beforeEach(() => {
	vi.resetAllMocks();
	m.getAcceptingBranchForMember.mockImplementation(
		async (i: { userId: string }) =>
			i.userId === MEMBER
				? { id: "branch_example", userId: MEMBER }
				: null,
	);
});

describe("readMemberBranchWrittenPaths", () => {
	it("ignores operations Fabric cannot prove are on the branch", async () => {
		m.listEstablishedBranchOps.mockResolvedValue([
			added,
			{ ...deleted, outcome: "unknown" },
		]);
		expect(
			(await query(["rules/new.md"])).get("rules/new.md"),
		).toMatchObject({ objectId: "o_new" });
	});

	it("leaves out a symlink Fabric never writes as a regular file", async () => {
		m.listEstablishedBranchOps.mockResolvedValue([
			{
				...added,
				entries: [
					e("link.md", {
						after: {
							type: "symlink",
							mode: "120000",
							oid: "o_link",
						},
						afterSha256: "h_link",
						afterSource: "snap_add",
					}),
				],
			},
		]);
		expect((await query(["link.md"])).size).toBe(0);
	});

	it("answers each written path with the blob and numeric mode Fabric wrote", async () => {
		m.listEstablishedBranchOps.mockResolvedValue([added]);
		const written = await query(["rules/new.md", "scripts/tool.sh"]);
		expect(written.get("rules/new.md")).toEqual({
			path: "rules/new.md",
			branchId: "branch_example",
			objectId: "o_new",
			mode: 0o100644,
			sha256: "h_new",
		});
		expect(written.get("scripts/tool.sh")?.mode).toBe(0o100755);
		expect(m.listEstablishedBranchOps).toHaveBeenCalledWith({
			branchId: "branch_example",
			organizationId: "org_example",
		});
	});

	it("leaves out a path the branch deleted or never held", async () => {
		m.listEstablishedBranchOps.mockResolvedValue([added, deleted]);
		const written = await query(["rules/new.md", "rules/never.md"]);
		expect([...written.keys()]).toEqual([]);
	});

	it("projects a withdrawn delete as written again", async () => {
		m.listEstablishedBranchOps.mockResolvedValue([
			added,
			deleted,
			{ ...deleted, kind: "REVERT", executionSeq: 3 },
		]);
		const written = await query(["rules/new.md"]);
		expect(written.get("rules/new.md")).toMatchObject({
			objectId: "o_new",
			sha256: "h_new",
		});
	});

	it("reads only the caller's own accepting branch: another member gets nothing", async () => {
		m.listEstablishedBranchOps.mockResolvedValue([added]);
		const written = await query(["rules/new.md"], OTHER);
		expect(written.size).toBe(0);
		expect(m.getAcceptingBranchForMember).toHaveBeenCalledWith({
			projectId: "proj_example",
			userId: OTHER,
			organizationId: "org_example",
		});
		expect(m.listEstablishedBranchOps).not.toHaveBeenCalled();
	});

	it("reads nothing when no path needs the branch", async () => {
		expect((await query([])).size).toBe(0);
		expect(m.getAcceptingBranchForMember).not.toHaveBeenCalled();
	});
});

describe("readMemberBranchDeletedPaths", () => {
	const deletedQuery = (paths: string[], userId = MEMBER) =>
		readMemberBranchDeletedPaths({
			projectId: "proj_example",
			userId,
			organizationId: "org_example",
			paths,
		});

	it("answers only the asked paths an established operation deleted", async () => {
		m.listEstablishedBranchOps.mockResolvedValue([added, deleted]);
		const paths = await deletedQuery([
			"rules/new.md",
			"scripts/tool.sh",
			"rules/never.md",
		]);
		expect([...paths]).toEqual(["rules/new.md"]);
	});

	it("does not count a withdrawn delete or one Fabric cannot prove", async () => {
		m.listEstablishedBranchOps.mockResolvedValue([
			added,
			{ ...deleted, outcome: "unknown" },
		]);
		expect((await deletedQuery(["rules/new.md"])).size).toBe(0);
		m.listEstablishedBranchOps.mockResolvedValue([
			added,
			deleted,
			{ ...deleted, kind: "REVERT", executionSeq: 3 },
		]);
		expect((await deletedQuery(["rules/new.md"])).size).toBe(0);
	});

	it("reads only the caller's own accepting branch", async () => {
		m.listEstablishedBranchOps.mockResolvedValue([added, deleted]);
		expect((await deletedQuery(["rules/new.md"], OTHER)).size).toBe(0);
		expect(m.listEstablishedBranchOps).not.toHaveBeenCalled();
	});
});
