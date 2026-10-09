/**
 * The member proposal branch procedures (Fizzy #2738 spec §10 "Procedures,
 * REST v1 and SDK"; Decisions 11, 14, 17, 18, 19; §4.3 "Try again"):
 * `myBranch`, `myBranchFile`, `closeBranch`, `startOverBranch`,
 * `retryBranch`, `stopTrackingBranch`, `retryConflict` and `proposeAgain`.
 *
 * The procedures, the services in `proposal-branch.ts` and the live
 * permission checks in `proposal-authorization.ts` run for real; the
 * database commands, the permission resolver and the Temporal client are
 * mocks. What is pinned: who may call each one, what each refusal maps to,
 * and that every command that changed something wakes the branch workflow,
 * whose failure is logged and never fails the request.
 */
import { Permissions as P } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<
		string,
		(arg: {
			input: Record<string, unknown>;
			context: unknown;
		}) => Promise<unknown>
	>,
	requiredPermissions: [] as string[],
	resolveEffectiveProjectPermissions: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
	getMemberProposalBranch: vi.fn(),
	getAcceptingBranchForMember: vi.fn(),
	listMemberBranches: vi.fn(),
	listProposalBranchOwnerIds: vi.fn(),
	countLiveBranchChanges: vi.fn(),
	projectMemberBranch: vi.fn(),
	getInstructionFileByPath: vi.fn(),
	loadGitIntent: vi.fn(),
	getInstructionRepositorySyncForProposal: vi.fn(),
	closeProposalBranch: vi.fn(),
	startOverProposalBranch: vi.fn(),
	requestProposalBranchRetry: vi.fn(),
	stopTrackingBranch: vi.fn(),
	tryBranchProposalAgain: vi.fn(),
	proposeBranchProposalAgain: vi.fn(),
	requestProposalBranchRefresh: vi.fn(),
	getUsersByIds: vi.fn(),
	getHandle: vi.fn(),
	signal: vi.fn(),
	signalWithStart: vi.fn(),
	workflowStart: vi.fn(),
	workflowResult: vi.fn(),
	withDeadline: vi.fn(),
	downloadFile: vi.fn(),
	getSignedUrl: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	getMemberProposalBranch: (...a: unknown[]) =>
		m.getMemberProposalBranch(...a),
	getAcceptingBranchForMember: (...a: unknown[]) =>
		m.getAcceptingBranchForMember(...a),
	listMemberBranches: (...a: unknown[]) => m.listMemberBranches(...a),
	listProposalBranchOwnerIds: (...a: unknown[]) =>
		m.listProposalBranchOwnerIds(...a),
	countLiveBranchChanges: (...a: unknown[]) => m.countLiveBranchChanges(...a),
	projectMemberBranch: (...a: unknown[]) => m.projectMemberBranch(...a),
	getInstructionFileByPath: (...a: unknown[]) =>
		m.getInstructionFileByPath(...a),
	loadGitIntent: (...a: unknown[]) => m.loadGitIntent(...a),
	getInstructionRepositorySyncForProposal: (...a: unknown[]) =>
		m.getInstructionRepositorySyncForProposal(...a),
	closeProposalBranch: (...a: unknown[]) => m.closeProposalBranch(...a),
	startOverProposalBranch: (...a: unknown[]) =>
		m.startOverProposalBranch(...a),
	requestProposalBranchRetry: (...a: unknown[]) =>
		m.requestProposalBranchRetry(...a),
	stopTrackingBranch: (...a: unknown[]) => m.stopTrackingBranch(...a),
	tryBranchProposalAgain: (...a: unknown[]) => m.tryBranchProposalAgain(...a),
	proposeBranchProposalAgain: (...a: unknown[]) =>
		m.proposeBranchProposalAgain(...a),
	requestProposalBranchRefresh: (...a: unknown[]) =>
		m.requestProposalBranchRefresh(...a),
	getUsersByIds: (...a: unknown[]) => m.getUsersByIds(...a),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			getHandle: (...a: unknown[]) => m.getHandle(...a),
			signalWithStart: (...a: unknown[]) => m.signalWithStart(...a),
			start: (...a: unknown[]) => m.workflowStart(...a),
		},
		connection: {
			withDeadline: (_deadline: number, operation: () => unknown) =>
				m.withDeadline(_deadline, operation),
		},
	}),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(options: T) => options,
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		downloadFile: m.downloadFile,
		getSignedUrl: m.getSignedUrl,
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...a: unknown[]) =>
		m.requireHostingOrganizationId(...a),
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
vi.mock("../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: {},
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

import { refreshBranchOfProposal } from "../proposal-branch";
import "../proposal-branch-procedures";
import { pullRequestView } from "../proposal-pull-request";

const MY_BRANCH = "/projects/:projectId/instructions/proposal-branch";
const BRANCHES = "/projects/:projectId/instructions/proposal-branches";
const FILE =
	"/projects/:projectId/instructions/proposal-branches/:branchId/file";
const CLOSE =
	"/projects/:projectId/instructions/proposal-branches/:branchId/close";
const START_OVER =
	"/projects/:projectId/instructions/proposal-branches/:branchId/start-over";
const RETRY =
	"/projects/:projectId/instructions/proposal-branches/:branchId/retry";
const STOP =
	"/projects/:projectId/instructions/proposal-branches/:branchId/stop-tracking";
const REFRESH =
	"/projects/:projectId/instructions/proposal-branches/:branchId/refresh";
const TRY_AGAIN =
	"/projects/:projectId/instructions/proposals/:snapshotId/try-again";
const PROPOSE_AGAIN =
	"/projects/:projectId/instructions/proposals/:snapshotId/propose-again";

const OWNER = "member_1";
const REVIEWER = "reviewer_1";
const OTHER = "member_2";
const GUEST = "guest_1";
const WORKFLOW_ID = "project-instruction-proposal-branch-branch_1";

/** Each caller's live project access, as the shared resolver answers it. */
const ACCESS: Record<string, unknown> = {
	// An org MEMBER who may propose: instruction:create.
	[OWNER]: {
		source: "org",
		organizationId: "org_1",
		permissions: [P.INSTRUCTION_READ, P.INSTRUCTION_CREATE],
	},
	[REVIEWER]: {
		source: "org",
		organizationId: "org_1",
		permissions: [P.INSTRUCTION_READ, P.INSTRUCTION_UPDATE],
	},
	[OTHER]: {
		source: "org",
		organizationId: "org_1",
		permissions: [P.INSTRUCTION_READ, P.INSTRUCTION_CREATE],
	},
	// An invited project guest: read only, authoritative over any org role.
	[GUEST]: {
		source: "project-member",
		organizationId: "org_1",
		permissions: [P.INSTRUCTION_READ],
	},
};

function contextOf(userId: string) {
	return {
		user: { id: userId, email: `${userId}@example.com`, name: "Dev" },
		session: { activeOrganizationId: "wrong_org", impersonatedBy: null },
	};
}

function run(path: string, userId: string, input: Record<string, unknown>) {
	const handler = m.handlers[path];
	if (!handler) {
		throw new Error(`Missing captured handler for ${path}`);
	}
	return handler({
		input: { projectId: "project_1", ...input },
		context: contextOf(userId),
	});
}

function branchRow(over: Record<string, unknown> = {}) {
	return {
		id: "branch_1",
		organizationId: "org_1",
		projectId: "project_1",
		userId: OWNER,
		repositoryKey: "github:example-org/example-repo",
		number: 3,
		ref: "fabric/instructions/members/dev-example-abcd/3",
		state: "OPEN",
		attempt: 4,
		failure: null,
		foreignTipAt: null,
		membership: null,
		retiredAt: null,
		untracked: false,
		pullRequestUrl: "https://github.com/example-org/example-repo/pull/7",
		pullRequestExternalId: "7",
		lastCheckedAt: new Date("2026-09-27T10:00:00Z"),
		...over,
	};
}

const REQUESTER = {
	actor: { type: "user", userId: OWNER },
	ipAddress: "203.0.113.7",
	userAgent: null,
	requestId: "req_1",
	sessionId: "sess_1",
	correlationId: "corr_1",
};

beforeEach(() => {
	for (const value of Object.values(m)) {
		if (typeof value === "function" && "mockReset" in value) {
			(value as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	m.requireHostingOrganizationId.mockResolvedValue("org_1");
	m.loadGitIntent.mockResolvedValue(null);
	m.resolveEffectiveProjectPermissions.mockImplementation(
		async (_projectId: string, userId: string) => ACCESS[userId] ?? null,
	);
	m.getInstructionRepositorySyncForProposal.mockResolvedValue({
		allowReaderProposals: false,
	});
	m.getMemberProposalBranch.mockResolvedValue(branchRow());
	m.getHandle.mockReturnValue({ signal: m.signal });
	m.signal.mockResolvedValue(undefined);
	m.requestProposalBranchRefresh.mockResolvedValue({
		admitted: true,
		attempt: 4,
	});
	m.workflowResult.mockResolvedValue({ state: "CLOSED" });
	m.workflowStart.mockResolvedValue({ result: m.workflowResult });
	m.withDeadline.mockImplementation(
		async (_deadline: number, operation: () => unknown) => operation(),
	);
});

function expectWoken() {
	expect(m.getHandle).toHaveBeenCalledWith(WORKFLOW_ID);
	expect(m.signal).toHaveBeenCalledWith("wake");
}

describe("member proposal branch procedures", () => {
	it("all run behind instruction:read, with the live checks in the services", () => {
		expect(m.requiredPermissions).toEqual(["instruction:read"]);
		expect(Object.keys(m.handlers).sort()).toEqual(
			[
				MY_BRANCH,
				BRANCHES,
				FILE,
				CLOSE,
				START_OVER,
				RETRY,
				STOP,
				REFRESH,
				TRY_AGAIN,
				PROPOSE_AGAIN,
			].sort(),
		);
	});

	describe("refreshBranch", () => {
		it.each([OWNER, REVIEWER])(
			"observes an OPEN branch for %s through the bounded refresh workflow",
			async (caller) => {
				await expect(
					run(REFRESH, caller, {
						branchId: "branch_1",
						expectedAttempt: 4,
					}),
				).resolves.toEqual({ refreshed: true, pending: false });
				expect(m.requestProposalBranchRefresh).toHaveBeenCalledWith({
					branchId: "branch_1",
					projectId: "project_1",
					organizationId: "org_1",
					expectedAttempt: 4,
				});
				expect(m.workflowStart).toHaveBeenCalledWith(
					"projectInstructionProposalBranchRefreshWorkflow",
					expect.objectContaining({
						workflowId:
							"project-instruction-proposal-branch-refresh-branch_1-4",
						workflowIdConflictPolicy: "USE_EXISTING",
						workflowExecutionTimeout: "75 seconds",
						args: [
							expect.objectContaining({
								projectId: "project_1",
							}),
						],
					}),
				);
				expect(m.withDeadline).toHaveBeenCalledWith(
					expect.any(Number),
					expect.any(Function),
				);
			},
		);

		it("refuses a stale attempt before admitting provider work", async () => {
			await expect(
				run(REFRESH, OWNER, {
					branchId: "branch_1",
					expectedAttempt: 3,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				data: { reason: "BRANCH_CHANGED" },
			});
			expect(m.requestProposalBranchRefresh).not.toHaveBeenCalled();
		});

		it.each(["CLOSE_REQUESTED", "CLOSED", "MERGED"])(
			"settles quietly, not as BRANCH_CHANGED, for a %s branch whose attempt moved on",
			async (state) => {
				m.getMemberProposalBranch.mockResolvedValue(
					branchRow({ state, attempt: 6 }),
				);

				await expect(
					run(REFRESH, OWNER, {
						branchId: "branch_1",
						expectedAttempt: 4,
					}),
				).resolves.toEqual({ refreshed: false, pending: false });
				expect(m.requestProposalBranchRefresh).not.toHaveBeenCalled();
				expect(m.workflowStart).not.toHaveBeenCalled();
			},
		);

		it("does not start provider work when the atomic admission refuses cooldown", async () => {
			m.requestProposalBranchRefresh.mockResolvedValue({
				admitted: false,
				reason: "cooldown",
				retryAfterSeconds: 42,
			});
			await expect(
				run(REFRESH, OWNER, {
					branchId: "branch_1",
					expectedAttempt: 4,
				}),
			).rejects.toMatchObject({
				code: "TOO_MANY_REQUESTS",
				data: {
					reason: "PULL_REQUEST_REFRESH_COOLDOWN",
					retryAfter: 42,
				},
			});
			expect(m.workflowStart).not.toHaveBeenCalled();
		});

		it("is NOT_FOUND for another member before admitting provider work", async () => {
			await expect(
				run(REFRESH, OTHER, {
					branchId: "branch_1",
					expectedAttempt: 4,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.requestProposalBranchRefresh).not.toHaveBeenCalled();
		});
	});

	describe("refreshBranchOfProposal", () => {
		it("runs the branch's own refresh at the branch's current attempt", async () => {
			await refreshBranchOfProposal({
				projectId: "project_1",
				organizationId: "org_1",
				userId: OWNER,
				branchId: "branch_1",
			});

			expect(m.requestProposalBranchRefresh).toHaveBeenCalledWith({
				branchId: "branch_1",
				projectId: "project_1",
				organizationId: "org_1",
				expectedAttempt: 4,
			});
			expect(m.workflowStart).toHaveBeenCalledWith(
				"projectInstructionProposalBranchRefreshWorkflow",
				expect.objectContaining({
					args: [expect.objectContaining({ projectId: "project_1" })],
				}),
			);
		});

		it("is NOT_FOUND for another member and starts no provider work", async () => {
			await expect(
				refreshBranchOfProposal({
					projectId: "project_1",
					organizationId: "org_1",
					userId: OTHER,
					branchId: "branch_1",
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.requestProposalBranchRefresh).not.toHaveBeenCalled();
		});

		it("leaves a branch no longer OPEN to the sweeper", async () => {
			m.requestProposalBranchRefresh.mockResolvedValue(null);

			await expect(
				refreshBranchOfProposal({
					projectId: "project_1",
					organizationId: "org_1",
					userId: OWNER,
					branchId: "branch_1",
				}),
			).resolves.toBeUndefined();
			expect(m.workflowStart).not.toHaveBeenCalled();
		});
	});

	describe("myBranch", () => {
		beforeEach(() => {
			m.getAcceptingBranchForMember.mockResolvedValue(branchRow());
			m.listMemberBranches.mockResolvedValue([
				branchRow({ id: "branch_0", number: 2, state: "BLOCKED" }),
			]);
			m.countLiveBranchChanges.mockResolvedValue(
				new Map([
					["branch_1", 2],
					["branch_0", 1],
				]),
			);
			m.projectMemberBranch.mockResolvedValue([
				{
					path: "CLAUDE.md",
					state: "written",
					sha256: "a".repeat(64),
					snapshotId: "snap_1",
				},
			]);
		});

		it("returns the caller's own accepting branch, its projection and its panel branches, in the hosting organization", async () => {
			await expect(run(MY_BRANCH, OWNER, {})).resolves.toEqual({
				branch: {
					id: "branch_1",
					ref: "fabric/instructions/members/dev-example-abcd/3",
					number: 3,
					state: "OPEN",
					// The fence the panel passes back as `expectedAttempt`.
					attempt: 4,
					foreignCommits: false,
					membership: null,
					failure: null,
					retired: false,
					pullRequest: {
						url: "https://github.com/example-org/example-repo/pull/7",
						externalId: "7",
						state: "OPEN",
						lastCheckedAt: "2026-09-27T10:00:00.000Z",
					},
				},
				liveChanges: 2,
				files: [
					{
						path: "CLAUDE.md",
						state: "written",
						sha256: "a".repeat(64),
						snapshotId: "snap_1",
					},
				],
				branches: [
					{
						branch: expect.objectContaining({
							id: "branch_0",
							state: "BLOCKED",
							pullRequest: expect.objectContaining({
								state: "OPEN",
							}),
						}),
						liveChanges: 1,
					},
				],
			});
			expect(m.getAcceptingBranchForMember).toHaveBeenCalledWith({
				projectId: "project_1",
				userId: OWNER,
				organizationId: "org_1",
			});
		});

		it("lets a reviewer read another member's branch", async () => {
			await run(MY_BRANCH, REVIEWER, { userId: OWNER });
			expect(m.listMemberBranches).toHaveBeenCalledWith({
				projectId: "project_1",
				userId: OWNER,
				organizationId: "org_1",
			});
		});

		it.each([OTHER, GUEST])(
			"refuses %s another member's branch",
			async (caller) => {
				await expect(
					run(MY_BRANCH, caller, { userId: OWNER }),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(m.listMemberBranches).not.toHaveBeenCalled();
			},
		);
	});

	// Review finding (round 2): the proposal list's own pagination used to be
	// the only way a reviewer discovered a member's branch, so a member whose
	// proposals weren't on the current page got no panel at all — the spec's
	// "Reviewers see every member's branches read-only" needs a read that
	// does not depend on that pagination.
	// Round-3 review finding: owner discovery used to read EVERY tracked
	// branch in the project and cap the owner list in memory, silently
	// dropping owners past the cap. `listProposalBranchOwnerIds` is now the
	// bounded, cursor-paged discovery query (its own real-Postgres behaviour
	// — ordering, the cursor, caller exclusion, tenant scoping — is pinned in
	// `instruction-proposal-branches.integration.test.ts`); this suite pins
	// how the PROCEDURE calls it and turns its page into owner views.
	describe("branches (reviewer aggregate read, Fizzy #2738 spec §10)", () => {
		beforeEach(() => {
			m.listProposalBranchOwnerIds.mockResolvedValue({
				ownerIds: [OWNER, OTHER],
				nextCursor: null,
			});
			m.listMemberBranches.mockImplementation(
				async ({ userId }: { userId: string | null }) =>
					userId === OWNER
						? [
								branchRow({
									id: "branch_1",
									userId: OWNER,
									number: 3,
								}),
							]
						: userId === OTHER
							? [
									branchRow({
										id: "branch_2",
										userId: OTHER,
										number: 1,
										state: "BLOCKED",
									}),
								]
							: [],
			);
			m.getAcceptingBranchForMember.mockImplementation(
				async ({ userId }: { userId: string }) =>
					userId === OWNER
						? branchRow({ id: "branch_1", userId: OWNER })
						: null,
			);
			m.countLiveBranchChanges.mockResolvedValue(new Map());
			m.projectMemberBranch.mockResolvedValue([]);
			m.getUsersByIds.mockResolvedValue(
				new Map([
					[OWNER, { id: OWNER, name: "Case Worker" }],
					[OTHER, { id: OTHER, name: "Other Member" }],
				]),
			);
		});

		it("lets a reviewer read every tracked member's branch, named, independent of any proposal page", async () => {
			const result = (await run(BRANCHES, REVIEWER, {})) as {
				owners: Array<{ userId: string; userName: string | null }>;
				nextCursor: string | null;
			};

			expect(result.nextCursor).toBeNull();
			expect(
				result.owners.map((o) => ({
					userId: o.userId,
					userName: o.userName,
				})),
			).toEqual([
				{ userId: OWNER, userName: "Case Worker" },
				{ userId: OTHER, userName: "Other Member" },
			]);
			// The caller's own id is excluded AT THE QUERY, not filtered
			// afterward — branches are then read only for that page's
			// owners (never "every tracked branch" first).
			expect(m.listProposalBranchOwnerIds).toHaveBeenCalledWith({
				projectId: "project_1",
				organizationId: "org_1",
				excludeUserId: REVIEWER,
				limit: 20,
			});
			expect(m.listMemberBranches).not.toHaveBeenCalledWith(
				expect.objectContaining({ userId: null }),
			);
		});

		it("passes the caller's cursor through and returns the query's nextCursor unchanged", async () => {
			m.listProposalBranchOwnerIds.mockResolvedValue({
				ownerIds: [OTHER],
				nextCursor: "member_9",
			});

			const result = (await run(BRANCHES, REVIEWER, {
				cursor: "member_2",
				limit: 5,
			})) as { nextCursor: string | null };

			expect(m.listProposalBranchOwnerIds).toHaveBeenCalledWith({
				projectId: "project_1",
				organizationId: "org_1",
				excludeUserId: REVIEWER,
				cursor: "member_2",
				limit: 5,
			});
			expect(result.nextCursor).toBe("member_9");
		});

		it("clamps an oversized limit at the page-size ceiling before querying", async () => {
			await run(BRANCHES, REVIEWER, { limit: 999 });

			expect(m.listProposalBranchOwnerIds).toHaveBeenCalledWith(
				expect.objectContaining({ limit: 50 }),
			);
		});

		it.each([OWNER, GUEST])(
			"refuses %s the reviewer aggregate read",
			async (caller) => {
				await expect(run(BRANCHES, caller, {})).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				expect(m.listProposalBranchOwnerIds).not.toHaveBeenCalled();
				expect(m.getUsersByIds).not.toHaveBeenCalled();
			},
		);

		// Stands in for a cross-organization caller: nobody who resolves to
		// no access at all in THIS project's hosting organization — the only
		// organization `requireHostingOrganizationId` ever uses here,
		// regardless of the caller's own `session.activeOrganizationId`
		// ("wrong_org" for every context in this file) — may read it.
		it("refuses a caller with no access in the project's hosting organization", async () => {
			await expect(run(BRANCHES, "stranger_1", {})).rejects.toMatchObject(
				{ code: "FORBIDDEN" },
			);
		});

		it("renders no owners and reads no branches when the query's page is empty", async () => {
			m.listProposalBranchOwnerIds.mockResolvedValue({
				ownerIds: [],
				nextCursor: null,
			});

			const result = (await run(BRANCHES, REVIEWER, {})) as {
				owners: unknown[];
				nextCursor: string | null;
			};

			expect(result).toEqual({ owners: [], nextCursor: null });
			expect(m.getAcceptingBranchForMember).not.toHaveBeenCalled();
			expect(m.getUsersByIds).not.toHaveBeenCalled();
		});
	});

	describe("myBranchFile", () => {
		const FILE_ROW = {
			path: "CLAUDE.md",
			projectId: "project_1",
			storageKey: "k/1",
			sha256: "a".repeat(64),
			size: 11,
			mimeType: "text/markdown",
			isText: true,
			mode: null,
		};

		beforeEach(() => {
			m.projectMemberBranch.mockResolvedValue([
				{
					path: "CLAUDE.md",
					state: "written",
					sha256: "a".repeat(64),
					snapshotId: "snap_1",
				},
				{
					path: "rules/gone.md",
					state: "restored_unavailable",
					sha256: null,
					snapshotId: null,
				},
			]);
			m.getInstructionFileByPath.mockResolvedValue(FILE_ROW);
			m.downloadFile.mockResolvedValue({
				data: Buffer.from("hello world"),
			});
		});

		it("pages the text Fabric wrote, for the owner and a reviewer", async () => {
			for (const caller of [OWNER, REVIEWER]) {
				await expect(
					run(FILE, caller, {
						branchId: "branch_1",
						path: "CLAUDE.md",
						offset: 6,
						maxLength: 3,
					}),
				).resolves.toMatchObject({
					branchId: "branch_1",
					snapshotId: "snap_1",
					body: "wor",
					offset: 6,
					nextOffset: 9,
					truncated: true,
					url: null,
				});
			}
			expect(m.getInstructionFileByPath).toHaveBeenCalledWith(
				"snap_1",
				"org_1",
				"CLAUDE.md",
			);
		});

		it("reads a native PUT without full snapshot rows and refuses an absent native path", async () => {
			m.loadGitIntent.mockResolvedValue({
				status: "READY",
				gitIntentEntries: [{ ...FILE_ROW, operation: "PUT" }],
			});
			await expect(
				run(FILE, OWNER, {
					branchId: "branch_1",
					path: "CLAUDE.md",
					offset: 0,
				}),
			).resolves.toMatchObject({ body: "hello world" });
			expect(m.getInstructionFileByPath).not.toHaveBeenCalled();
			m.loadGitIntent.mockResolvedValue({
				status: "READY",
				gitIntentEntries: [],
			});
			await expect(
				run(FILE, OWNER, {
					branchId: "branch_1",
					path: "CLAUDE.md",
					offset: 0,
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				data: { reason: "BRANCH_FILE_UNAVAILABLE" },
			});
			expect(m.getInstructionFileByPath).not.toHaveBeenCalled();
		});

		it("gives a binary as a signed URL", async () => {
			m.getInstructionFileByPath.mockResolvedValue({
				...FILE_ROW,
				isText: false,
			});
			m.getSignedUrl.mockResolvedValue(
				"https://storage.example.com/signed",
			);
			await expect(
				run(FILE, OWNER, {
					branchId: "branch_1",
					path: "CLAUDE.md",
					offset: 0,
				}),
			).resolves.toMatchObject({
				body: null,
				url: "https://storage.example.com/signed",
			});
		});

		it("is NOT_FOUND for another member, and never other content", async () => {
			await expect(
				run(FILE, OTHER, {
					branchId: "branch_1",
					path: "CLAUDE.md",
					offset: 0,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				run(FILE, OWNER, {
					branchId: "branch_1",
					path: "rules/gone.md",
					offset: 0,
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				data: { reason: "BRANCH_FILE_UNAVAILABLE" },
			});
			m.getInstructionFileByPath.mockResolvedValue({
				...FILE_ROW,
				sha256: "b".repeat(64),
			});
			await expect(
				run(FILE, OWNER, {
					branchId: "branch_1",
					path: "CLAUDE.md",
					offset: 0,
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				data: { reason: "BRANCH_FILE_UNAVAILABLE" },
			});
			expect(m.downloadFile).not.toHaveBeenCalled();
		});
	});

	describe("closeBranch", () => {
		it("closes the owner's branch at the attempt the tab showed, then wakes it", async () => {
			m.closeProposalBranch.mockResolvedValue({
				kind: "done",
				changed: true,
				attempt: 5,
			});
			await expect(
				run(CLOSE, OWNER, { branchId: "branch_1", expectedAttempt: 4 }),
			).resolves.toEqual({ changed: true, attempt: 5 });
			expect(m.closeProposalBranch).toHaveBeenCalledWith({
				branchId: "branch_1",
				projectId: "project_1",
				organizationId: "org_1",
				expectedAttempt: 4,
				requester: REQUESTER,
			});
			expectWoken();
		});

		it("wakes nothing for a repeat that changed nothing", async () => {
			m.closeProposalBranch.mockResolvedValue({
				kind: "done",
				changed: false,
				attempt: 5,
			});
			await expect(
				run(CLOSE, OWNER, { branchId: "branch_1", expectedAttempt: 5 }),
			).resolves.toEqual({ changed: false, attempt: 5 });
			expect(m.getHandle).not.toHaveBeenCalled();
		});

		it.each([REVIEWER, OTHER, GUEST])(
			"is NOT_FOUND for %s, who does not own the branch",
			async (caller) => {
				await expect(
					run(CLOSE, caller, {
						branchId: "branch_1",
						expectedAttempt: 4,
					}),
				).rejects.toMatchObject({ code: "NOT_FOUND" });
				expect(m.closeProposalBranch).not.toHaveBeenCalled();
			},
		);

		it("maps a stale attempt and a closed branch to their refusals", async () => {
			m.closeProposalBranch.mockResolvedValueOnce({ kind: "stale" });
			await expect(
				run(CLOSE, OWNER, { branchId: "branch_1", expectedAttempt: 3 }),
			).rejects.toMatchObject({
				code: "CONFLICT",
				data: { reason: "BRANCH_CHANGED" },
			});
			m.closeProposalBranch.mockResolvedValueOnce({
				kind: "not_applicable",
			});
			await expect(
				run(CLOSE, OWNER, { branchId: "branch_1", expectedAttempt: 4 }),
			).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
				data: { reason: "BRANCH_ACTION_NOT_AVAILABLE" },
			});
			expect(m.getHandle).not.toHaveBeenCalled();
		});

		it("logs a failed wake and still answers: the command committed", async () => {
			const error = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			m.closeProposalBranch.mockResolvedValue({
				kind: "done",
				changed: true,
				attempt: 5,
			});
			m.signal.mockRejectedValue(new Error("temporal unavailable"));
			await expect(
				run(CLOSE, OWNER, { branchId: "branch_1", expectedAttempt: 4 }),
			).resolves.toEqual({ changed: true, attempt: 5 });
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining("could not wake"),
				{ branchId: "branch_1" },
				expect.any(Error),
			);
			error.mockRestore();
		});
	});

	describe("startOverBranch and retryBranch", () => {
		it.each([
			[START_OVER, "startOverProposalBranch"],
			[RETRY, "requestProposalBranchRetry"],
		] as const)(
			"%s runs for the owner who may still propose, and wakes the branch",
			async (path, fn) => {
				m[fn].mockResolvedValue({
					kind: "done",
					changed: true,
					attempt: 5,
				});
				await expect(
					run(path, OWNER, {
						branchId: "branch_1",
						expectedAttempt: 4,
					}),
				).resolves.toEqual({ changed: true, attempt: 5 });
				expectWoken();
			},
		);

		it("lets a reader propose only while the project allows reader proposals", async () => {
			const reader = "reader_1";
			ACCESS[reader] = {
				source: "org",
				organizationId: "org_1",
				permissions: [P.INSTRUCTION_READ],
			};
			m.getMemberProposalBranch.mockResolvedValue(
				branchRow({ userId: reader }),
			);
			m.requestProposalBranchRetry.mockResolvedValue({
				kind: "done",
				changed: true,
				attempt: 5,
			});
			await expect(
				run(RETRY, reader, {
					branchId: "branch_1",
					expectedAttempt: 4,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(m.requestProposalBranchRetry).not.toHaveBeenCalled();

			m.getInstructionRepositorySyncForProposal.mockResolvedValue({
				allowReaderProposals: true,
			});
			await expect(
				run(RETRY, reader, {
					branchId: "branch_1",
					expectedAttempt: 4,
				}),
			).resolves.toEqual({ changed: true, attempt: 5 });
			delete ACCESS[reader];
		});

		it("refuses an owner who can no longer propose (an invited guest with read only)", async () => {
			m.getMemberProposalBranch.mockResolvedValue(
				branchRow({ userId: GUEST }),
			);
			await expect(
				run(START_OVER, GUEST, {
					branchId: "branch_1",
					expectedAttempt: 4,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(m.startOverProposalBranch).not.toHaveBeenCalled();
		});

		it("is NOT_FOUND for a reviewer: neither is theirs to run", async () => {
			for (const path of [START_OVER, RETRY]) {
				await expect(
					run(path, REVIEWER, {
						branchId: "branch_1",
						expectedAttempt: 4,
					}),
				).rejects.toMatchObject({ code: "NOT_FOUND" });
			}
		});
	});

	describe("stopTrackingBranch", () => {
		const repositoryChanged = () =>
			m.getMemberProposalBranch.mockResolvedValue(
				branchRow({
					state: "BLOCKED",
					failure: {
						code: "REPOSITORY_CHANGED",
						retryable: false,
						phase: "create",
					},
				}),
			);

		it.each([OWNER, REVIEWER])(
			"stops tracking a REPOSITORY_CHANGED branch for %s, then wakes it",
			async (caller) => {
				repositoryChanged();
				m.stopTrackingBranch.mockResolvedValue({ ok: true });
				await expect(
					run(STOP, caller, {
						branchId: "branch_1",
						expectedAttempt: 4,
					}),
				).resolves.toEqual({ changed: true, attempt: 5 });
				expect(m.stopTrackingBranch).toHaveBeenCalledWith({
					branchId: "branch_1",
					organizationId: "org_1",
					actorUserId: caller,
				});
				expectWoken();
			},
		);

		it("is NOT_FOUND for another member", async () => {
			repositoryChanged();
			await expect(
				run(STOP, OTHER, { branchId: "branch_1", expectedAttempt: 4 }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		it("is offered only for REPOSITORY_CHANGED, at the attempt shown", async () => {
			await expect(
				run(STOP, OWNER, { branchId: "branch_1", expectedAttempt: 4 }),
			).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
				data: { reason: "BRANCH_ACTION_NOT_AVAILABLE" },
			});
			repositoryChanged();
			await expect(
				run(STOP, OWNER, { branchId: "branch_1", expectedAttempt: 3 }),
			).rejects.toMatchObject({
				code: "CONFLICT",
				data: { reason: "BRANCH_CHANGED" },
			});
			expect(m.stopTrackingBranch).not.toHaveBeenCalled();
			expect(m.getHandle).not.toHaveBeenCalled();
		});
	});

	describe("retryConflict (Try again)", () => {
		it.each([
			[
				{
					kind: "queued",
					branchId: "branch_1",
					attempt: 3,
					sequence: 9,
					pendingCommandSeq: 12,
				},
				{ state: "QUEUED", attempt: 3 },
			],
			[
				{ kind: "open", branchId: "branch_1", attempt: 3 },
				{ state: "OPEN", attempt: 3 },
			],
		])("answers %o as %o and wakes the branch", async (result, answer) => {
			m.tryBranchProposalAgain.mockResolvedValue(result);
			await expect(
				run(TRY_AGAIN, OWNER, {
					snapshotId: "snap_1",
					expectedAttempt: 2,
				}),
			).resolves.toEqual(answer);
			expect(m.tryBranchProposalAgain).toHaveBeenCalledWith({
				snapshotId: "snap_1",
				projectId: "project_1",
				organizationId: "org_1",
				proposerUserId: OWNER,
				expectedAttempt: 2,
				requester: REQUESTER,
			});
			expectWoken();
		});

		it.each([
			[{ kind: "not_found" }, "NOT_FOUND", undefined],
			[{ kind: "stale" }, "CONFLICT", "PROPOSAL_CHANGED"],
			[
				{ kind: "not_applicable" },
				"PRECONDITION_FAILED",
				"PROPOSAL_NOT_RETRYABLE",
			],
			[
				{ kind: "branch_not_accepting" },
				"PRECONDITION_FAILED",
				"BRANCH_NOT_ACCEPTING",
			],
		])("maps %o to %s", async (result, code, reason) => {
			m.tryBranchProposalAgain.mockResolvedValue(result);
			const refusal = run(TRY_AGAIN, OWNER, {
				snapshotId: "snap_1",
				expectedAttempt: 2,
			});
			await expect(refusal).rejects.toMatchObject({
				code,
				...(reason ? { data: { reason } } : {}),
			});
			expect(m.getHandle).not.toHaveBeenCalled();
		});

		it("refuses a caller who can no longer propose before touching the row", async () => {
			await expect(
				run(TRY_AGAIN, GUEST, {
					snapshotId: "snap_1",
					expectedAttempt: 2,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(m.tryBranchProposalAgain).not.toHaveBeenCalled();
		});
	});

	describe("proposeAgain", () => {
		it("moves the change to the member's branch and wakes that branch", async () => {
			m.proposeBranchProposalAgain.mockResolvedValue({
				kind: "joined",
				branchId: "branch_1",
				sequence: 4,
				assignment: 2,
			});
			await expect(
				run(PROPOSE_AGAIN, OWNER, { snapshotId: "snap_1" }),
			).resolves.toEqual({ branchId: "branch_1", sequence: 4 });
			expect(m.proposeBranchProposalAgain).toHaveBeenCalledWith(
				expect.objectContaining({
					snapshotId: "snap_1",
					projectId: "project_1",
					organizationId: "org_1",
					proposerUserId: OWNER,
					requester: REQUESTER,
					naming: expect.objectContaining({
						memberBranchRef: expect.any(Function),
						repositoryIdentity: expect.any(Function),
						repositoryKey: expect.any(Function),
					}),
				}),
			);
			expectWoken();
		});

		it.each([
			[{ kind: "not_found" }, "NOT_FOUND", undefined],
			[
				{ kind: "configuration_changed" },
				"PRECONDITION_FAILED",
				"CONFIGURATION_CHANGED",
			],
			[
				{ kind: "not_applicable" },
				"PRECONDITION_FAILED",
				"PROPOSAL_NOT_PROPOSABLE",
			],
			[
				{ kind: "not_joinable" },
				"PRECONDITION_FAILED",
				"PROPOSAL_NOT_PROPOSABLE",
			],
		])("maps %o to %s", async (result, code, reason) => {
			m.proposeBranchProposalAgain.mockResolvedValue(result);
			await expect(
				run(PROPOSE_AGAIN, OWNER, { snapshotId: "snap_1" }),
			).rejects.toMatchObject({
				code,
				...(reason ? { data: { reason } } : {}),
			});
			expect(m.getHandle).not.toHaveBeenCalled();
		});

		it("refuses a caller who can no longer propose", async () => {
			await expect(
				run(PROPOSE_AGAIN, GUEST, { snapshotId: "snap_1" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(m.proposeBranchProposalAgain).not.toHaveBeenCalled();
		});
	});
});

describe("pullRequestView with a member branch (spec §10)", () => {
	const row = {
		pullRequestOperationId: "op_1",
		pullRequestState: "OPEN" as const,
		pullRequestUrl: "https://github.com/example-org/example-repo/pull/1",
		pullRequestExternalId: "1",
		pullRequestFailure: null,
		pullRequestLastCheckedAt: null,
	};

	it("takes url and externalId from the branch and state from the proposal, with branch and append blocks", () => {
		const attachment = {
			snapshotId: "snap_1",
			branch: branchRow({ state: "OPENING" }),
			assignment: 1,
			state: "OPEN",
			failure: null,
			ops: [
				{
					id: "op_a",
					kind: "APPEND",
					executionSeq: 1,
					assignment: 1,
					branchId: "branch_1",
					outcome: "acked",
					sha: "c".repeat(40),
					membership: null,
				},
			],
		};
		expect(
			pullRequestView(
				row,
				attachment as unknown as Parameters<typeof pullRequestView>[1],
			),
		).toEqual({
			operationId: "op_1",
			state: "OPEN",
			url: "https://github.com/example-org/example-repo/pull/7",
			externalId: "7",
			failure: null,
			lastCheckedAt: new Date("2026-09-27T10:00:00Z"),
			branch: expect.objectContaining({
				id: "branch_1",
				state: "OPENING",
				pullRequest: expect.objectContaining({ externalId: "7" }),
			}),
			append: {
				outcome: "appended",
				commitSha: "c".repeat(40),
				membership: null,
			},
		});
	});

	it("keeps a #2563 row's own pull request, with null blocks", () => {
		expect(pullRequestView(row)).toMatchObject({
			url: "https://github.com/example-org/example-repo/pull/1",
			externalId: "1",
			branch: null,
			append: null,
		});
	});
});
