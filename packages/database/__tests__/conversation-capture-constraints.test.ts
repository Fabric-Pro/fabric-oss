/**
 * REQUIRES A LIVE POSTGRES with migrations applied. Self-skips via
 * `hasReachableDatabaseUrl()` (which rejects the CI placeholder URL as well as
 * an unset one), and runs for real in `.github/workflows/db-integration.yml`,
 * where a guard fails the job if this suite self-skipped.
 *
 * The static half — that the tables are registered and the constraints are
 * written down — is `conversation-capture-registration.test.ts` and needs no
 * database. This suite is the half that matters: it proves the DATABASE
 * refuses the writes, which is a claim no mocked test can make and no reading
 * of the migration can settle.
 *
 * Every rejection below is asserted through RAW SQL on the base client —
 * outside `getTenantDb`, outside the query helpers, outside anything that could
 * be quietly filtering. That is the point. The tenant story for a child table
 * is only as strong as what survives a writer that does not cooperate:
 *
 *   - Postgres does not evaluate the PARENT's row-level-security policy through
 *     a foreign key, so a child pointing at a parent in another project can
 *     still satisfy its own policy.
 *   - A foreign key over (parentContextId, projectId) never compares owners, so
 *     it admits an organization-owned child under a personal parent.
 *
 * Both tables are covered, not just the bundle table. The claim table holds
 * tenant-associated provider message ids and GATES whether a message can ever
 * be captured — a cross-tenant write there could suppress capture through a
 * uniqueness conflict without touching a byte of content.
 *
 * The third table beside them — `project_context_pending_vector_cleanup`, the
 * queue of ids whose vectors an unlink still owes the vector store — is covered
 * here too, for what makes it different: it carries the same tenant XOR and
 * deliberately NO owner foreign key, because outliving the context rows is
 * exactly its job. That is a claim about cascade behaviour, which only a real
 * database can settle.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	type ClaimedConversationMessage,
	type ConversationBundleDraft,
	type ConversationBundleRow,
	type ConversationCaptureTenant,
	type ConversationMessageToClaim,
	claimConversationMessages,
	listConversationBundlesForContext,
	recordConversationBundle,
} from "../prisma/queries/projects/conversation-bundles";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const BUNDLE_TABLE = "project_context_conversation_bundle";
const CLAIM_TABLE = "project_context_conversation_claim";
const CLEANUP_TABLE = "project_context_pending_vector_cleanup";

describe.skipIf(!hasReachableDatabaseUrl())(
	"conversation capture — database-enforced ownership (real Postgres)",
	() => {
		const RUN = `${Date.now()}-${process.pid}`;
		const USER_ID = `test-ccc-user-${RUN}`;
		const OTHER_USER_ID = `test-ccc-other-user-${RUN}`;
		const ORG_ID = `test-ccc-org-${RUN}`;
		const OTHER_ORG_ID = `test-ccc-other-org-${RUN}`;

		/** Personal project + its context, and a second personal project. */
		let personalProjectId: string;
		let personalOtherProjectId: string;
		let personalContextId: string;
		/** Organization project + its context, and a second org project. */
		let orgProjectId: string;
		let orgOtherProjectId: string;
		let orgContextId: string;

		let rowCounter = 0;
		const nextId = (prefix: string) => `${prefix}-${RUN}-${++rowCounter}`;

		async function seedContext(params: {
			projectId: string;
			userId: string;
			organizationId: string | null;
		}) {
			// Mirrors `createContext`: an organization context carries BOTH
			// columns, and its ownerKey therefore resolves to the organization.
			// The CHILDREN are the strict ones.
			const context = await db.projectContext.create({
				data: {
					projectId: params.projectId,
					type: "INTEGRATION",
					content: "",
					metadata: {
						provider: "MICROSOFT_TEAMS",
						chatType: "channel",
					},
					userId: params.userId,
					organizationId: params.organizationId ?? undefined,
				},
				select: { id: true },
			});
			return context.id;
		}

		beforeAll(async () => {
			const now = new Date();
			for (const id of [USER_ID, OTHER_USER_ID]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
					VALUES (${id}, ${"Capture Test User"}, ${`${id}@example.com`}, true, false, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			for (const id of [ORG_ID, OTHER_ORG_ID]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "organization" (id, name, slug, "createdAt")
					VALUES (${id}, ${"Capture Test Org"}, ${id}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}

			const personal = await db.project.create({
				data: { name: `Capture personal ${RUN}`, userId: USER_ID },
				select: { id: true },
			});
			const personalOther = await db.project.create({
				data: { name: `Capture personal 2 ${RUN}`, userId: USER_ID },
				select: { id: true },
			});
			const org = await db.project.create({
				data: {
					name: `Capture org ${RUN}`,
					userId: USER_ID,
					organizationId: ORG_ID,
				},
				select: { id: true },
			});
			const orgOther = await db.project.create({
				data: {
					name: `Capture org 2 ${RUN}`,
					userId: USER_ID,
					organizationId: ORG_ID,
				},
				select: { id: true },
			});

			personalProjectId = personal.id;
			personalOtherProjectId = personalOther.id;
			orgProjectId = org.id;
			orgOtherProjectId = orgOther.id;

			personalContextId = await seedContext({
				projectId: personalProjectId,
				userId: USER_ID,
				organizationId: null,
			});
			orgContextId = await seedContext({
				projectId: orgProjectId,
				userId: USER_ID,
				organizationId: ORG_ID,
			});
		});

		afterAll(async () => {
			// Projects cascade their contexts, which cascade the capture rows.
			await db.project
				.deleteMany({ where: { userId: USER_ID } })
				.catch(() => undefined);
			await db.organization
				.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } })
				.catch(() => undefined);
			await db.user
				.deleteMany({
					where: { id: { in: [USER_ID, OTHER_USER_ID] } },
				})
				.catch(() => undefined);
		});

		// ---------------------------------------------------------------
		// Raw writers — deliberately NOT the query helpers.
		// ---------------------------------------------------------------

		interface RawChildRow {
			parentContextId: string;
			projectId: string;
			userId: string | null;
			organizationId: string | null;
		}

		async function insertBundleRaw(row: RawChildRow): Promise<string> {
			const id = nextId("bundle");
			await db.$executeRawUnsafe(
				`INSERT INTO "${BUNDLE_TABLE}"
					(id, "parentContextId", "projectId", content, "contentHash",
					 "bundleStartedAt", "userId", "organizationId", "createdAt", "updatedAt")
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
				id,
				row.parentContextId,
				row.projectId,
				"captured channel text",
				`hash-${id}`,
				new Date(),
				row.userId,
				row.organizationId,
			);
			return id;
		}

		async function insertClaimRaw(
			row: RawChildRow & { bundleId?: string | null },
		): Promise<string> {
			const id = nextId("claim");
			await db.$executeRawUnsafe(
				`INSERT INTO "${CLAIM_TABLE}"
					(id, "parentContextId", "projectId", "providerMessageId", "bundleId",
					 "userId", "organizationId", "createdAt", "updatedAt")
				 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
				id,
				row.parentContextId,
				row.projectId,
				`msg-${id}`,
				row.bundleId ?? null,
				row.userId,
				row.organizationId,
			);
			return id;
		}

		/**
		 * The stranded-vector cleanup queue, written the same raw way — outside
		 * the query helper, so what is being tested is what POSTGRES refuses
		 * rather than what the helper declines to send.
		 */
		async function insertCleanupRaw(row: {
			projectId: string;
			userId: string | null;
			organizationId: string | null;
			contextIds?: string[];
		}): Promise<string> {
			const id = nextId("cleanup");
			await db.$executeRawUnsafe(
				`INSERT INTO "${CLEANUP_TABLE}"
					(id, "projectId", "contextIds", "userId", "organizationId",
					 "createdAt", "updatedAt")
				 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
				id,
				row.projectId,
				row.contextIds ?? ["ctx-a", "ctx-b"],
				row.userId,
				row.organizationId,
			);
			return id;
		}

		const RAW_WRITERS: Array<{
			table: string;
			insert: (row: RawChildRow) => Promise<string>;
		}> = [
			{ table: BUNDLE_TABLE, insert: insertBundleRaw },
			{ table: CLAIM_TABLE, insert: insertClaimRaw },
		];

		/**
		 * Assert the write was refused BY POSTGRES, naming the constraint that
		 * refused it — so a row rejected for an unrelated reason (a missing
		 * user, a null column) cannot pass as evidence.
		 */
		async function expectRefusedBy(
			write: Promise<unknown>,
			constraint: string,
		): Promise<void> {
			let refusal: string | null = null;
			try {
				await write;
			} catch (error) {
				const err = error as Error & { meta?: unknown };
				refusal = `${err.message} ${JSON.stringify(err.meta ?? {})}`;
			}
			if (refusal === null) {
				throw new Error(
					`Expected the database to refuse this write via ${constraint}, but it was accepted.`,
				);
			}
			expect(refusal).toContain(constraint);
		}

		describe.each(RAW_WRITERS)(
			"$table — parentage alone is not ownership",
			({ table, insert }) => {
				const ownerFkey = `${table}_owner_fkey`;
				const tenantXor = `${table}_tenant_xor`;

				it("refuses a row whose projectId does not match its parent's — personal context", async () => {
					await expectRefusedBy(
						insert({
							parentContextId: personalContextId,
							projectId: personalOtherProjectId,
							userId: USER_ID,
							organizationId: null,
						}),
						ownerFkey,
					);
				});

				it("refuses a row whose projectId does not match its parent's — organization context", async () => {
					await expectRefusedBy(
						insert({
							parentContextId: orgContextId,
							projectId: orgOtherProjectId,
							userId: null,
							organizationId: ORG_ID,
						}),
						ownerFkey,
					);
				});

				it("refuses an organization-owned row under a personal parent", async () => {
					// projectId and parentContextId both agree here. Only the
					// OWNER differs — which is exactly what a foreign key over
					// (parentContextId, projectId) would have let through.
					await expectRefusedBy(
						insert({
							parentContextId: personalContextId,
							projectId: personalProjectId,
							userId: null,
							organizationId: ORG_ID,
						}),
						ownerFkey,
					);
				});

				it("refuses a row naming a different organization than its parent", async () => {
					await expectRefusedBy(
						insert({
							parentContextId: orgContextId,
							projectId: orgProjectId,
							userId: null,
							organizationId: OTHER_ORG_ID,
						}),
						ownerFkey,
					);
				});

				it("refuses a row naming a different user than its parent", async () => {
					await expectRefusedBy(
						insert({
							parentContextId: personalContextId,
							projectId: personalProjectId,
							userId: OTHER_USER_ID,
							organizationId: null,
						}),
						ownerFkey,
					);
				});

				it("refuses a row with BOTH tenant columns set", async () => {
					await expectRefusedBy(
						insert({
							parentContextId: orgContextId,
							projectId: orgProjectId,
							userId: USER_ID,
							organizationId: ORG_ID,
						}),
						tenantXor,
					);
				});

				it("refuses a row with NEITHER tenant column set", async () => {
					await expectRefusedBy(
						insert({
							parentContextId: personalContextId,
							projectId: personalProjectId,
							userId: null,
							organizationId: null,
						}),
						tenantXor,
					);
				});

				it("accepts the row that agrees with its parent — personal and organization", async () => {
					// The negative cases above prove nothing on their own: a
					// constraint that refuses EVERYTHING would pass all of them.
					await expect(
						insert({
							parentContextId: personalContextId,
							projectId: personalProjectId,
							userId: USER_ID,
							organizationId: null,
						}),
					).resolves.toBeTruthy();
					await expect(
						insert({
							parentContextId: orgContextId,
							projectId: orgProjectId,
							userId: null,
							organizationId: ORG_ID,
						}),
					).resolves.toBeTruthy();
				});
			},
		);

		// ---------------------------------------------------------------
		// The stranded-vector cleanup queue (Fizzy #2228).
		//
		// It exists because an unlink deletes the context and bundle ROWS
		// before their vectors, so a vector-store failure leaves points behind
		// with nothing left pointing at them. The ids are written here in the
		// same transaction as that delete. It carries the same tenant XOR as
		// the two capture tables and — unlike them — deliberately no owner
		// foreign key, because outliving the parent context is the point.
		// ---------------------------------------------------------------

		describe(`${CLEANUP_TABLE} — the queue that outlives the rows`, () => {
			const tenantXor = `${CLEANUP_TABLE}_tenant_xor`;

			it("refuses a record with BOTH tenant columns set", async () => {
				await expectRefusedBy(
					insertCleanupRaw({
						projectId: orgProjectId,
						userId: USER_ID,
						organizationId: ORG_ID,
					}),
					tenantXor,
				);
			});

			it("refuses a record with NEITHER tenant column set", async () => {
				await expectRefusedBy(
					insertCleanupRaw({
						projectId: orgProjectId,
						userId: null,
						organizationId: null,
					}),
					tenantXor,
				);
			});

			it("accepts exactly one owner, personal and organization alike", async () => {
				const personalId = await insertCleanupRaw({
					projectId: personalProjectId,
					userId: USER_ID,
					organizationId: null,
				});
				const orgId = await insertCleanupRaw({
					projectId: orgProjectId,
					userId: null,
					organizationId: ORG_ID,
				});

				const rows =
					await db.projectContextPendingVectorCleanup.findMany({
						where: { id: { in: [personalId, orgId] } },
						orderBy: { id: "asc" },
						select: {
							id: true,
							contextIds: true,
							attempts: true,
						},
					});
				expect(rows).toHaveLength(2);
				// The id list survives the round trip intact — it is the only
				// remaining trace of what has to be deleted.
				for (const row of rows) {
					expect(row.contextIds).toEqual(["ctx-a", "ctx-b"]);
					expect(row.attempts).toBe(0);
				}
			});

			it("survives the deletion of the context rows it was written for", async () => {
				// The whole reason it is not a child of project_context. A
				// cascade here would remove the record at exactly the moment it
				// becomes the only thing that knows what to clean up.
				const doomedContext = await seedContext({
					projectId: orgProjectId,
					userId: USER_ID,
					organizationId: ORG_ID,
				});
				const recordId = await insertCleanupRaw({
					projectId: orgProjectId,
					userId: null,
					organizationId: ORG_ID,
					contextIds: [doomedContext],
				});

				await db.projectContext.delete({
					where: { id: doomedContext },
				});

				const survivor =
					await db.projectContextPendingVectorCleanup.findUnique({
						where: { id: recordId },
						select: { contextIds: true },
					});
				expect(survivor?.contextIds).toEqual([doomedContext]);
			});

			it("goes with the project, whose whole collection is purged anyway", async () => {
				const throwaway = await db.project.create({
					data: {
						name: `Capture cleanup cascade ${RUN}`,
						userId: USER_ID,
						organizationId: ORG_ID,
					},
					select: { id: true },
				});
				const recordId = await insertCleanupRaw({
					projectId: throwaway.id,
					userId: null,
					organizationId: ORG_ID,
				});

				await db.project.delete({ where: { id: throwaway.id } });

				expect(
					await db.projectContextPendingVectorCleanup.findUnique({
						where: { id: recordId },
						select: { id: true },
					}),
				).toBeNull();
			});
		});

		describe("removing the source removes what came from it", () => {
			it("cascades bundles and their claims when the parent context is deleted", async () => {
				const contextId = await seedContext({
					projectId: personalProjectId,
					userId: USER_ID,
					organizationId: null,
				});
				const bundleId = await insertBundleRaw({
					parentContextId: contextId,
					projectId: personalProjectId,
					userId: USER_ID,
					organizationId: null,
				});
				await insertClaimRaw({
					parentContextId: contextId,
					projectId: personalProjectId,
					userId: USER_ID,
					organizationId: null,
					bundleId,
				});

				expect(
					await db.projectContextConversationBundle.count({
						where: { parentContextId: contextId },
					}),
				).toBe(1);
				expect(
					await db.projectContextConversationClaim.count({
						where: { parentContextId: contextId },
					}),
				).toBe(1);

				await db.projectContext.delete({ where: { id: contextId } });

				expect(
					await db.projectContextConversationBundle.count({
						where: { parentContextId: contextId },
					}),
				).toBe(0);
				expect(
					await db.projectContextConversationClaim.count({
						where: { parentContextId: contextId },
					}),
				).toBe(0);
			});
		});

		describe("claiming is what makes capture idempotent", () => {
			it("claims a message once: the second attempt wins nothing", async () => {
				const contextId = await seedContext({
					projectId: personalProjectId,
					userId: USER_ID,
					organizationId: null,
				});
				const messages: ConversationMessageToClaim[] = [
					{ providerMessageId: `m-${RUN}-once` },
				];
				const tenant: ConversationCaptureTenant = {
					userId: USER_ID,
					organizationId: null,
				};

				const first: ClaimedConversationMessage[] =
					await db.$transaction((tx) =>
						claimConversationMessages(tx, {
							parentContextId: contextId,
							projectId: personalProjectId,
							tenant,
							messages,
						}),
					);
				const second: ClaimedConversationMessage[] =
					await db.$transaction((tx) =>
						claimConversationMessages(tx, {
							parentContextId: contextId,
							projectId: personalProjectId,
							tenant,
							messages,
						}),
					);

				expect(first.map((c) => c.providerMessageId)).toEqual([
					`m-${RUN}-once`,
				]);
				expect(second).toEqual([]);
				expect(
					await db.projectContextConversationClaim.count({
						where: { parentContextId: contextId },
					}),
				).toBe(1);
			});

			it("gives two workers over overlapping snapshots disjoint claim sets", async () => {
				const contextId = await seedContext({
					projectId: personalProjectId,
					userId: USER_ID,
					organizationId: null,
				});
				const tenant: ConversationCaptureTenant = {
					userId: USER_ID,
					organizationId: null,
				};
				const ids = (suffix: string, count: number) =>
					Array.from({ length: count }, (_, i) => ({
						providerMessageId: `m-${RUN}-${suffix}-${i}`,
					}));
				// Worker A sees messages 0..3, worker B sees 2..5 — two of them
				// overlap, which is exactly what a poll interval produces.
				const all = ids("race", 6);
				const workerA = all.slice(0, 4);
				const workerB = all.slice(2, 6);

				const bundle = (
					claimed: ClaimedConversationMessage[],
				): ConversationBundleDraft => ({
					content: claimed.map((c) => c.providerMessageId).join("\n"),
					contentHash: `hash-${claimed.length}`,
					bundleStartedAt: new Date(),
				});

				const [a, b] = await Promise.all([
					recordConversationBundle({
						parentContextId: contextId,
						projectId: personalProjectId,
						tenant,
						messages: workerA,
						buildBundle: bundle,
					}),
					recordConversationBundle({
						parentContextId: contextId,
						projectId: personalProjectId,
						tenant,
						messages: workerB,
						buildBundle: bundle,
					}),
				]);

				const claimedA = new Set(a?.claimedMessageIds ?? []);
				const claimedB = new Set(b?.claimedMessageIds ?? []);
				const overlap = [...claimedA].filter((id) => claimedB.has(id));

				// Asserted on CONTENTS, not on counts: two bundles of the right
				// size that both contain the same message is the failure this
				// exists to catch.
				expect(overlap).toEqual([]);
				expect([...claimedA, ...claimedB].sort()).toEqual(
					all.map((m) => m.providerMessageId).sort(),
				);
				expect(
					await db.projectContextConversationClaim.count({
						where: { parentContextId: contextId },
					}),
				).toBe(all.length);
			});

			it("writes no bundle when a worker wins no claims", async () => {
				const contextId = await seedContext({
					projectId: personalProjectId,
					userId: USER_ID,
					organizationId: null,
				});
				const tenant: ConversationCaptureTenant = {
					userId: USER_ID,
					organizationId: null,
				};
				const messages = [{ providerMessageId: `m-${RUN}-loser` }];
				const bundle = (): ConversationBundleDraft => ({
					content: "x",
					contentHash: "x",
					bundleStartedAt: new Date(),
				});

				const winner = await recordConversationBundle({
					parentContextId: contextId,
					projectId: personalProjectId,
					tenant,
					messages,
					buildBundle: bundle,
				});
				const loser = await recordConversationBundle({
					parentContextId: contextId,
					projectId: personalProjectId,
					tenant,
					messages,
					buildBundle: bundle,
				});

				expect(winner).not.toBeNull();
				expect(loser).toBeNull();
				expect(
					await db.projectContextConversationBundle.count({
						where: { parentContextId: contextId },
					}),
				).toBe(1);
			});

			it("stamps each won claim with the bundle it was folded into", async () => {
				const contextId = await seedContext({
					projectId: orgProjectId,
					userId: USER_ID,
					organizationId: ORG_ID,
				});
				const recorded = await recordConversationBundle({
					parentContextId: contextId,
					projectId: orgProjectId,
					tenant: { userId: USER_ID, organizationId: ORG_ID },
					messages: [
						{ providerMessageId: `m-${RUN}-stamp-a` },
						{ providerMessageId: `m-${RUN}-stamp-b` },
					],
					buildBundle: (claimed) => ({
						content: claimed
							.map((c) => c.providerMessageId)
							.join("\n"),
						contentHash: "stamped",
						bundleStartedAt: new Date(),
					}),
				});

				expect(recorded).not.toBeNull();
				const claims =
					await db.projectContextConversationClaim.findMany({
						where: { parentContextId: contextId },
						select: {
							bundleId: true,
							organizationId: true,
							userId: true,
						},
					});
				expect(claims).toHaveLength(2);
				for (const claim of claims) {
					expect(claim.bundleId).toBe(recorded?.bundleId);
					// An organization row names the organization and nothing
					// else — the XOR the CHECK enforces.
					expect(claim.organizationId).toBe(ORG_ID);
					expect(claim.userId).toBeNull();
				}
			});
		});

		describe("reading bundles back", () => {
			it("returns one parent's bundles in chronological order", async () => {
				const contextId = await seedContext({
					projectId: personalProjectId,
					userId: USER_ID,
					organizationId: null,
				});
				const tenant: ConversationCaptureTenant = {
					userId: USER_ID,
					organizationId: null,
				};
				const day = (n: number) =>
					new Date(Date.UTC(2026, 0, n, 12, 0, 0));

				// Written middle, oldest, newest — so a suite that happens to
				// read in insertion order fails.
				for (const [suffix, startedAt] of [
					["mid", day(2)],
					["old", day(1)],
					["new", day(3)],
				] as const) {
					await recordConversationBundle({
						parentContextId: contextId,
						projectId: personalProjectId,
						tenant,
						messages: [
							{ providerMessageId: `m-${RUN}-order-${suffix}` },
						],
						buildBundle: () => ({
							content: suffix,
							contentHash: suffix,
							bundleStartedAt: startedAt,
						}),
					});
				}

				const bundles: ConversationBundleRow[] =
					await listConversationBundlesForContext({
						parentContextId: contextId,
						tenant,
					});

				expect(bundles.map((b) => b.content)).toEqual([
					"old",
					"mid",
					"new",
				]);
				expect(
					bundles.map((b) => b.bundleStartedAt.toISOString()),
				).toEqual([
					day(1).toISOString(),
					day(2).toISOString(),
					day(3).toISOString(),
				]);
			});

			it("does not return another tenant's bundles", async () => {
				const orgOnly = await seedContext({
					projectId: orgProjectId,
					userId: USER_ID,
					organizationId: ORG_ID,
				});
				await recordConversationBundle({
					parentContextId: orgOnly,
					projectId: orgProjectId,
					tenant: { userId: USER_ID, organizationId: ORG_ID },
					messages: [{ providerMessageId: `m-${RUN}-xor` }],
					buildBundle: () => ({
						content: "org only",
						contentHash: "org only",
						bundleStartedAt: new Date(),
					}),
				});

				const asPersonal = await listConversationBundlesForContext({
					parentContextId: orgOnly,
					tenant: { userId: USER_ID, organizationId: null },
				});
				expect(asPersonal).toEqual([]);

				const asOrg = await listConversationBundlesForContext({
					parentContextId: orgOnly,
					tenant: { userId: USER_ID, organizationId: ORG_ID },
				});
				expect(asOrg.map((b) => b.content)).toEqual(["org only"]);
			});
		});
	},
);
