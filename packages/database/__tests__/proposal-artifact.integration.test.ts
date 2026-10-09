/**
 * Real-Postgres integration test for the Proposal artifact tables and queries
 * (Fizzy #2801).
 *
 * Two halves:
 *  1. The guarded writers, on the superuser connection the API and worker
 *     use: the live-section run and attempt guards, analysis run creation and
 *     completion (including two completions racing on one run under the real
 *     row lock), newest-run reads, and the style upsert.
 *  2. Row-level security, under the NOSUPERUSER/NOBYPASSRLS test role
 *     (`_helpers/rls-role.ts`): the organization reads its own analysis,
 *     finding and style rows; another organization and a project guest — an
 *     accepted project member with no organization membership — read none,
 *     even on the project the guest was invited to, and cannot write any.
 *
 * Requires the Proposal artifact migration and `apply:rls` on the target
 * database. Self-skips without a reachable DATABASE_URL.
 *
 * Run with: pnpm --filter @repo/database test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, type Prisma } from "../prisma/client";
import {
	computeDocumentContentHash,
	markDocumentGenerationQueued,
	markDocumentGenerationRunning,
} from "../prisma/queries/projects/documents";
import {
	type CreateAnalysisRunInput,
	type CreateAnalysisRunResult,
	claimLiveAttempt,
	clearLiveContent,
	completeAnalysisRun,
	createAnalysisRun,
	failAnalysisRun,
	getDocumentStyle,
	getLatestAnalysisForDocument,
	markAnalysisRunning,
	resetLiveSections,
	upsertDocumentStyle,
	writeLiveSections,
} from "../prisma/queries/projects/proposal-artifact";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";
import {
	asRlsRole,
	ensureRlsTestRole,
	type TenantCtx,
} from "./_helpers/rls-role";

const RUN = `${Date.now()}-${process.pid}`;
const id = (name: string) => `proposal-it-${name}-${RUN}`;

const USERS = {
	owner: id("owner"),
	ownerB: id("owner-b"),
	guest: id("guest"),
};
const ORG_A = id("org-a");
const ORG_B = id("org-b");
const PA = id("project-a");
const PB = id("project-b");

const MAIN = "# Example proposal\n\n## Scope\n\nWhat the engagement covers.";

/** The generation run every fresh document belongs to, unless reset. */
const LIVE_RUN = "run-saved";

let documentCounter = 0;
async function freshDocument(
	projectId = PA,
	overrides: Partial<Prisma.ProjectDocumentUncheckedCreateInput> = {},
): Promise<string> {
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
			content: MAIN,
			status: "GENERATING",
			userId: project.userId,
			organizationId: project.organizationId,
			liveRunId: LIVE_RUN,
			...overrides,
		},
	});
	return documentId;
}

/** Record a run for a document still owned by {@link LIVE_RUN}. */
async function recordRun(
	input: Omit<CreateAnalysisRunInput, "liveRunId">,
): Promise<CreateAnalysisRunResult> {
	const run = await createAnalysisRun({ liveRunId: LIVE_RUN, ...input });
	if (run === "superseded") {
		throw new Error("expected the run to be recorded, not superseded");
	}
	return run;
}

async function liveColumns(documentId: string) {
	return db.projectDocument.findUniqueOrThrow({
		where: { id: documentId },
		select: {
			content: true,
			liveContent: true,
			liveRunId: true,
			liveAttempt: true,
			updatedAt: true,
		},
	});
}

const findings = [
	{
		severity: "BLOCKING" as const,
		type: "COMMERCIAL" as const,
		title: "Pricing is not stated",
		detail: "The commercial section names no figure.",
	},
	{
		severity: "INFORMATIONAL" as const,
		type: "OPPORTUNITY" as const,
		title: "Follow-on phase",
		detail: "A second phase is implied.",
		sectionHeading: "Scope",
	},
];

describe.skipIf(!hasReachableDatabaseUrl())(
	"Proposal artifact (real Postgres)",
	() => {
		beforeAll(async () => {
			const present = await db.$queryRaw<{ name: string | null }[]>`
				SELECT to_regclass('public.project_document_analysis')::text AS name`;
			if (!present[0]?.name) {
				throw new Error(
					"project_document_analysis is missing: apply the Proposal artifact migration (prisma migrate deploy) and apply:rls to this database first",
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
			// The guest belongs to no organization at all: an accepted
			// EDITOR on project A only.
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
			// Projects cascade to documents, members, analysis runs, findings
			// and styles.
			await db.project.deleteMany({ where: { id: { in: [PA, PB] } } });
			await db.organization.deleteMany({
				where: { id: { in: [ORG_A, ORG_B] } },
			});
			await db.user.deleteMany({
				where: { id: { in: Object.values(USERS) } },
			});
		});

		describe("live sections", () => {
			it("a run writes its sections; a stale run, a stale attempt and a finished document are superseded", async () => {
				const documentId = await freshDocument();
				await resetLiveSections({ documentId, runId: "run-1" });
				expect(
					await claimLiveAttempt({
						documentId,
						runId: "run-1",
						attempt: 1,
					}),
				).toBe("written");

				const before = (await liveColumns(documentId)).updatedAt;
				const at = new Date(before.getTime() + 60_000);
				expect(
					await writeLiveSections({
						documentId,
						runId: "run-1",
						attempt: 1,
						content: "## Scope\n\nDone.",
						now: at,
					}),
				).toBe("written");
				expect(await liveColumns(documentId)).toMatchObject({
					content: MAIN,
					liveContent: "## Scope\n\nDone.",
					liveAttempt: 1,
					updatedAt: at,
				});

				// Attempt 2 takes over; attempt 1 can no longer write.
				expect(
					await claimLiveAttempt({
						documentId,
						runId: "run-1",
						attempt: 2,
					}),
				).toBe("written");
				expect(
					await writeLiveSections({
						documentId,
						runId: "run-1",
						attempt: 1,
						content: "## Stale attempt",
					}),
				).toBe("superseded");

				// A newer run takes the document over.
				await resetLiveSections({ documentId, runId: "run-2" });
				expect(await liveColumns(documentId)).toMatchObject({
					liveContent: null,
					liveRunId: "run-2",
					liveAttempt: null,
				});
				expect(
					await writeLiveSections({
						documentId,
						runId: "run-1",
						attempt: 2,
						content: "## Stale run",
					}),
				).toBe("superseded");
				expect(
					await clearLiveContent({ documentId, runId: "run-1" }),
				).toBe("superseded");

				await db.projectDocument.update({
					where: { id: documentId },
					data: { status: "COMPLETE" },
				});
				expect(
					await writeLiveSections({
						documentId,
						runId: "run-2",
						attempt: 1,
						content: "## After completion",
					}),
				).toBe("superseded");
				expect((await liveColumns(documentId)).liveContent).toBeNull();
			});

			it("a plan with the attempt identity takes the document only while the document still carries it", async () => {
				const startedAt = new Date("2026-10-07T09:00:00.123Z");
				const documentId = await freshDocument(PA, {
					generationStartedAt: startedAt,
				});
				expect(
					await resetLiveSections({
						documentId,
						runId: "run-a",
						generationStartedAt: new Date(startedAt),
					}),
				).toBe("written");

				// A newer request stamps its own identity.
				await db.projectDocument.update({
					where: { id: documentId },
					data: {
						generationStartedAt: new Date(startedAt.getTime() + 1),
					},
				});
				expect(
					await resetLiveSections({
						documentId,
						runId: "run-a-late",
						generationStartedAt: startedAt,
					}),
				).toBe("superseded");
				expect((await liveColumns(documentId)).liveRunId).toBe("run-a");
			});

			it("two attempts claiming at once leave the later attempt holding the run", async () => {
				const documentId = await freshDocument();
				await resetLiveSections({ documentId, runId: "run-race" });
				const outcomes = await Promise.all([
					claimLiveAttempt({
						documentId,
						runId: "run-race",
						attempt: 1,
					}),
					claimLiveAttempt({
						documentId,
						runId: "run-race",
						attempt: 2,
					}),
				]);
				expect(outcomes).toContain("written");
				expect((await liveColumns(documentId)).liveAttempt).toBe(2);
			});

			it("a new request's queue mark ends the previous run's ownership before the new run claims", async () => {
				// Run A finished writing and still owns the document.
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
					liveRunId: "run-a",
					liveAttempt: 1,
				});

				// Request B is accepted: its attempt identity, then its mark.
				const attemptB = new Date(Date.now() + 1_000);
				const queued = await markDocumentGenerationQueued(documentId, {
					generationStartedAt: attemptB,
				});
				expect(queued.applied).toBe(true);
				expect(await liveColumns(documentId)).toMatchObject({
					liveRunId: null,
					liveAttempt: null,
					liveContent: null,
				});

				// A's late guarded writes in the queue-to-plan interval match
				// nothing, so the row stays QUEUED for B.
				expect(
					await clearLiveContent({ documentId, runId: "run-a" }),
				).toBe("superseded");
				expect(
					await db.projectDocument.updateMany({
						where: { id: documentId, liveRunId: "run-a" },
						data: { status: "COMPLETE", generationProgress: 100 },
					}),
				).toEqual({ count: 0 });

				// B starts and claims as it would have without A.
				expect(
					await markDocumentGenerationRunning(documentId, attemptB),
				).toBe("started");
				expect(
					await resetLiveSections({
						documentId,
						runId: "run-b",
						generationStartedAt: attemptB,
					}),
				).toBe("written");
				expect((await liveColumns(documentId)).liveRunId).toBe("run-b");
			});
		});

		describe("analysis runs", () => {
			it("stores the saved body, its hash and version, and is idempotent per run key", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
					version: 4,
				});
				const runKey = id("analysis-idempotent");
				const first = await recordRun({
					documentId,
					runKey,
					sourceContext: "Context",
					contextCount: 1,
				});
				const again = await recordRun({
					documentId,
					runKey,
					sourceContext: "Other",
					contextCount: 5,
				});
				expect(first.created).toBe(true);
				expect(again).toEqual({ ...first, created: false });

				const row = await db.projectDocumentAnalysis.findUniqueOrThrow({
					where: { id: first.analysisId },
				});
				expect(row).toMatchObject({
					organizationId: ORG_A,
					projectId: PA,
					status: "PENDING",
					analyzedContent: MAIN,
					contentHash: computeDocumentContentHash(MAIN),
					documentVersion: 4,
					sourceContext: "Context",
				});
			});

			it("records nothing for a run whose document a newer generation took", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
					liveRunId: "run-newer",
				});
				expect(
					await createAnalysisRun({
						documentId,
						runKey: id("analysis-superseded"),
						liveRunId: LIVE_RUN,
						sourceContext: "Context",
						contextCount: 1,
					}),
				).toBe("superseded");
				expect(
					await db.projectDocumentAnalysis.count({
						where: { documentId },
					}),
				).toBe(0);
			});

			it("two completions racing on one run: the first wins and keeps its findings", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const { analysisId } = await recordRun({
					documentId,
					runKey: id("analysis-race"),
					sourceContext: "",
					contextCount: 0,
				});
				expect(await markAnalysisRunning(analysisId)).toBe("written");

				const laterAttempt = [
					{ ...findings[0], title: "A later attempt's finding" },
				];
				const outcomes = await Promise.all([
					completeAnalysisRun({ analysisId, findings }),
					completeAnalysisRun({ analysisId, findings: laterAttempt }),
				]);
				expect([...outcomes].sort()).toEqual(["superseded", "written"]);
				const winner =
					outcomes[0] === "written" ? findings : laterAttempt;

				const rows = await db.projectDocumentFinding.findMany({
					where: { analysisId },
					orderBy: { position: "asc" },
				});
				expect(rows.map((r) => r.title)).toEqual(
					winner.map((f) => f.title),
				);
				expect(rows.every((r) => r.organizationId === ORG_A)).toBe(
					true,
				);

				// Completing it again, after the race, changes nothing.
				expect(
					await completeAnalysisRun({ analysisId, findings: [] }),
				).toBe("superseded");
				expect(
					await db.projectDocumentFinding.count({
						where: { analysisId },
					}),
				).toBe(winner.length);
			});

			it("a failed run is not resurrected, and zero findings complete a run", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const failed = await recordRun({
					documentId,
					runKey: id("analysis-failed"),
					sourceContext: "",
					contextCount: 0,
				});
				expect(
					await failAnalysisRun({
						analysisId: failed.analysisId,
						errorCode: "ANALYSIS_FAILED",
						errorMessage: "The analysis could not be completed.",
					}),
				).toBe("written");
				expect(
					await completeAnalysisRun({
						analysisId: failed.analysisId,
						findings,
					}),
				).toBe("superseded");
				expect(
					await db.projectDocumentFinding.count({
						where: { analysisId: failed.analysisId },
					}),
				).toBe(0);

				const empty = await recordRun({
					documentId,
					runKey: id("analysis-empty"),
					sourceContext: "",
					contextCount: 0,
				});
				expect(
					await completeAnalysisRun({
						analysisId: empty.analysisId,
						findings: [],
					}),
				).toBe("written");
				expect(
					(
						await db.projectDocumentAnalysis.findUniqueOrThrow({
							where: { id: empty.analysisId },
						})
					).status,
				).toBe("COMPLETE");
			});

			it("the newest run wins even when an older one completes later", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const older = await recordRun({
					documentId,
					runKey: id("analysis-older"),
					sourceContext: "",
					contextCount: 0,
				});
				// createdAt has millisecond resolution; keep the two apart.
				await new Promise((resolve) => setTimeout(resolve, 5));
				const newer = await recordRun({
					documentId,
					runKey: id("analysis-newer"),
					sourceContext: "",
					contextCount: 0,
				});
				await markAnalysisRunning(newer.analysisId);
				await completeAnalysisRun({
					analysisId: older.analysisId,
					findings,
				});

				const latest = await getLatestAnalysisForDocument({
					documentId,
					organizationId: ORG_A,
				});
				expect(latest?.id).toBe(newer.analysisId);
				expect(latest?.status).toBe("RUNNING");
				expect(latest).not.toHaveProperty("analyzedContent");
				expect(latest).not.toHaveProperty("sourceContext");
				expect(
					await getLatestAnalysisForDocument({
						documentId,
						organizationId: ORG_B,
					}),
				).toBeNull();
			});
		});

		describe("style", () => {
			it("upserts one row per document with tenant columns from the project", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				await upsertDocumentStyle({
					documentId,
					projectId: PA,
					styleDirection: "Calm",
					primaryColor: "#112233",
					accentColors: ["#445566"],
					updatedById: USERS.owner,
				});
				await upsertDocumentStyle({
					documentId,
					projectId: PA,
					styleDirection: "Bold",
					primaryColor: null,
					accentColors: [],
					updatedById: USERS.guest,
				});
				expect(
					await db.projectDocumentStyle.count({
						where: { documentId },
					}),
				).toBe(1);
				expect(
					await getDocumentStyle({
						documentId,
						organizationId: ORG_A,
					}),
				).toMatchObject({
					organizationId: ORG_A,
					projectId: PA,
					styleDirection: "Bold",
					primaryColor: null,
					accentColors: [],
					updatedById: USERS.guest,
				});
			});
		});

		describe("row-level security (restricted role)", () => {
			const guest: TenantCtx = {
				type: "personal",
				tenantId: USERS.guest,
				userId: USERS.guest,
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

			let documentId: string;
			let analysisId: string;

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

			beforeAll(async () => {
				const policies = await db.$queryRaw<{ tablename: string }[]>`
					SELECT tablename::text AS tablename FROM pg_policies
					WHERE tablename IN ('project_document_analysis', 'project_document_finding', 'project_document_style')
					AND policyname = 'tenant_isolation'`;
				if (policies.length !== 3) {
					throw new Error(
						"Proposal artifact RLS policies are missing: run apply:rls against this database first",
					);
				}
				await ensureRlsTestRole();

				documentId = await freshDocument(PA, { status: "COMPLETE" });
				analysisId = (
					await recordRun({
						documentId,
						runKey: id("analysis-rls"),
						sourceContext: "Internal context",
						contextCount: 1,
					})
				).analysisId;
				await completeAnalysisRun({ analysisId, findings });
				await upsertDocumentStyle({
					documentId,
					projectId: PA,
					styleDirection: "Calm",
					primaryColor: null,
					accentColors: [],
					updatedById: USERS.owner,
				});

				// One row of each in organization B, which A must not see.
				const otherDocument = await freshDocument(PB, {
					status: "COMPLETE",
				});
				const other = await recordRun({
					documentId: otherDocument,
					runKey: id("analysis-rls-b"),
					sourceContext: "",
					contextCount: 0,
				});
				await completeAnalysisRun({
					analysisId: other.analysisId,
					findings: [findings[0]],
				});
				await upsertDocumentStyle({
					documentId: otherDocument,
					projectId: PB,
					styleDirection: null,
					primaryColor: null,
					accentColors: [],
					updatedById: USERS.ownerB,
				});
			});

			const reads = [
				{
					name: "project_document_analysis",
					count: (
						tx: Prisma.TransactionClient,
						organizationId: string,
					) =>
						tx.projectDocumentAnalysis.count({
							where: { organizationId },
						}),
				},
				{
					name: "project_document_finding",
					count: (
						tx: Prisma.TransactionClient,
						organizationId: string,
					) =>
						tx.projectDocumentFinding.count({
							where: { organizationId },
						}),
				},
				{
					name: "project_document_style",
					count: (
						tx: Prisma.TransactionClient,
						organizationId: string,
					) =>
						tx.projectDocumentStyle.count({
							where: { organizationId },
						}),
				},
			];

			it.each(reads)(
				"$name: the organization reads its own rows; another organization and a project guest read none",
				async (table) => {
					const read = (ctx: TenantCtx, organizationId: string) =>
						asRlsRole(ctx, (tx) => table.count(tx, organizationId));
					expect(await read(orgA, ORG_A)).toBeGreaterThan(0);
					expect(await read(orgA, ORG_B)).toBe(0);
					expect(await read(orgB, ORG_B)).toBeGreaterThan(0);
					expect(await read(orgB, ORG_A)).toBe(0);
					// The guest is an accepted member of project A, and still
					// reads nothing.
					expect(await read(guest, ORG_A)).toBe(0);
					expect(await read(guest, ORG_B)).toBe(0);
				},
			);

			it("a project guest cannot write analysis, finding or style rows on the invited project", async () => {
				expect(
					await attempt(guest, (tx) =>
						tx.projectDocumentAnalysis.create({
							data: {
								organizationId: ORG_A,
								projectId: PA,
								documentId,
								runKey: id("analysis-guest-insert"),
								analyzedContent: MAIN,
								contentHash: "hash",
								sourceContext: "",
							},
						}),
					),
				).toBe("denied");
				expect(
					await attempt(guest, (tx) =>
						tx.projectDocumentFinding.create({
							data: {
								organizationId: ORG_A,
								analysisId,
								severity: "BLOCKING",
								type: "SCOPE",
								title: "Injected",
								detail: "Injected.",
								position: 99,
							},
						}),
					),
				).toBe("denied");
				const updated = await asRlsRole(guest, (tx) =>
					tx.projectDocumentStyle.updateMany({
						where: { documentId },
						data: { styleDirection: "Guest edit" },
					}),
				);
				expect(updated.count).toBe(0);
			});

			it("an organization cannot write rows into another organization", async () => {
				expect(
					await attempt(orgA, (tx) =>
						tx.projectDocumentFinding.create({
							data: {
								organizationId: ORG_B,
								analysisId,
								severity: "BLOCKING",
								type: "SCOPE",
								title: "Cross-tenant",
								detail: "Cross-tenant.",
								position: 99,
							},
						}),
					),
				).toBe("denied");
				expect(
					await attempt(orgA, (tx) =>
						tx.projectDocumentStyle.updateMany({
							where: { documentId },
							data: { organizationId: ORG_B },
						}),
					),
				).toBe("denied");
			});
		});
	},
);
