/**
 * Real-Postgres RLS regression for governed stage transitions on a PERSONAL
 * project performed by a project-scoped guest (plan §F1 / Slice 5; review
 * rounds 3–4).
 *
 * Runs against DATABASE_URL with a dedicated NON-superuser, NON-bypass role so
 * row-level policies are actually enforced (the default `postgres` role
 * bypasses RLS). Requires `pnpm --filter @repo/database apply:rls` to have
 * been run against the same database.
 *
 * Run with: pnpm --filter @repo/database test:rls:stage
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../prisma/generated/client";

// Own LOGIN role on purpose: the shared `fabric_rls_test` role from
// `_helpers/rls-role.ts` is NOLOGIN and entered with SET LOCAL ROLE inside a
// superuser transaction, which the delivery module's own transactions cannot
// do. This suite connects AS the restricted role instead, so every query the
// choke point issues is evaluated under RLS.
const RLS_ROLE = "fabric_rls_stage_test";
const RLS_PASSWORD = "fabric_rls_stage_test";

function rlsUrl(): string {
	const url = new URL(process.env.DATABASE_URL ?? "");
	url.username = RLS_ROLE;
	url.password = RLS_PASSWORD;
	return url.toString();
}

// The delivery module reads `db` from ../prisma/client. Point it at the
// non-bypassing role so every query it issues is subject to RLS.
const rlsClient = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../prisma/client", async (importOriginal) => {
	const original = await importOriginal<typeof import("../prisma/client")>();
	return {
		...original,
		get db() {
			return (rlsClient.current ?? original.db) as typeof original.db;
		},
	};
});

// Superuser handle that is NOT redirected by the mock, for fixture setup and
// verification reads.
const rootDb = new PrismaClient({
	adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
});

import {
	approveStageTransitionRequest,
	enforceStageTransition,
} from "../src/delivery/transition-story";
import {
	createPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";

const IDS = {
	owner: "rls-stage-owner",
	guest: "rls-stage-guest",
	stranger: "rls-stage-stranger",
	outsider: "rls-stage-outsider",
	otherProject: "rls-stage-other-project",
	project: "rls-stage-project",
	story: "rls-stage-story",
	status: "rls-stage-status",
};

async function setSession(
	client: PrismaClient,
	ctx: {
		type: "personal" | "organization";
		tenantId: string;
		userId: string;
	},
	fn: (
		tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
	) => Promise<unknown>,
) {
	return client.$transaction(async (tx) => {
		await tx.$executeRawUnsafe(
			"SELECT set_config('app.tenant_type', $1, true)",
			ctx.type,
		);
		await tx.$executeRawUnsafe(
			"SELECT set_config('app.tenant_id', $1, true)",
			ctx.tenantId,
		);
		await tx.$executeRawUnsafe(
			"SELECT set_config('app.user_id', $1, true)",
			ctx.userId,
		);
		return fn(tx);
	});
}

describe.skipIf(!process.env.DATABASE_URL)(
	"RLS: personal-project guest requests and approves a governed transition",
	() => {
		let rls: PrismaClient;

		beforeAll(async () => {
			// Non-superuser role that RLS applies to.
			await rootDb.$executeRawUnsafe(
				`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_PASSWORD}' NOSUPERUSER NOBYPASSRLS; END IF; END $$;`,
			);
			await rootDb.$executeRawUnsafe(
				`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`,
			);
			await rootDb.$executeRawUnsafe(
				`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`,
			);
			await rootDb.$executeRawUnsafe(
				`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`,
			);
			// Helper functions used by the policies must be executable.
			for (const fn of [
				"current_tenant_type",
				"current_tenant_id",
				"current_user_id",
			]) {
				await rootDb.$executeRawUnsafe(
					`GRANT EXECUTE ON FUNCTION ${fn}() TO ${RLS_ROLE}`,
				);
			}

			rls = new PrismaClient({
				adapter: new PrismaPg({ connectionString: rlsUrl() }),
			});

			// Fixtures (as superuser via rootDb).
			for (const [id, email] of [
				[IDS.owner, "rls-stage-owner@example.com"],
				[IDS.guest, "rls-stage-guest@example.com"],
				[IDS.stranger, "rls-stage-stranger@example.com"],
				[IDS.outsider, "rls-stage-outsider@example.com"],
			] as const) {
				await rootDb.user.upsert({
					where: { id },
					update: {},
					create: {
						id,
						name: id,
						email,
						emailVerified: true,
						onboardingComplete: false,
						createdAt: new Date(),
						updatedAt: new Date(),
					} as never,
				});
			}
			await rootDb.project.upsert({
				where: { id: IDS.project },
				update: {},
				create: {
					id: IDS.project,
					name: "RLS stage project",
					userId: IDS.owner,
					organizationId: null,
					status: "ACTIVE",
					techStack: [],
					features: [],
					tags: [],
					engagementProfile: "GOVERNED",
				} as never,
			});
			// An UNRELATED project on which the outsider is an accepted member.
			// Review round 5: membership elsewhere must grant nothing here.
			await rootDb.project.upsert({
				where: { id: IDS.otherProject },
				update: {},
				create: {
					id: IDS.otherProject,
					name: "RLS other project",
					userId: IDS.outsider,
					organizationId: null,
					status: "ACTIVE",
					techStack: [],
					features: [],
					tags: [],
				} as never,
			});
			await rootDb.projectMember.upsert({
				where: {
					projectId_userId: {
						projectId: IDS.otherProject,
						userId: IDS.outsider,
					},
				},
				update: { acceptedAt: new Date(), expiresAt: null },
				create: {
					projectId: IDS.otherProject,
					userId: IDS.outsider,
					role: "PROJECT_ADMIN",
					invitedBy: IDS.outsider,
					acceptedAt: new Date(),
				},
			});
			await rootDb.projectMember.upsert({
				where: {
					projectId_userId: {
						projectId: IDS.project,
						userId: IDS.guest,
					},
				},
				update: {
					acceptedAt: new Date(),
					expiresAt: null,
					role: "PROJECT_ADMIN",
				},
				create: {
					projectId: IDS.project,
					userId: IDS.guest,
					role: "PROJECT_ADMIN",
					invitedBy: IDS.owner,
					acceptedAt: new Date(),
				},
			});
			await rootDb.projectStageApprover.upsert({
				where: {
					projectId_userId: {
						projectId: IDS.project,
						userId: IDS.guest,
					},
				},
				update: {},
				create: { projectId: IDS.project, userId: IDS.guest },
			});
			await rootDb.projectStoryStatus.upsert({
				where: { id: IDS.status },
				update: {},
				create: {
					id: IDS.status,
					projectId: IDS.project,
					name: "Backlog",
					color: "#6B7280",
					order: 0,
					isDefault: true,
				} as never,
			});
			await rootDb.userStory.upsert({
				where: { id: IDS.story },
				update: { draftingStage: "DRAFT", version: 1 },
				create: {
					id: IDS.story,
					projectId: IDS.project,
					statusId: IDS.status,
					identifier: "RLS-001",
					title: "Guest-governed story",
					description: "d",
					acceptanceCriteria: "ac",
					createdById: IDS.owner,
					draftingStage: "DRAFT",
					deliveryTrack: "SPECIFY",
					labels: [],
				} as never,
			});
			await rootDb.stageTransitionRequest.deleteMany({
				where: { storyId: IDS.story },
			});
			await rootDb.featureVersion.deleteMany({
				where: { storyId: IDS.story },
			});
			// The stranger must start with no access; the approval test
			// promotes them later and a previous run may have left that behind.
			await rootDb.projectStageApprover.deleteMany({
				where: { projectId: IDS.project, userId: IDS.stranger },
			});
			await rootDb.projectMember.deleteMany({
				where: { projectId: IDS.project, userId: IDS.stranger },
			});

			// From here on the delivery module's `db` goes through the
			// RLS-bound role; `rootDb` stays superuser for verification reads.
			rlsClient.current = rls;
		});

		afterAll(async () => {
			rlsClient.current = null;
			await rls?.$disconnect();
			await rootDb.$disconnect();
		});

		it("guest identity: RLS admits inserting an owner-owned request (member branch)", async () => {
			// This is the exact write `enforceStageTransition` performs on a
			// guest's behalf (tenant columns = project owner, requester = guest),
			// issued under the GUEST's own RLS identity. A plain user_owned
			// policy rejected it (review round 4); project_member_or_tenant
			// admits it through the accepted-member branch.
			const created = await setSession(
				rls,
				{ type: "personal", tenantId: IDS.guest, userId: IDS.guest },
				(tx) =>
					tx.stageTransitionRequest.create({
						data: {
							projectId: IDS.project,
							storyId: IDS.story,
							requestedById: IDS.guest,
							userId: IDS.owner,
							organizationId: null,
							fromStage: "DRAFT",
							toStage: "SANITY_CHECK",
							reason: "manual",
						},
						select: { id: true },
					}),
			);
			expect((created as { id: string }).id).toBeTruthy();
			// … and the guest can read it back and see the approver list.
			const [requests, approvers] = (await setSession(
				rls,
				{ type: "personal", tenantId: IDS.guest, userId: IDS.guest },
				async (tx) => [
					await tx.stageTransitionRequest.findMany({
						where: { storyId: IDS.story, status: "PENDING" },
					}),
					await tx.projectStageApprover.findMany({
						where: { projectId: IDS.project },
					}),
				],
			)) as [unknown[], unknown[]];
			expect(requests).toHaveLength(1);
			expect(approvers.length).toBeGreaterThanOrEqual(1);
		});

		it("choke point: creating the request under the project's tenant scope (what withStageTransaction derives) yields an owner-owned row with the guest as requester", async () => {
			await rootDb.stageTransitionRequest.deleteMany({
				where: { storyId: IDS.story },
			});
			const decision = await setSession(
				rls,
				{ type: "personal", tenantId: IDS.owner, userId: IDS.owner },
				(tx) =>
					enforceStageTransition(tx as never, {
						storyId: IDS.story,
						projectId: IDS.project,
						toStage: "SANITY_CHECK",
						reason: "manual",
						actor: { userId: IDS.guest, organizationId: null },
					}),
			);
			expect((decision as { mode: string }).mode).toBe("request");
			const row = await rootDb.stageTransitionRequest.findFirst({
				where: { storyId: IDS.story, status: "PENDING" },
			});
			expect(row?.userId).toBe(IDS.owner);
			expect(row?.requestedById).toBe(IDS.guest);
		});

		it("a member of an UNRELATED project cannot select, insert or update target-project rows", async () => {
			const outsider = {
				type: "personal" as const,
				tenantId: IDS.outsider,
				userId: IDS.outsider,
			};
			const [requests, approvers] = (await setSession(
				rls,
				outsider,
				async (tx) => [
					await tx.stageTransitionRequest.findMany({
						where: { projectId: IDS.project },
					}),
					await tx.projectStageApprover.findMany({
						where: { projectId: IDS.project },
					}),
				],
			)) as [unknown[], unknown[]];
			expect(requests).toEqual([]);
			expect(approvers).toEqual([]);

			await expect(
				setSession(rls, outsider, (tx) =>
					tx.stageTransitionRequest.create({
						data: {
							projectId: IDS.project,
							storyId: IDS.story,
							requestedById: IDS.outsider,
							userId: IDS.owner,
							organizationId: null,
							fromStage: "DRAFT",
							toStage: "CLOSED",
							reason: "manual",
						},
					}),
				),
			).rejects.toThrow(/row-level security/);

			await expect(
				setSession(rls, outsider, (tx) =>
					tx.projectStageApprover.create({
						data: { projectId: IDS.project, userId: IDS.outsider },
					}),
				),
			).rejects.toThrow(/row-level security/);

			const updated = await setSession(rls, outsider, (tx) =>
				tx.stageTransitionRequest.updateMany({
					where: { projectId: IDS.project, status: "PENDING" },
					data: { status: "REJECTED" },
				}),
			);
			expect((updated as { count: number }).count).toBe(0);
		});

		it("guest identity: can read the invited project row and the choke point creates the request (project policy admits members)", async () => {
			await rootDb.stageTransitionRequest.deleteMany({
				where: { storyId: IDS.story },
			});
			const guest = {
				type: "personal" as const,
				tenantId: IDS.guest,
				userId: IDS.guest,
			};
			const project = await setSession(rls, guest, (tx) =>
				tx.project.findUnique({
					where: { id: IDS.project },
					select: { id: true },
				}),
			);
			expect((project as { id: string } | null)?.id).toBe(IDS.project);
			const decision = await setSession(rls, guest, (tx) =>
				enforceStageTransition(tx as never, {
					storyId: IDS.story,
					projectId: IDS.project,
					toStage: "SANITY_CHECK",
					reason: "manual",
					actor: { userId: IDS.guest, organizationId: null },
				}),
			);
			expect((decision as { mode: string }).mode).toBe("request");
			const row = await rootDb.stageTransitionRequest.findFirst({
				where: { storyId: IDS.story, status: "PENDING" },
			});
			expect(row?.userId).toBe(IDS.owner);
			expect(row?.requestedById).toBe(IDS.guest);
		});

		it("outsider identity: cannot read the project row", async () => {
			const outsider = {
				type: "personal" as const,
				tenantId: IDS.outsider,
				userId: IDS.outsider,
			};
			const project = await setSession(rls, outsider, (tx) =>
				tx.project.findUnique({
					where: { id: IDS.project },
					select: { id: true },
				}),
			);
			expect(project).toBeNull();
		});

		it("a stranger (no membership) cannot see the request", async () => {
			const rows = await setSession(
				rls,
				{
					type: "personal",
					tenantId: IDS.stranger,
					userId: IDS.stranger,
				},
				(tx) =>
					tx.stageTransitionRequest.findMany({
						where: { storyId: IDS.story },
					}),
			);
			expect(rows).toEqual([]);
		});

		it("guest approver commits stage, FeatureVersion and request update in one owner-scoped transaction", async () => {
			const request =
				await rootDb.stageTransitionRequest.findFirstOrThrow({
					where: { storyId: IDS.story, status: "PENDING" },
				});
			// Use a different guest identity as approver (self-approval is refused):
			// promote the stranger to an accepted member + approver for this step.
			await rootDb.projectMember.upsert({
				where: {
					projectId_userId: {
						projectId: IDS.project,
						userId: IDS.stranger,
					},
				},
				update: {
					acceptedAt: new Date(),
					expiresAt: null,
					role: "PROJECT_ADMIN",
				},
				create: {
					projectId: IDS.project,
					userId: IDS.stranger,
					role: "PROJECT_ADMIN",
					invitedBy: IDS.owner,
					acceptedAt: new Date(),
				},
			});
			await rootDb.projectStageApprover.upsert({
				where: {
					projectId_userId: {
						projectId: IDS.project,
						userId: IDS.stranger,
					},
				},
				update: {},
				create: { projectId: IDS.project, userId: IDS.stranger },
			});

			const ctx = createPersonalContext(IDS.stranger);
			ctx.allowedProjectIds.push(IDS.project);
			await runWithTenantContext(ctx, () =>
				approveStageTransitionRequest({
					requestId: request.id,
					projectId: IDS.project,
					reviewer: { userId: IDS.stranger, organizationId: null },
				}),
			);

			const story = await rootDb.userStory.findUniqueOrThrow({
				where: { id: IDS.story },
			});
			expect(story.draftingStage).toBe("SANITY_CHECK");
			const version = await rootDb.featureVersion.findFirst({
				where: { storyId: IDS.story },
				orderBy: { version: "desc" },
			});
			expect(version?.userId).toBe(IDS.owner);
			expect(version?.changedBy).toBe(IDS.stranger);
			const reviewed =
				await rootDb.stageTransitionRequest.findUniqueOrThrow({
					where: { id: request.id },
				});
			expect(reviewed.status).toBe("APPROVED");
			expect(reviewed.reviewedById).toBe(IDS.stranger);
		});
	},
);
