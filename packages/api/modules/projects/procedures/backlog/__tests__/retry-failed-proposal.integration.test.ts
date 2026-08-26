/**
 * Real-Postgres integration tests for `retryFailedProposalProcedure`.
 *
 * Cases covered:
 *   1. Full approve → fail → retry → success cycle: seed a FAILED
 *      `PendingBacklogProposal`; call retry; assert the workflow start was
 *      issued with the filtered payload (indexes of the still-failing
 *      changes); assert the row is flipped to PENDING with the new
 *      `applyWorkflowId`.
 *   2. Dedup-collision retry: pre-seed a UserStory whose title matches
 *      the FAILED proposal's first change; call retry; assert the proposal
 *      transitions to APPLIED linked (logically) to the existing story;
 *      assert NO duplicate UserStory row is created; assert
 *      `dedupCollisionCount === 1`.
 *   3. Tenant-XOR cross-org test: call retry cross-tenant (org-A user,
 *      org-B proposalId) → FORBIDDEN; no row data leaks into the error
 *      payload.
 *
 * Boundary mocks:
 *   - `@repo/temporal` — `getTemporalClient` returns a captured
 *     `workflow.start` spy. No live Temporal worker is required.
 *
 * Tenant XOR:
 *   - Every seeded row carries `{ organizationId, userId }`. The retry
 *     procedure resolves the same pair and verifies it on every load.
 *
 * Skip-gate: `hasReachableDb()` rejects an unset `DATABASE_URL` AND the
 * CI placeholder URL — mirrors the canonical helper in
 * `packages/database/__tests__/_helpers/db-availability.ts`.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		workflowStart: vi.fn(),
		getTemporalClient: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["retry"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../retry-failed-proposal");

// Pull the live DB AFTER the mocks above so the procedure module sees the
// stubbed `@repo/temporal` but the test exercises real Postgres.
const { db, Prisma } = await import("@repo/database");

// Mirror of the canonical db-availability skip-gate (inlined to avoid an
// internal package path).
const CI_PLACEHOLDER_DATABASE_URL =
	"postgresql://test:test@localhost:5432/test";
function hasReachableDb(): boolean {
	const url = process.env.DATABASE_URL;
	if (!url) {
		return false;
	}
	if (url === CI_PLACEHOLDER_DATABASE_URL) {
		return false;
	}
	return true;
}

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_A = `retry-int-orgA-${RUN_ID}`;
const ORG_B = `retry-int-orgB-${RUN_ID}`;
const USER_A = `retry-int-userA-${RUN_ID}`;
const USER_B = `retry-int-userB-${RUN_ID}`;

describe.skipIf(!hasReachableDb())(
	"retryFailedProposalProcedure (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const userId of [USER_A, USER_B]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
					VALUES (${userId}, ${`Retry Int ${userId}`}, ${`${userId}@test.com`}, true, false, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			for (const orgId of [ORG_A, ORG_B]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "organization" (id, name, slug, "createdAt")
					VALUES (${orgId}, ${`Retry Int ${orgId}`}, ${orgId}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
		});

		afterAll(async () => {
			await db.pendingBacklogProposal.deleteMany({
				where: { userId: { in: [USER_A, USER_B] } },
			});
			await db.userStory.deleteMany({
				where: { project: { userId: { in: [USER_A, USER_B] } } },
			});
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: { in: [USER_A, USER_B] } } },
			});
			await db.project.deleteMany({
				where: { userId: { in: [USER_A, USER_B] } },
			});
			await db.organization.deleteMany({
				where: { id: { in: [ORG_A, ORG_B] } },
			});
			await db.user.deleteMany({
				where: { id: { in: [USER_A, USER_B] } },
			});
		});

		beforeEach(() => {
			mocks.workflowStart.mockReset();
			mocks.getTemporalClient.mockReset();
			mocks.workflowStart.mockResolvedValue({
				workflowId: "wf-retry-new",
				firstExecutionRunId: "run-retry-new",
			});
			mocks.getTemporalClient.mockResolvedValue({
				workflow: { start: mocks.workflowStart },
			});
		});

		afterEach(async () => {
			await db.pendingBacklogProposal.deleteMany({
				where: { userId: { in: [USER_A, USER_B] } },
			});
			await db.userStory.deleteMany({
				where: { project: { userId: { in: [USER_A, USER_B] } } },
			});
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: { in: [USER_A, USER_B] } } },
			});
			await db.project.deleteMany({
				where: { userId: { in: [USER_A, USER_B] } },
			});
		});

		async function seedProject(args: {
			orgId: string;
			userId: string;
			name: string;
		}) {
			const project = await db.project.create({
				data: {
					name: args.name,
					userId: args.userId,
					organizationId: args.orgId,
				},
			});
			await db.projectStoryStatus.create({
				data: {
					projectId: project.id,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			return project;
		}

		async function getDefaultStatusId(projectId: string): Promise<string> {
			const status = await db.projectStoryStatus.findFirstOrThrow({
				where: { projectId, isDefault: true },
			});
			return status.id;
		}

		async function seedFailedProposal(args: {
			projectId: string;
			userId: string;
			organizationId: string;
			changes: Array<{
				type: string;
				action: string;
				title: { to: string };
				reasoning?: string;
				sourceContext?: string;
			}>;
			appliedChangeIndexes?: number[];
		}) {
			const row = await db.pendingBacklogProposal.create({
				data: {
					projectId: args.projectId,
					userId: args.userId,
					organizationId: args.organizationId,
					source: "AI_UPDATE_SIDEBAR",
					status: "FAILED",
					proposal: {
						changes: args.changes,
					} as unknown as object,
					summary: `${args.changes.length} proposed change(s) from AI Update`,
					changeCount: args.changes.length,
					sourceMetadata: {
						syncToPM: false,
						pmConfig: null,
						conversationId: null,
					} as unknown as object,
					applyError: "synthetic failure",
					errorClass: "default",
					errorMessage: "synthetic failure",
					failedAt: new Date(),
					applyWorkflowId: "wf-prev-1",
					appliedChangeIndexes: args.appliedChangeIndexes ?? [],
				},
			});
			return row;
		}

		it("happy path: filters payload, flips status to PENDING, queues workflow", async () => {
			const project = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "Retry Cycle Project",
			});
			const failed = await seedFailedProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
				changes: [
					{
						type: "feature",
						action: "create",
						title: { to: "First survivor change" },
						reasoning: "",
						sourceContext: "multiple",
					},
					{
						type: "feature",
						action: "create",
						title: { to: "Second survivor change" },
						reasoning: "",
						sourceContext: "multiple",
					},
				],
				appliedChangeIndexes: [],
			});

			const result = (await handlers.retry({
				input: {
					projectId: project.id,
					proposalId: failed.id,
					organizationId: ORG_A,
				},
				context: { user: { id: USER_A }, session: {} },
			})) as {
				workflowId: string | null;
				dedupCollisionCount: number;
				message: string;
			};

			expect(result.workflowId).toBe("wf-retry-new");
			expect(result.dedupCollisionCount).toBe(0);

			// Workflow start received both changes (no dedup hits) under the
			// fresh `pendingProposalId` referencing the SAME row.
			expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
			const startArgs = mocks.workflowStart.mock.calls[0]?.[1] as {
				args: Array<{
					approvedChanges: unknown[];
					approvedChangeIndexes: number[];
					pendingProposalId: string;
				}>;
			};
			expect(startArgs.args[0]?.approvedChanges).toHaveLength(2);
			expect(startArgs.args[0]?.approvedChangeIndexes).toEqual([0, 1]);
			expect(startArgs.args[0]?.pendingProposalId).toBe(failed.id);

			const reread = await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: failed.id },
			});
			expect(reread.status).toBe("PENDING");
			expect(reread.applyError).toBeNull();
			expect(reread.errorClass).toBeNull();
		});

		it("dedup-collision: marks APPLIED linked to existing UserStory, no duplicate", async () => {
			const project = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "Retry Dedup Project",
			});
			// Pre-seed a UserStory whose title matches the proposed change.
			// `buildBacklogDedupGuard` normalizes case + trim + [BUG] prefix.
			const existingStory = await db.userStory.create({
				data: {
					title: "Existing colliding feature",
					description: "",
					projectId: project.id,
					statusId: await getDefaultStatusId(project.id),
					identifier: `EX-${Date.now()}`,
					kind: "FEATURE",
					createdById: USER_A,
				},
			});
			const failed = await seedFailedProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
				changes: [
					{
						type: "feature",
						action: "create",
						title: { to: "  Existing Colliding Feature  " },
						reasoning: "",
						sourceContext: "multiple",
					},
				],
			});

			const beforeCount = await db.userStory.count({
				where: { projectId: project.id },
			});
			expect(beforeCount).toBe(1);

			const result = (await handlers.retry({
				input: {
					projectId: project.id,
					proposalId: failed.id,
					organizationId: ORG_A,
				},
				context: { user: { id: USER_A }, session: {} },
			})) as { workflowId: string | null; dedupCollisionCount: number };

			expect(result.workflowId).toBeNull();
			expect(result.dedupCollisionCount).toBe(1);
			expect(mocks.workflowStart).not.toHaveBeenCalled();

			// Proposal flipped to APPLIED — collision resolved without
			// touching any existing story or creating a new one.
			const reread = await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: failed.id },
			});
			expect(reread.status).toBe("APPLIED");

			const afterCount = await db.userStory.count({
				where: { projectId: project.id },
			});
			expect(afterCount).toBe(1);
			// Existing story untouched (title kept as seeded).
			const existingReread = await db.userStory.findUniqueOrThrow({
				where: { id: existingStory.id },
			});
			expect(existingReread.title).toBe("Existing colliding feature");
		});

		it("tenant-XOR cross-org: rejects FORBIDDEN; no row data in payload", async () => {
			const projectA = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "Cross-org Project A",
			});
			const failedA = await seedFailedProposal({
				projectId: projectA.id,
				userId: USER_A,
				organizationId: ORG_A,
				changes: [
					{
						type: "feature",
						action: "create",
						title: { to: "private to A" },
						reasoning: "",
						sourceContext: "multiple",
					},
				],
			});

			// Caller is user-B from org-B; the proposalId belongs to org-A.
			let captured: { code: string; message: string } | null = null;
			try {
				await handlers.retry({
					input: {
						projectId: projectA.id,
						proposalId: failedA.id,
						organizationId: ORG_B,
					},
					context: { user: { id: USER_B }, session: {} },
				});
			} catch (err: unknown) {
				captured = err as { code: string; message: string };
			}
			expect(captured).not.toBeNull();
			expect(captured?.code).toBe("FORBIDDEN");
			// Generic message — never leaks the proposal title or any of the
			// row's payload fields.
			expect(captured?.message).not.toContain("private to A");
			expect(captured?.message).not.toContain(failedA.id);

			// Sanity: the row was not mutated by the foreign caller.
			const reread = await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: failedA.id },
			});
			expect(reread.status).toBe("FAILED");
			expect(mocks.workflowStart).not.toHaveBeenCalled();
		});
	},
);
