import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<
		string,
		(arg: {
			input: Record<string, unknown>;
			context: unknown;
		}) => Promise<unknown>
	>,
	listInstructionProposals: vi.fn(),
	getInstructionProposal: vi.fn(),
	getInstructionSnapshot: vi.fn(),
	getInstructionFileByPath: vi.fn(),
	listInstructionFiles: vi.fn(),
	approveInstructionProposal: vi.fn(),
	rejectInstructionProposal: vi.fn(),
	cancelInstructionProposal: vi.fn(),
	downloadFile: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
	canReviewInstructionProposals: vi.fn(),
	requiredPermissions: [] as string[],
}));

vi.mock("@repo/database", () => ({
	listInstructionProposals: (...args: unknown[]) =>
		m.listInstructionProposals(...args),
	getInstructionProposal: (...args: unknown[]) =>
		m.getInstructionProposal(...args),
	getInstructionSnapshot: (...args: unknown[]) =>
		m.getInstructionSnapshot(...args),
	getInstructionFileByPath: (...args: unknown[]) =>
		m.getInstructionFileByPath(...args),
	listInstructionFiles: (...args: unknown[]) =>
		m.listInstructionFiles(...args),
	approveInstructionProposal: (...args: unknown[]) =>
		m.approveInstructionProposal(...args),
	rejectInstructionProposal: (...args: unknown[]) =>
		m.rejectInstructionProposal(...args),
	cancelInstructionProposal: (...args: unknown[]) =>
		m.cancelInstructionProposal(...args),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ downloadFile: m.downloadFile }),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...args: unknown[]) =>
		m.requireHostingOrganizationId(...args),
}));
vi.mock("../proposal-authorization", () => ({
	canReviewInstructionProposals: (...args: unknown[]) =>
		m.canReviewInstructionProposals(...args),
}));
vi.mock("../../../../../orpc/procedures", () => {
	let currentPath = "";
	const builder = {
		use: () => builder,
		route: (route: { path: string }) => {
			currentPath = route.path;
			return builder;
		},
		input: () => builder,
		handler: (
			fn: (arg: {
				input: Record<string, unknown>;
				context: unknown;
			}) => Promise<unknown>,
		) => {
			m.handlers[currentPath] = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: (permission: string) => {
			m.requiredPermissions.push(permission);
			return {};
		},
		Permissions: {
			INSTRUCTION_READ: "instruction:read",
			INSTRUCTION_UPDATE: "instruction:update",
		},
	};
});

import "../proposals";

const LIST = "/projects/:projectId/instructions/proposals";
const GET = "/projects/:projectId/instructions/proposals/:snapshotId";
const FILE = "/projects/:projectId/instructions/proposals/:snapshotId/file";
const APPROVE =
	"/projects/:projectId/instructions/proposals/:snapshotId/approve";
const REJECT = "/projects/:projectId/instructions/proposals/:snapshotId/reject";
const CANCEL = "/projects/:projectId/instructions/proposals/:snapshotId/cancel";
const context = {
	user: { id: "reviewer_1", email: "reviewer@example.com", name: "Reviewer" },
	session: { activeOrganizationId: "wrong_org", impersonatedBy: null },
};
function run(path: string, input: Record<string, unknown>) {
	const handler = m.handlers[path];
	if (!handler) {
		throw new Error(`Missing captured handler for ${path}`);
	}
	return handler({ input, context });
}
const proposal = {
	id: "proposal_1",
	version: 8,
	baseVersion: 7,
	baseSnapshotId: "base_1",
	status: "VALIDATING",
	proposalStatus: "PENDING",
	createdAt: new Date("2026-09-18T00:00:00Z"),
	readyAt: null,
	reviewedAt: null,
	user: { id: "reader_1", name: "Reader" },
	reviewer: null,
	isStale: false,
};

beforeEach(() => {
	for (const value of Object.values(m)) {
		if (typeof value === "function" && "mockReset" in value) {
			(value as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	m.requireHostingOrganizationId.mockResolvedValue("org_1");
	m.canReviewInstructionProposals.mockResolvedValue(true);
});

describe("projects.instructions.proposals", () => {
	it("keeps detail and decisions editor-only while list and cancel allow readers", () => {
		expect(m.requiredPermissions).toEqual([
			"instruction:read",
			"instruction:update",
			"instruction:update",
			"instruction:update",
			"instruction:update",
			"instruction:read",
		]);
	});

	it("serves only a changed text side from a READY proposal in bounded pages", async () => {
		m.getInstructionProposal.mockResolvedValue({
			...proposal,
			status: "READY",
		});
		m.getInstructionSnapshot.mockResolvedValue({
			id: "base_1",
			status: "READY",
		});
		m.getInstructionFileByPath
			.mockResolvedValueOnce({
				path: "large.md",
				sha256: "old",
				isText: true,
				storageKey: "base-key",
				size: 500_000,
				mimeType: "text/markdown",
			})
			.mockResolvedValueOnce({
				path: "large.md",
				sha256: "new",
				isText: true,
				storageKey: "proposal-key",
				size: 500_000,
				mimeType: "text/markdown",
			});
		m.downloadFile.mockResolvedValue({ data: Buffer.from("0123456789") });

		await expect(
			run(FILE, {
				projectId: "project_1",
				snapshotId: "proposal_1",
				path: "large.md",
				side: "after",
				offset: 3,
				maxLength: 4,
			}),
		).resolves.toMatchObject({
			path: "large.md",
			side: "after",
			body: "3456",
			offset: 3,
			nextOffset: 7,
			truncated: true,
		});
		expect(m.downloadFile).toHaveBeenCalledWith("proposal-key", {
			bucket: "skills",
		});
	});

	it("refuses proposal file pages before validation and for unchanged or cross-tenant paths", async () => {
		m.getInstructionProposal.mockResolvedValue(proposal);
		await expect(
			run(FILE, {
				projectId: "project_1",
				snapshotId: "proposal_1",
				path: "large.md",
				side: "after",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.downloadFile).not.toHaveBeenCalled();

		m.getInstructionProposal.mockResolvedValue({ ...proposal, status: "READY" });
		m.getInstructionSnapshot.mockResolvedValue({ id: "base_1", status: "READY" });
		m.getInstructionFileByPath.mockResolvedValue({
			path: "same.md",
			sha256: "same",
			isText: true,
			storageKey: "same-key",
		});
		await expect(
			run(FILE, {
				projectId: "project_1",
				snapshotId: "proposal_1",
				path: "same.md",
				side: "before",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		m.getInstructionProposal.mockResolvedValue(null);
		await expect(
			run(FILE, {
				projectId: "other_project",
				snapshotId: "proposal_1",
				path: "large.md",
				side: "after",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("derives the tenant from the project when listing proposals", async () => {
		m.listInstructionProposals.mockResolvedValue({
			items: [proposal],
			nextCursor: "next_1",
		});

		await expect(
			run(LIST, {
				projectId: "project_1",
				organizationId: "attacker_org",
			}),
		).resolves.toEqual({
			items: [
				expect.objectContaining({
					id: "proposal_1",
					proposalStatus: "PENDING",
					proposer: { id: "reader_1", name: "Reader" },
				}),
			],
			nextCursor: "next_1",
		});
		expect(m.listInstructionProposals).toHaveBeenCalledWith(
			"project_1",
			"org_1",
			{ limit: undefined, cursor: undefined, proposerUserId: undefined },
		);
	});

	it("limits a non-reviewer list to their own proposal metadata", async () => {
		m.canReviewInstructionProposals.mockResolvedValue(false);
		m.listInstructionProposals.mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		await run(LIST, { projectId: "project_1", limit: 10 });

		expect(m.listInstructionProposals).toHaveBeenCalledWith(
			"project_1",
			"org_1",
			{ limit: 10, cursor: undefined, proposerUserId: "reviewer_1" },
		);
	});

	it("does not read file rows or storage before validation finishes", async () => {
		m.getInstructionProposal.mockResolvedValue(proposal);

		await expect(
			run(GET, { projectId: "project_1", snapshotId: "proposal_1" }),
		).resolves.toEqual(expect.objectContaining({ changes: null }));
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.downloadFile).not.toHaveBeenCalled();
	});

	it("returns text changes only after the proposal is READY", async () => {
		m.getInstructionProposal.mockResolvedValue({
			...proposal,
			status: "READY",
			readyAt: new Date("2026-09-18T00:01:00Z"),
		});
		m.getInstructionSnapshot.mockResolvedValue({
			id: "base_1",
			status: "READY",
		});
		m.listInstructionFiles
			.mockResolvedValueOnce([
				{
					path: "CLAUDE.md",
					sha256: "old",
					size: 6,
					isText: true,
					storageKey: "base-key",
				},
			])
			.mockResolvedValueOnce([
				{
					path: "CLAUDE.md",
					sha256: "new",
					size: 5,
					isText: true,
					storageKey: "proposal-key",
				},
			]);
		m.downloadFile
			.mockResolvedValueOnce({ data: Buffer.from("before") })
			.mockResolvedValueOnce({ data: Buffer.from("after") });

		await expect(
			run(GET, { projectId: "project_1", snapshotId: "proposal_1" }),
		).resolves.toEqual(
			expect.objectContaining({
				changes: [
					{
						path: "CLAUDE.md",
						op: "edit",
						before: "before",
						after: "after",
						beforeOmitted: null,
						afterOmitted: null,
						beforeSize: 6,
						afterSize: 5,
						binary: false,
					},
				],
			}),
		);
	});

	it("omits a large file before downloading it", async () => {
		m.getInstructionProposal.mockResolvedValue({
			...proposal,
			status: "READY",
		});
		m.getInstructionSnapshot.mockResolvedValue({
			id: "base_1",
			status: "READY",
		});
		m.listInstructionFiles.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{
				path: "large.md",
				sha256: "new",
				size: 262_145,
				isText: true,
				storageKey: "large-key",
			},
		]);

		const result = (await run(GET, {
			projectId: "project_1",
			snapshotId: "proposal_1",
		})) as { changes: Array<Record<string, unknown>> };

		expect(result.changes[0]).toMatchObject({
			after: null,
			afterOmitted: "FILE_TOO_LARGE",
			afterSize: 262_145,
		});
		expect(m.downloadFile).not.toHaveBeenCalled();
	});

	it("enforces one total inline-text budget across files", async () => {
		m.getInstructionProposal.mockResolvedValue({
			...proposal,
			status: "READY",
		});
		m.getInstructionSnapshot.mockResolvedValue({
			id: "base_1",
			status: "READY",
		});
		m.listInstructionFiles.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{
				path: "a.md",
				sha256: "a",
				size: 200_000,
				isText: true,
				storageKey: "a-key",
			},
			{
				path: "b.md",
				sha256: "b",
				size: 100_000,
				isText: true,
				storageKey: "b-key",
			},
		]);
		m.downloadFile.mockResolvedValue({ data: Buffer.alloc(200_000) });

		const result = (await run(GET, {
			projectId: "project_1",
			snapshotId: "proposal_1",
		})) as { changes: Array<Record<string, unknown>> };

		expect(result.changes).toEqual([
			expect.objectContaining({ afterOmitted: null }),
			expect.objectContaining({
				after: null,
				afterOmitted: "RESPONSE_LIMIT",
			}),
		]);
		expect(m.downloadFile).toHaveBeenCalledOnce();
	});

	it("maps an exact-base approval failure to a resubmission conflict", async () => {
		m.getInstructionProposal.mockResolvedValue(proposal);
		m.approveInstructionProposal.mockResolvedValue({
			ok: false,
			reason: "stale",
		});

		await expect(
			run(APPROVE, {
				projectId: "project_1",
				snapshotId: "proposal_1",
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "PROPOSAL_STALE" },
		});
	});

	it("returns terminal retry success without exposing decision internals", async () => {
		m.getInstructionProposal.mockResolvedValue({
			...proposal,
			proposalStatus: "REJECTED",
		});
		m.rejectInstructionProposal.mockResolvedValue({
			ok: true,
			changed: false,
			version: 8,
		});

		await expect(
			run(REJECT, {
				projectId: "project_1",
				snapshotId: "proposal_1",
			}),
		).resolves.toEqual({ rejected: true });
	});

	it("lets the owner cancel a stable proposal", async () => {
		m.getInstructionProposal.mockResolvedValue({
			...proposal,
			status: "FAILED",
			user: { id: "reviewer_1", name: "Reviewer" },
		});
		m.cancelInstructionProposal.mockResolvedValue({
			ok: true,
			changed: true,
			version: 8,
		});

		await expect(
			run(CANCEL, {
				projectId: "project_1",
				snapshotId: "proposal_1",
			}),
		).resolves.toEqual({ canceled: true });
		expect(m.cancelInstructionProposal).toHaveBeenCalledWith(
			expect.objectContaining({ proposerUserId: "reviewer_1" }),
		);
	});
});
