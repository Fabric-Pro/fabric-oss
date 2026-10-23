/**
 * Real-Postgres integration test for the specs behind a Proposal's generated
 * visuals (Fizzy #2946).
 *
 * Two halves:
 *  1. The writers and readers, on the superuser connection the API and
 *     worker use: an append is idempotent on (document, visual id, source
 *     hash), a document outside the named project or organization is
 *     refused, the client list carries no spec, and deleting the document
 *     removes its rows.
 *  2. Row-level security, under the NOSUPERUSER/NOBYPASSRLS test role
 *     (`_helpers/rls-role.ts`): the tenant and an accepted project guest read
 *     and write the project's rows, nobody else reads any, and a write must
 *     carry the parent project's organizationId.
 *
 * Requires the proposal visuals migration and `apply:rls` on the target
 * database. Self-skips without a reachable DATABASE_URL.
 *
 * Run with: pnpm --filter @repo/database test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, type Prisma } from "../prisma/client";
import {
	appendProposalVisualSpec,
	findProposalVisualSpecBySourceHash,
	getLatestProposalVisualSpec,
	listProposalVisualSpecSummaries,
	ProposalVisualSpecTenantError,
} from "../prisma/queries/projects/proposal-visual-specs";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";
import {
	asRlsRole,
	ensureRlsTestRole,
	type TenantCtx,
} from "./_helpers/rls-role";

const RUN = `${Date.now()}-${process.pid}`;
const id = (name: string) => `visual-spec-it-${name}-${RUN}`;

const USERS = {
	owner: id("owner"),
	ownerB: id("owner-b"),
	guest: id("guest"),
	outsider: id("outsider"),
};
const ORG_A = id("org-a");
const ORG_B = id("org-b");
const PA = id("project-a");
const PB = id("project-b");

const SPEC = {
	kind: "timeline",
	items: [
		{ date: "Q1", label: "Discovery" },
		{ date: "Q2", label: "Launch" },
	],
};
const HASH_1 = "v1:0123456789abcdef";
const HASH_2 = "v1:fedcba9876543210";

let documentCounter = 0;
let visualCounter = 0;

async function freshDocument(projectId = PA): Promise<string> {
	documentCounter += 1;
	const documentId = id(`doc-${documentCounter}`);
	const project = await db.project.findUniqueOrThrow({
		where: { id: projectId },
		select: { organizationId: true, userId: true },
	});
	await db.projectDocument.create({
		data: {
			id: documentId,
			projectId,
			type: "PROPOSAL",
			title: "Example proposal",
			content: "# Example\n\n## Delivery\n\nBody.",
			userId: project.userId,
			organizationId: project.organizationId,
		},
	});
	return documentId;
}

/** A fresh visual id: 16 lowercase letters or digits. */
function freshVisualId(): string {
	visualCounter += 1;
	return `vis${String(visualCounter).padStart(13, "0")}`;
}

function append(
	documentId: string,
	visualId: string,
	overrides: Partial<Parameters<typeof appendProposalVisualSpec>[0]> = {},
) {
	return appendProposalVisualSpec({
		organizationId: ORG_A,
		projectId: PA,
		documentId,
		visualId,
		sourceHash: HASH_1,
		kind: "timeline",
		origin: "STEP",
		spec: SPEC,
		createdById: USERS.owner,
		...overrides,
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"Proposal visual specs (real Postgres)",
	() => {
		beforeAll(async () => {
			const present = await db.$queryRaw<{ name: string | null }[]>`
				SELECT to_regclass('public.project_document_visual_spec')::text AS name`;
			if (!present[0]?.name) {
				throw new Error(
					"project_document_visual_spec is missing: apply the *_proposal_visuals migration (prisma migrate deploy) and apply:rls to this database first",
				);
			}

			const now = new Date();
			for (const userId of Object.values(USERS)) {
				await db.user.create({
					data: {
						id: userId,
						name: userId,
						email: `${userId}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				});
			}
			for (const orgId of [ORG_A, ORG_B]) {
				await db.organization.create({
					data: {
						id: orgId,
						name: `Example ${orgId}`,
						slug: orgId,
						createdAt: now,
					},
				});
			}
			for (const [projectId, organizationId, userId] of [
				[PA, ORG_A, USERS.owner],
				[PB, ORG_B, USERS.ownerB],
			] as const) {
				await db.project.create({
					data: {
						id: projectId,
						name: `Example ${projectId}`,
						userId,
						organizationId,
						techStack: [],
						features: [],
						tags: [],
					},
				});
			}
			// The guest belongs to no organization: an invited editor of PA.
			await db.projectMember.create({
				data: {
					projectId: PA,
					userId: USERS.guest,
					acceptedAt: now,
					expiresAt: null,
					role: "EDITOR",
					invitedBy: USERS.owner,
				},
			});
		});

		afterAll(async () => {
			// Projects cascade to documents, members and every spec row.
			await db.project.deleteMany({ where: { id: { in: [PA, PB] } } });
			await db.organization.deleteMany({
				where: { id: { in: [ORG_A, ORG_B] } },
			});
			await db.user.deleteMany({
				where: { id: { in: Object.values(USERS) } },
			});
		});

		describe("writers and readers", () => {
			it("writes one row, and the same (document, visual id, source hash) again leaves it alone", async () => {
				const documentId = await freshDocument();
				const visualId = freshVisualId();

				expect(await append(documentId, visualId)).toEqual({
					created: true,
				});
				expect(
					await append(documentId, visualId, {
						origin: "INSTRUCTION",
						spec: { kind: "timeline", items: [] },
					}),
				).toEqual({ created: false });

				const rows = await db.projectDocumentVisualSpec.findMany({
					where: { documentId },
				});
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({
					organizationId: ORG_A,
					projectId: PA,
					visualId,
					sourceHash: HASH_1,
					kind: "timeline",
					origin: "STEP",
					spec: SPEC,
					createdById: USERS.owner,
				});
				expect(rows[0].specHash).toMatch(/^v1:[0-9a-f]{16}$/);
			});

			it("keeps every source hash of a visual, finds each, and returns the newest as latest", async () => {
				const documentId = await freshDocument();
				const visualId = freshVisualId();
				await append(documentId, visualId);
				await append(documentId, visualId, {
					sourceHash: HASH_2,
					origin: "INSTRUCTION",
				});

				expect(
					await findProposalVisualSpecBySourceHash({
						projectId: PA,
						documentId,
						visualId,
						sourceHash: HASH_1,
					}),
				).toMatchObject({ origin: "STEP", spec: SPEC });
				expect(
					await getLatestProposalVisualSpec({
						projectId: PA,
						documentId,
						visualId,
					}),
				).toMatchObject({ sourceHash: HASH_2, origin: "INSTRUCTION" });
				expect(
					await findProposalVisualSpecBySourceHash({
						projectId: PB,
						documentId,
						visualId,
						sourceHash: HASH_1,
					}),
				).toBeNull();
			});

			it("lists a document's visuals without their specs", async () => {
				const documentId = await freshDocument();
				const visualId = freshVisualId();
				await append(documentId, visualId);

				expect(
					await listProposalVisualSpecSummaries({
						organizationId: ORG_A,
						projectId: PA,
						documentId,
					}),
				).toEqual([
					{
						visualId,
						sourceHash: HASH_1,
						kind: "timeline",
						origin: "STEP",
					},
				]);
			});

			it("refuses a document outside the named project or organization", async () => {
				const documentId = await freshDocument();

				await expect(
					append(documentId, freshVisualId(), { projectId: PB }),
				).rejects.toBeInstanceOf(ProposalVisualSpecTenantError);
				await expect(
					append(documentId, freshVisualId(), {
						organizationId: ORG_B,
					}),
				).rejects.toBeInstanceOf(ProposalVisualSpecTenantError);
				expect(
					await db.projectDocumentVisualSpec.count({
						where: { documentId },
					}),
				).toBe(0);
			});

			it("refuses an id or hash of the wrong shape, also at the database", async () => {
				const documentId = await freshDocument();

				await expect(append(documentId, "Not-An-Id")).rejects.toThrow(
					/unknown shape/,
				);
				await expect(
					append(documentId, freshVisualId(), {
						sourceHash: "nothex",
					}),
				).rejects.toThrow(/unknown shape/);
				await expect(
					db.projectDocumentVisualSpec.create({
						data: {
							organizationId: ORG_A,
							projectId: PA,
							documentId,
							visualId: freshVisualId(),
							sourceHash: HASH_1,
							specHash: HASH_1,
							kind: "timeline",
							origin: "SOMEONE",
							spec: SPEC,
						},
					}),
				).rejects.toThrow(/project_document_visual_spec_fields_check/);
			});

			it("deleting the document removes its rows", async () => {
				const documentId = await freshDocument();
				await append(documentId, freshVisualId());

				await db.projectDocument.delete({ where: { id: documentId } });

				expect(
					await db.projectDocumentVisualSpec.count({
						where: { documentId },
					}),
				).toBe(0);
			});
		});

		describe("row-level security (restricted role)", () => {
			const guest: TenantCtx = {
				type: "personal",
				tenantId: USERS.guest,
				userId: USERS.guest,
			};
			const outsider: TenantCtx = {
				type: "personal",
				tenantId: USERS.outsider,
				userId: USERS.outsider,
			};
			const orgA: TenantCtx = {
				type: "organization",
				tenantId: ORG_A,
				userId: USERS.owner,
			};
			const orgB: TenantCtx = {
				type: "organization",
				tenantId: ORG_B,
				userId: USERS.ownerB,
			};

			let documentA: string;
			let documentB: string;

			class Rollback extends Error {}

			/** Run `fn` under RLS and roll it back; report whether RLS denied it. */
			async function attempt(
				ctx: TenantCtx,
				fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
			): Promise<"ok" | "denied"> {
				try {
					await asRlsRole(ctx, async (tx) => {
						await fn(tx);
						throw new Rollback();
					});
				} catch (error) {
					if (error instanceof Rollback) {
						return "ok";
					}
					if (
						/row-level security/i.test(
							String((error as Error).message),
						)
					) {
						return "denied";
					}
					throw error;
				}
				return "ok";
			}

			const insert = (
				tx: Prisma.TransactionClient,
				documentId: string,
				projectId: string,
				organizationId: string,
			) =>
				tx.projectDocumentVisualSpec.create({
					data: {
						organizationId,
						projectId,
						documentId,
						visualId: freshVisualId(),
						sourceHash: HASH_1,
						specHash: HASH_1,
						kind: "flow",
						origin: "INSTRUCTION",
						spec: SPEC,
					},
				});

			const countIn = (ctx: TenantCtx, projectId: string) =>
				asRlsRole(ctx, (tx) =>
					tx.projectDocumentVisualSpec.count({
						where: { projectId },
					}),
				);

			beforeAll(async () => {
				const policies = await db.$queryRaw<{ policyname: string }[]>`
					SELECT policyname::text AS policyname FROM pg_policies
					WHERE tablename = 'project_document_visual_spec'`;
				if (policies.length === 0) {
					throw new Error(
						"project_document_visual_spec has no RLS policy: run apply:rls against this database first",
					);
				}
				await ensureRlsTestRole();

				documentA = await freshDocument(PA);
				documentB = await freshDocument(PB);
				await append(documentA, freshVisualId());
				await append(documentB, freshVisualId(), {
					organizationId: ORG_B,
					projectId: PB,
					createdById: USERS.ownerB,
				});
			});

			it("the tenant and an accepted guest read the project's rows; an outsider and another tenant read none", async () => {
				expect(await countIn(orgA, PA)).toBeGreaterThan(0);
				expect(await countIn(guest, PA)).toBeGreaterThan(0);
				expect(await countIn(guest, PB)).toBe(0);
				expect(await countIn(outsider, PA)).toBe(0);
				expect(await countIn(orgB, PA)).toBe(0);
			});

			it("a guest with access inserts rows for that project and no other", async () => {
				expect(
					await attempt(guest, (tx) =>
						insert(tx, documentA, PA, ORG_A),
					),
				).toBe("ok");
				expect(
					await attempt(guest, (tx) =>
						insert(tx, documentB, PB, ORG_B),
					),
				).toBe("denied");
				expect(
					await attempt(outsider, (tx) =>
						insert(tx, documentA, PA, ORG_A),
					),
				).toBe("denied");
			});

			it("a write must carry the parent project's organizationId, for guests and members alike", async () => {
				expect(
					await attempt(orgA, (tx) =>
						insert(tx, documentA, PA, ORG_A),
					),
				).toBe("ok");
				expect(
					await attempt(orgA, (tx) =>
						insert(tx, documentA, PA, ORG_B),
					),
				).toBe("denied");
				expect(
					await attempt(guest, (tx) =>
						insert(tx, documentA, PA, ORG_B),
					),
				).toBe("denied");
				expect(
					await attempt(guest, (tx) =>
						tx.projectDocumentVisualSpec.updateMany({
							where: { projectId: PA },
							data: { organizationId: ORG_B },
						}),
					),
				).toBe("denied");
			});
		});
	},
);
