/**
 * Real-Postgres integration tests for `dismissFailedProposalProcedure`.
 *
 * Cases covered:
 *   1. Seeds a FAILED row, calls dismiss, asserts:
 *      - The `PendingBacklogProposal` row is gone.
 *      - Exactly one new `PmSyncLog` row exists with `status=FAILURE`,
 *        `errorPayload.errorClass === <original>`,
 *        `errorPayload.changes === <original payload>`,
 *        `correlationId === <original applyWorkflowId>`,
 *        `projectId/organizationId/userId` matching tenancy.
 *   2. Tenant XOR cross-org dismiss is rejected with FORBIDDEN; the row is
 *      not deleted; no PmSyncLog row is written.
 *
 * Skip-gate: `hasReachableDb()` rejects an unset / placeholder
 * `DATABASE_URL`. Mirrors the canonical helper.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const { handlers } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	return { handlers };
});

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["dismiss"];
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

await import("../dismiss-failed-proposal");
const { db, Prisma } = await import("@repo/database");

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
const ORG_A = `dismiss-int-orgA-${RUN_ID}`;
const ORG_B = `dismiss-int-orgB-${RUN_ID}`;
const USER_A = `dismiss-int-userA-${RUN_ID}`;
const USER_B = `dismiss-int-userB-${RUN_ID}`;

describe.skipIf(!hasReachableDb())(
	"dismissFailedProposalProcedure (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const userId of [USER_A, USER_B]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
					VALUES (${userId}, ${`Dismiss Int ${userId}`}, ${`${userId}@test.com`}, true, false, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			for (const orgId of [ORG_A, ORG_B]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "organization" (id, name, slug, "createdAt")
					VALUES (${orgId}, ${`Dismiss Int ${orgId}`}, ${orgId}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
		});

		afterAll(async () => {
			await db.pmSyncLog.deleteMany({
				where: { userId: { in: [USER_A, USER_B] } },
			});
			await db.pendingBacklogProposal.deleteMany({
				where: { userId: { in: [USER_A, USER_B] } },
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

		afterEach(async () => {
			await db.pmSyncLog.deleteMany({
				where: { userId: { in: [USER_A, USER_B] } },
			});
			await db.pendingBacklogProposal.deleteMany({
				where: { userId: { in: [USER_A, USER_B] } },
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
			return await db.project.create({
				data: {
					name: args.name,
					userId: args.userId,
					organizationId: args.orgId,
				},
			});
		}

		async function seedFailedProposal(args: {
			projectId: string;
			userId: string;
			organizationId: string;
		}) {
			return await db.pendingBacklogProposal.create({
				data: {
					projectId: args.projectId,
					userId: args.userId,
					organizationId: args.organizationId,
					source: "AI_UPDATE_SIDEBAR",
					status: "FAILED",
					proposal: {
						changes: [
							{
								type: "feature",
								action: "create",
								title: { to: "Audit me on dismiss" },
								reasoning: "",
								sourceContext: "multiple",
							},
						],
					} as unknown as object,
					summary: "1 proposed change(s) from AI Update",
					changeCount: 1,
					sourceMetadata: {
						syncToPM: true,
						pmConfig: {
							mcpConfigId: "mcp-x",
							containerId: "container-x",
						},
						conversationId: null,
					} as unknown as object,
					applyError: "Original failure trace",
					errorClass: "PmAuthError",
					errorMessage: "auth bad",
					failedAt: new Date(),
					applyWorkflowId: "wf-prev-dismiss",
				},
			});
		}

		it("writes a PmSyncLog FAILURE row and deletes the proposal", async () => {
			const project = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "Dismiss Project A",
			});
			const failed = await seedFailedProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
			});

			const result = (await handlers.dismiss({
				input: {
					projectId: project.id,
					proposalId: failed.id,
					organizationId: ORG_A,
				},
				context: { user: { id: USER_A }, session: {} },
			})) as { success: boolean; syncLogId: string };

			expect(result.success).toBe(true);

			// Row hard-deleted.
			const gone = await db.pendingBacklogProposal.findUnique({
				where: { id: failed.id },
			});
			expect(gone).toBeNull();

			// Exactly one PmSyncLog row with the expected snapshot.
			const logs = await db.pmSyncLog.findMany({
				where: { userId: USER_A, projectId: project.id },
			});
			expect(logs).toHaveLength(1);
			const log = logs[0];
			expect(log).toBeDefined();
			if (!log) {
				return;
			}
			expect(log.id).toBe(result.syncLogId);
			expect(log.status).toBe("FAILURE");
			expect(log.direction).toBe("push");
			expect(log.entityType).toBe("STORY");
			expect(log.pmTool).toBe("mcp-x");
			expect(log.correlationId).toBe("wf-prev-dismiss");
			expect(log.actorUserId).toBe(USER_A);
			expect(log.projectId).toBe(project.id);
			expect(log.organizationId).toBe(ORG_A);
			expect(log.userId).toBe(USER_A);

			const errorPayload = log.errorPayload as Record<string, unknown>;
			expect(errorPayload.errorClass).toBe("PmAuthError");
			expect(errorPayload.errorMessage).toBe("auth bad");
			expect(errorPayload.applyError).toBe("Original failure trace");
			// The full proposal payload is preserved on the audit row.
			const persistedChanges = errorPayload.changes as Array<{
				title: { to: string };
			}>;
			expect(persistedChanges).toHaveLength(1);
			expect(persistedChanges[0]?.title.to).toBe("Audit me on dismiss");
		});

		it("rejects cross-tenant dismiss with FORBIDDEN; no row/log mutation", async () => {
			const projectA = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "Dismiss Cross-Org Project A",
			});
			const failedA = await seedFailedProposal({
				projectId: projectA.id,
				userId: USER_A,
				organizationId: ORG_A,
			});

			let captured: { code: string } | null = null;
			try {
				await handlers.dismiss({
					input: {
						projectId: projectA.id,
						proposalId: failedA.id,
						organizationId: ORG_B,
					},
					context: { user: { id: USER_B }, session: {} },
				});
			} catch (err: unknown) {
				captured = err as { code: string };
			}
			expect(captured?.code).toBe("FORBIDDEN");

			const stillThere = await db.pendingBacklogProposal.findUnique({
				where: { id: failedA.id },
			});
			expect(stillThere).not.toBeNull();
			expect(stillThere?.status).toBe("FAILED");

			const logs = await db.pmSyncLog.findMany({
				where: { userId: { in: [USER_A, USER_B] } },
			});
			expect(logs).toHaveLength(0);
		});
	},
);
