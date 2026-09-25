import { ORPCError } from "@orpc/client";
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
	runInBackground: vi.fn(),
	warmInstructionSnapshotExport: vi.fn(),
	getSyncRunReceiptByRunId: vi.fn(),
	getSyncRunReceiptsByRunIds: vi.fn(),
	getProposalPullRequestStatus: vi.fn(),
	refreshProposalPullRequest: vi.fn(),
	retryProposalPullRequest: vi.fn(),
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
	getSyncRunReceiptByRunId: (...args: unknown[]) =>
		m.getSyncRunReceiptByRunId(...args),
	getSyncRunReceiptsByRunIds: (...args: unknown[]) =>
		m.getSyncRunReceiptsByRunIds(...args),
}));
// The list rows' `pullRequest` block is built by the real
// `pullRequestStatusOf`; the status, refresh and retry procedures delegate to
// the service, whose own suite (`proposal-pull-request.test.ts`) covers it.
vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));
vi.mock("../proposal-pull-request", async (importOriginal) => ({
	...(await importOriginal<typeof import("../proposal-pull-request")>()),
	getProposalPullRequestStatus: (...args: unknown[]) =>
		m.getProposalPullRequestStatus(...args),
	refreshProposalPullRequest: (...args: unknown[]) =>
		m.refreshProposalPullRequest(...args),
	retryProposalPullRequest: (...args: unknown[]) =>
		m.retryProposalPullRequest(...args),
}));
vi.mock("../../../../../lib/audit", () => ({
	resolveActor: (context: { user: { id: string } }) => ({
		type: "user",
		userId: context.user.id,
	}),
	auditRequestFields: () => ({
		impersonatedById: null,
		ipAddress: "203.0.113.7",
		userAgent: null,
		requestId: "req_1",
		sessionId: "sess_1",
		correlationId: "corr_1",
	}),
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
// Approval publishes, so it pre-builds the download archive the same way the
// manual publish procedure does. The work is SCHEDULED rather than awaited,
// and `run-in-background.ts` is a local wrapper precisely so a test can
// assert that by mocking it.
vi.mock("../../../../../modules/weave/lib/run-in-background", () => ({
	runInBackground: (...args: unknown[]) => m.runInBackground(...args),
}));
vi.mock("@repo/instructions/export", () => ({
	warmInstructionSnapshotExport: (...args: unknown[]) =>
		m.warmInstructionSnapshotExport(...args),
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
import { pullRequestStatusOf } from "../proposal-pull-request";

const LIST = "/projects/:projectId/instructions/proposals";
const GET = "/projects/:projectId/instructions/proposals/:snapshotId";
const FILE = "/projects/:projectId/instructions/proposals/:snapshotId/file";
const APPROVE =
	"/projects/:projectId/instructions/proposals/:snapshotId/approve";
const REJECT = "/projects/:projectId/instructions/proposals/:snapshotId/reject";
const CANCEL = "/projects/:projectId/instructions/proposals/:snapshotId/cancel";
const PR_STATUS =
	"/projects/:projectId/instructions/proposals/:snapshotId/pull-request";
const PR_REFRESH =
	"/projects/:projectId/instructions/proposals/:snapshotId/pull-request/refresh";
const PR_RETRY =
	"/projects/:projectId/instructions/proposals/:snapshotId/pull-request/retry";
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
	m.warmInstructionSnapshotExport.mockResolvedValue(undefined);
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
			// The pull request's status, refresh and retry: read, plus the
			// live proposer-or-reviewer check in the service (Decision 8).
			"instruction:read",
			"instruction:read",
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

		m.getInstructionProposal.mockResolvedValue({
			...proposal,
			status: "READY",
		});
		m.getInstructionSnapshot.mockResolvedValue({
			id: "base_1",
			status: "READY",
		});
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

	// Spec §4: while the repository is the source of truth, approving a
	// pending proposal would publish files the repository never had.
	it("refuses approval while the repository is the source of truth", async () => {
		m.getInstructionProposal.mockResolvedValue(proposal);
		m.approveInstructionProposal.mockResolvedValue({
			ok: false,
			reason: "repository_backed",
		});

		await expect(
			run(APPROVE, {
				projectId: "project_1",
				snapshotId: "proposal_1",
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: expect.stringContaining("come from its repository"),
			data: { reason: "REPOSITORY_BACKED" },
		});
		expect(m.runInBackground).not.toHaveBeenCalled();
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

	it("pre-builds the export archive for the version an approval publishes", async () => {
		m.getInstructionProposal.mockResolvedValue(proposal);
		m.approveInstructionProposal.mockResolvedValue({
			ok: true,
			changed: true,
			version: 9,
		});

		await run(APPROVE, {
			projectId: "project_1",
			snapshotId: "proposal_1",
		});

		// The proposal id IS the snapshot id, and the organization is the
		// project's hosting organization resolved server-side.
		expect(m.warmInstructionSnapshotExport).toHaveBeenCalledWith({
			projectId: "project_1",
			organizationId: "org_1",
			snapshotId: "proposal_1",
		});
		// Scheduled, not awaited: the reviewer's response is unchanged.
		expect(m.runInBackground).toHaveBeenCalledTimes(1);
	});

	it("pre-builds nothing when the approval was refused", async () => {
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
		).rejects.toMatchObject({ code: "CONFLICT" });

		// Nothing took the pointer, so there is no new version to build for.
		expect(m.warmInstructionSnapshotExport).not.toHaveBeenCalled();
		expect(m.runInBackground).not.toHaveBeenCalled();
	});
});

describe("repository proposals (Fizzy #2563 spec §12)", () => {
	const repositoryProposal = {
		...proposal,
		status: "READY",
		proposalDestination: "REPOSITORY",
		proposalNote: { title: "Tighten the lint rule", body: "Why." },
		pullRequestOperationId: "op_1",
		pullRequestState: "MERGED",
		proposalStatus: "MERGED",
		pullRequestAttempt: 4,
		pullRequestUrl: "https://example.com/example-org/example-repo/pull/7",
		pullRequestExternalId: "7",
		pullRequestFailure: null,
		pullRequestLastCheckedAt: new Date("2026-09-24T12:05:00.000Z"),
		pullRequestObservation: { targetRef: "main", targetMismatch: false },
		mergeSyncRequestedAt: null,
		mergeSyncRunId: "run_1",
	};
	const fabricProposal = {
		...proposal,
		proposalDestination: "FABRIC",
		proposalNote: null,
		pullRequestOperationId: null,
		pullRequestState: null,
		pullRequestAttempt: 0,
		pullRequestUrl: null,
		pullRequestExternalId: null,
		pullRequestFailure: null,
		pullRequestLastCheckedAt: null,
		pullRequestObservation: null,
		mergeSyncRequestedAt: null,
		mergeSyncRunId: null,
	};

	it("lists each row's destination, note and pull request, with the merge sync's run status", async () => {
		m.listInstructionProposals.mockResolvedValue({
			items: [repositoryProposal, fabricProposal],
			nextCursor: null,
		});
		m.getSyncRunReceiptsByRunIds.mockResolvedValue(
			new Map([["run_1", { id: "sync_1:run_1", status: "SUCCEEDED" }]]),
		);

		const listed = (await run(LIST, { projectId: "project_1" })) as {
			items: Array<Record<string, unknown>>;
		};

		expect(listed.items[0]).toMatchObject({
			id: "proposal_1",
			proposalStatus: "MERGED",
			destination: "REPOSITORY",
			note: { title: "Tighten the lint rule", body: "Why." },
			canCancel: false,
			pullRequest: {
				operationId: "op_1",
				state: "MERGED",
				url: "https://example.com/example-org/example-repo/pull/7",
				externalId: "7",
				failure: null,
				lastCheckedAt: new Date("2026-09-24T12:05:00.000Z"),
				attempt: 4,
				observation: {
					targetRef: "main",
					targetMismatch: false,
					mergedAt: null,
					closedAt: null,
				},
				mergeSync: {
					requestedAt: null,
					runId: "run_1",
					runStatus: "SUCCEEDED",
				},
			},
		});
		expect(listed.items[1]).toMatchObject({
			destination: "FABRIC",
			note: null,
			pullRequest: null,
		});
		// The page's receipts are read once, in the hosting organization,
		// never the input's, and only for the operation with a run id.
		expect(m.getSyncRunReceiptsByRunIds).toHaveBeenCalledExactlyOnceWith({
			projectId: "project_1",
			organizationId: "org_1",
			runIds: ["run_1"],
		});
		expect(m.getSyncRunReceiptByRunId).not.toHaveBeenCalled();
	});

	it("reads a page of merged rows' receipts in one query, each row as the single-row read shows it, a missing receipt included", async () => {
		const merged = (runId: string, id: string) => ({
			...repositoryProposal,
			id,
			pullRequestOperationId: `op_${id}`,
			mergeSyncRunId: runId,
		});
		const requested = {
			...repositoryProposal,
			id: "proposal_requested",
			pullRequestOperationId: "op_requested",
			mergeSyncRequestedAt: new Date("2026-09-24T12:10:00.000Z"),
			mergeSyncRunId: null,
		};
		const items = [
			merged("run_1", "proposal_1"),
			merged("run_2", "proposal_2"),
			// No receipt recorded for this run yet.
			merged("run_3", "proposal_3"),
			merged("run_4", "proposal_4"),
			requested,
			fabricProposal,
		];
		const receipts: Record<string, { id: string; status: string }> = {
			run_1: { id: "sync_1:run_1", status: "SUCCEEDED" },
			run_2: { id: "sync_1:run_2", status: "FAILED" },
			run_4: { id: "sync_2:run_4", status: "RUNNING" },
		};
		m.listInstructionProposals.mockResolvedValue({
			items,
			nextCursor: null,
		});
		m.getSyncRunReceiptsByRunIds.mockResolvedValue(
			new Map(Object.entries(receipts)),
		);

		const listed = (await run(LIST, { projectId: "project_1" })) as {
			items: Array<{ pullRequest: unknown }>;
		};

		expect(m.getSyncRunReceiptsByRunIds).toHaveBeenCalledExactlyOnceWith({
			projectId: "project_1",
			organizationId: "org_1",
			runIds: ["run_1", "run_2", "run_3", "run_4"],
		});
		expect(m.getSyncRunReceiptByRunId).not.toHaveBeenCalled();

		// The single-row read, one receipt query per row, is the reference.
		m.getSyncRunReceiptByRunId.mockImplementation(
			async ({ runId }: { runId: string }) => receipts[runId] ?? null,
		);
		const scope = { projectId: "project_1", organizationId: "org_1" };
		const expected = await Promise.all(
			items.map((row) => pullRequestStatusOf(row as never, scope)),
		);
		expect(listed.items.map((item) => item.pullRequest)).toEqual(expected);
		expect(m.getSyncRunReceiptByRunId).toHaveBeenCalledTimes(4);
		expect(
			(listed.items[2]?.pullRequest as { mergeSync: unknown }).mergeSync,
		).toEqual({ requestedAt: null, runId: "run_3", runStatus: null });
		expect(
			(listed.items[4]?.pullRequest as { mergeSync: unknown }).mergeSync,
		).toEqual({
			requestedAt: new Date("2026-09-24T12:10:00.000Z"),
			runId: null,
			runStatus: null,
		});
	});

	it("offers the proposer a cancel on an open pull request, and none once closing is requested", async () => {
		const own = {
			...repositoryProposal,
			user: { id: "reviewer_1", name: "Reviewer" },
			proposalStatus: "PENDING",
			pullRequestState: "OPEN",
			mergeSyncRunId: null,
		};
		m.listInstructionProposals.mockResolvedValue({
			items: [own, { ...own, pullRequestState: "CLOSE_REQUESTED" }],
			nextCursor: null,
		});

		const listed = (await run(LIST, { projectId: "project_1" })) as {
			items: Array<{ canCancel: boolean }>;
		};

		expect(listed.items.map((item) => item.canCancel)).toEqual([
			true,
			false,
		]);
	});

	it.each([
		["approve", APPROVE],
		["reject", REJECT],
	])(
		"refuses to %s a REPOSITORY proposal: its pull request decides it",
		async (_verb, path) => {
			m.getInstructionProposal.mockResolvedValue(repositoryProposal);
			m.approveInstructionProposal.mockResolvedValue({
				ok: false,
				reason: "repository_proposal",
			});
			m.rejectInstructionProposal.mockResolvedValue({
				ok: false,
				reason: "repository_proposal",
			});

			await expect(
				run(path, { projectId: "project_1", snapshotId: "proposal_1" }),
			).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
				data: { reason: "REPOSITORY_PROPOSAL" },
			});
			expect(m.runInBackground).not.toHaveBeenCalled();
		},
	);

	it("reports what a cancel did to the pull request, auditing the requester with the request", async () => {
		m.getInstructionProposal.mockResolvedValue(repositoryProposal);
		m.cancelInstructionProposal.mockResolvedValue({
			ok: true,
			changed: true,
			version: 8,
			pullRequest: "close_requested",
		});

		await expect(
			run(CANCEL, { projectId: "project_1", snapshotId: "proposal_1" }),
		).resolves.toEqual({ canceled: true, pullRequest: "close_requested" });
		expect(m.cancelInstructionProposal).toHaveBeenCalledWith({
			snapshotId: "proposal_1",
			projectId: "project_1",
			organizationId: "org_1",
			proposerUserId: "reviewer_1",
			audit: expect.objectContaining({
				actor: expect.objectContaining({ userId: "reviewer_1" }),
				ipAddress: "203.0.113.7",
				requestId: "req_1",
				sessionId: "sess_1",
				correlationId: "corr_1",
			}),
		});
	});

	it("refuses a cancel from anyone but the proposer", async () => {
		m.getInstructionProposal.mockResolvedValue(repositoryProposal);
		m.cancelInstructionProposal.mockResolvedValue({
			ok: false,
			reason: "not_found",
		});

		await expect(
			run(CANCEL, { projectId: "project_1", snapshotId: "proposal_1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("sends Retry-After with a Refresh the service refused, and passes the refusal through", async () => {
		const refusal = new ORPCError("TOO_MANY_REQUESTS", {
			message:
				"This pull request was refreshed a moment ago. Try again in 42 seconds.",
			data: { reason: "PULL_REQUEST_REFRESH_COOLDOWN", retryAfter: 42 },
		});
		m.refreshProposalPullRequest.mockRejectedValue(refusal);
		const resHeaders = new Headers();
		const handler = m.handlers[PR_REFRESH];
		if (!handler) {
			throw new Error(`Missing captured handler for ${PR_REFRESH}`);
		}

		await expect(
			handler({
				input: { projectId: "project_1", snapshotId: "proposal_1" },
				context: { ...context, resHeaders },
			}),
		).rejects.toBe(refusal);
		expect(resHeaders.get("Retry-After")).toBe("42");
	});

	it("reads, refreshes and retries in the hosting organization as the caller", async () => {
		const caller = {
			snapshotId: "proposal_1",
			projectId: "project_1",
			organizationId: "org_1",
			userId: "reviewer_1",
		};
		m.getProposalPullRequestStatus.mockResolvedValue({ state: "BLOCKED" });
		m.refreshProposalPullRequest.mockResolvedValue({ refreshed: true });
		m.retryProposalPullRequest.mockResolvedValue({ retried: true });
		const input = {
			projectId: "project_1",
			organizationId: "attacker_org",
			snapshotId: "proposal_1",
		};

		await expect(run(PR_STATUS, input)).resolves.toEqual({
			pullRequest: { state: "BLOCKED" },
		});
		await expect(run(PR_REFRESH, input)).resolves.toEqual({
			refreshed: true,
		});
		await expect(
			run(PR_RETRY, { ...input, expectedAttempt: 4 }),
		).resolves.toEqual({ retried: true });

		expect(m.getProposalPullRequestStatus).toHaveBeenCalledWith(caller);
		expect(m.refreshProposalPullRequest).toHaveBeenCalledWith(caller);
		expect(m.retryProposalPullRequest).toHaveBeenCalledWith({
			...caller,
			expectedAttempt: 4,
			requester: {
				actor: { type: "user", userId: "reviewer_1" },
				ipAddress: "203.0.113.7",
				userAgent: null,
				requestId: "req_1",
				sessionId: "sess_1",
				correlationId: "corr_1",
			},
		});
	});
});
