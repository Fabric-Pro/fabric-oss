/**
 * Real-Postgres integration test for the Proposal artifact tables and queries
 * (Fizzy #2801, #2946).
 *
 * Two halves:
 *  1. The guarded writers, on the superuser connection the API and worker
 *     use: the live-section run and attempt guards, analysis run creation and
 *     completion (including two completions racing on one run under the real
 *     row lock, and the analysis report the winner stores), newest-run reads,
 *     the style upsert, the run shown for the current content, the re-run
 *     claim (two claims racing on the document lock), and members' answers
 *     (two writers racing on one key).
 *  2. Row-level security, under the NOSUPERUSER/NOBYPASSRLS test role
 *     (`_helpers/rls-role.ts`): the organization reads its own analysis,
 *     finding, answer and style rows; another organization and a project
 *     guest — an accepted project member with no organization membership —
 *     read none (no manifest or report either), even on the project the
 *     guest was invited to, and cannot write any.
 *
 * Requires the Proposal artifact migrations and `apply:rls` on the target
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
	claimRerun,
	clearFindingResponse,
	clearLiveContent,
	completeAnalysisRun,
	createAnalysisRun,
	failAnalysisRun,
	getAnalysisForCurrentContent,
	getAnalysisReport,
	getAnalysisRunInput,
	getDocumentStyle,
	getLatestAnalysisForDocument,
	listResponsesForDocument,
	markAnalysisRunning,
	normalizeAnalysisReport,
	PROPOSAL_ANALYSIS_MATCH_WINDOW,
	PROPOSAL_ANALYSIS_TIMED_OUT_FAILURE,
	PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH,
	PROPOSAL_REPORT_TEXT_MAX_CODE_UNITS,
	type ProposalAnalysisReportInput,
	readProposalEvidenceSources,
	resetLiveSections,
	type UpsertFindingResponseInput,
	type UpsertFindingResponseResult,
	upsertDocumentStyle,
	upsertFindingResponse,
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
/** Deleted by the test that proves an answer outlives its author. */
const DEPARTING_AUTHOR = id("departing-author");
const ORG_A = id("org-a");
const ORG_B = id("org-b");
const PA = id("project-a");
const PB = id("project-b");
/** Moved from organization A to B by the test that proves it fails closed. */
const PC = id("project-c");
/** Another project of organization A, whose rows another project never reads. */
const PD = id("project-d");

const MAIN = "# Example proposal\n\n## Scope\n\nWhat the engagement covers.";
const REWRITTEN = "# Example proposal\n\n## Scope\n\nA different engagement.";

/**
 * A stand-in for the document prose hash, blind to markdown markers and
 * whitespace as the real one is blind to formatting.
 */
const proseHashOf = (content: string) =>
	`p1:${content.replace(/[\s#*_-]/g, "")}`;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

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

/** An analysis report as the worker hands it to the completion. */
function analysisReport(
	label: string,
	overrides: Partial<ProposalAnalysisReportInput> = {},
): ProposalAnalysisReportInput {
	return {
		assessment: `${label} assessment`,
		summary: `${label} summary.`,
		scope: [
			{
				item: `${label} discovery`,
				priority: "MUST",
				inProposal: "Yes",
				note: "Two days.",
			},
		],
		beforeSending: [`${label}: state the fixed fee.`],
		duringDiscovery: [`${label}: confirm the hosting target.`],
		sources: [1],
		text: `## ${label}\n\nThe ${label} report. [S1]`,
		textTruncated: false,
		...overrides,
	};
}

/** Every string anywhere in `value`. */
function allStrings(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(allStrings);
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value).flatMap(allStrings);
	}
	return [];
}

/** The runtime's own check for unpaired surrogates. */
const isWellFormed = (text: string) =>
	(text as unknown as { isWellFormed(): boolean }).isWellFormed();

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
			for (const userId of [...Object.values(USERS), DEPARTING_AUTHOR]) {
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
				[PC, ORG_A, USERS.owner],
				[PD, ORG_A, USERS.owner],
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
			// Projects cascade to documents, members, contexts, analysis runs,
			// findings, answers and styles; organizations to company context
			// sources.
			await db.project.deleteMany({
				where: { id: { in: [PA, PB, PC, PD] } },
			});
			await db.organization.deleteMany({
				where: { id: { in: [ORG_A, ORG_B] } },
			});
			await db.user.deleteMany({
				where: {
					id: { in: [...Object.values(USERS), DEPARTING_AUTHOR] },
				},
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

			it("a report holding NUL, lone surrogates and 60,000 astral characters stores well formed beside its findings (Fizzy #2946)", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const { analysisId } = await recordRun({
					documentId,
					runKey: id("analysis-report-hostile"),
					sourceContext: "",
					contextCount: 0,
				});
				await markAnalysisRunning(analysisId);

				const hostile = `Nul\u0000 high\uD83D low\uDE00 ${"😀".repeat(60_000)}`;
				const input = analysisReport("Hostile", {
					assessment: "Ready\u0000\uD83D",
					summary: hostile,
					scope: [
						{
							item: hostile,
							priority: "SHOULD",
							inProposal: "\uDE00",
							note: hostile,
						},
					],
					beforeSending: [hostile],
					duringDiscovery: [hostile],
					text: hostile,
				});
				expect(
					await completeAnalysisRun({
						analysisId,
						findings,
						report: input,
					}),
				).toBe("written");

				expect(
					await db.projectDocumentFinding.count({
						where: { analysisId },
					}),
				).toBe(findings.length);
				const row = await db.projectDocumentAnalysis.findUniqueOrThrow({
					where: { id: analysisId },
					select: { status: true, report: true, reportText: true },
				});
				expect(row.status).toBe("COMPLETE");
				for (const text of [
					...allStrings(row.report),
					row.reportText ?? "",
				]) {
					expect(text).not.toContain("\u0000");
					expect(isWellFormed(text)).toBe(true);
				}
				// Stored exactly as normalised: Postgres changed nothing.
				const expected = normalizeAnalysisReport(input);
				expect(row.report).toEqual(expected?.report);
				expect(row.reportText).toBe(expected?.reportText);
				expect(row.reportText?.length).toBeLessThanOrEqual(
					PROPOSAL_REPORT_TEXT_MAX_CODE_UNITS,
				);
				expect(
					row.reportText?.startsWith("Nul high\uFFFD low\uFFFD "),
				).toBe(true);

				const read = await getAnalysisReport({
					organizationId: ORG_A,
					documentId,
					analysisId,
				});
				expect(read).toMatchObject({
					assessment: "Ready\uFFFD",
					textTruncated: true,
					text: row.reportText,
				});
				expect(read?.scope[0]?.inProposal).toBe("\uFFFD");
				expect(
					await getAnalysisReport({
						organizationId: ORG_B,
						documentId,
						analysisId,
					}),
				).toBeNull();
			});

			it("a refused completion leaves the first writer's report byte-identical (Fizzy #2946)", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const { analysisId } = await recordRun({
					documentId,
					runKey: id("analysis-report-race"),
					sourceContext: "",
					contextCount: 0,
				});
				expect(await markAnalysisRunning(analysisId)).toBe("written");

				const laterAttempt = [
					{ ...findings[0], title: "A later attempt's finding" },
				];
				const outcomes = await Promise.all([
					completeAnalysisRun({
						analysisId,
						findings,
						report: analysisReport("First"),
					}),
					completeAnalysisRun({
						analysisId,
						findings: laterAttempt,
						report: analysisReport("Second"),
					}),
				]);
				expect([...outcomes].sort()).toEqual(["superseded", "written"]);
				const winner = outcomes[0] === "written" ? "First" : "Second";

				const stored = () =>
					db.$queryRaw<
						{ report: string | null; reportText: string | null }[]
					>`
						SELECT "report"::text AS "report", "reportText"
						FROM "project_document_analysis"
						WHERE "id" = ${analysisId}`;
				const [before] = await stored();
				expect(before?.reportText).toBe(
					`## ${winner}\n\nThe ${winner} report. [S1]`,
				);
				expect(before?.report).toContain(`${winner} assessment`);

				expect(
					await completeAnalysisRun({
						analysisId,
						findings: [],
						report: analysisReport("Late"),
					}),
				).toBe("superseded");
				expect(await stored()).toEqual([before]);
				expect(
					await db.projectDocumentFinding.count({
						where: { analysisId },
					}),
				).toBe(
					winner === "First" ? findings.length : laterAttempt.length,
				);
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

			it("keeps a stored automatic-diagrams switch through a save that leaves it out", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const base = {
					documentId,
					projectId: PA,
					styleDirection: null,
					primaryColor: null,
					accentColors: [],
					updatedById: USERS.owner,
				};
				expect((await upsertDocumentStyle(base)).autoVisuals).toBe(
					true,
				);
				await upsertDocumentStyle({ ...base, autoVisuals: false });
				await upsertDocumentStyle({ ...base, styleDirection: "Calm" });
				expect(
					await getDocumentStyle({
						documentId,
						organizationId: ORG_A,
					}),
				).toMatchObject({ styleDirection: "Calm", autoVisuals: false });
			});
		});

		/** A COMPLETE generation run over the document's saved body. */
		async function completedRun(
			documentId: string,
			overrides: Partial<CreateAnalysisRunInput> = {},
			liveRunId = LIVE_RUN,
		): Promise<string> {
			const run = await createAnalysisRun({
				documentId,
				runKey: id(`analysis-${documentId}-${liveRunId}`),
				liveRunId,
				sourceContext: "### Source 1\nContext",
				contextCount: 1,
				computeProseHash: proseHashOf,
				...overrides,
			});
			if (run === "superseded") {
				throw new Error("expected the run to be recorded");
			}
			await completeAnalysisRun({ analysisId: run.analysisId, findings });
			return run.analysisId;
		}

		/** A first answer; an edit spreads in the id and version it saw. */
		function answer(
			documentId: string,
			answeredRunId: string,
			overrides: Partial<
				Omit<
					UpsertFindingResponseInput,
					"expectedResponseId" | "expectedVersion"
				>
			> = {},
		): UpsertFindingResponseInput {
			return {
				organizationId: ORG_A,
				projectId: PA,
				documentId,
				stableKey: "commercial|scope|pricing",
				kind: "RESPONDED",
				text: "The fixed fee is in the commercial annex.",
				findingTitle: "Pricing is not stated",
				answeredRunId,
				sectionKey: "scope#0",
				sectionHash: "p1:scope",
				authorId: USERS.owner,
				...overrides,
			};
		}

		/** The saved row of a write that went through. */
		function written(result: UpsertFindingResponseResult) {
			if (result.outcome !== "written") {
				throw new Error("expected the answer to be written");
			}
			return result.response;
		}

		describe("the run shown for the current content (Fizzy #2946)", () => {
			it("prefers the run describing the current content, hashing a run recorded before prose hashes existed", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const legacy = await completedRun(documentId, {
					computeProseHash: undefined,
				});
				expect(
					(
						await db.projectDocumentAnalysis.findUniqueOrThrow({
							where: { id: legacy },
						})
					).proseHash,
				).toBeNull();

				// A newer generation over other content, then the restore.
				await db.projectDocument.update({
					where: { id: documentId },
					data: { content: REWRITTEN, liveRunId: "run-newer" },
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				await completedRun(documentId, {}, "run-newer");
				await db.projectDocument.update({
					where: { id: documentId },
					data: { content: MAIN },
				});

				const shown = await getAnalysisForCurrentContent({
					organizationId: ORG_A,
					documentId,
					currentProseHash: proseHashOf(MAIN),
					computeProseHash: proseHashOf,
				});
				expect(shown.run?.id).toBe(legacy);
				expect(shown.run?.proseHash).toBe(proseHashOf(MAIN));
				expect(shown.isStale).toBe(false);
				expect(shown.run).not.toHaveProperty("analyzedContent");
				expect(shown.run).not.toHaveProperty("sourceContext");
				expect(
					(
						await getAnalysisForCurrentContent({
							organizationId: ORG_B,
							documentId,
							currentProseHash: proseHashOf(MAIN),
							computeProseHash: proseHashOf,
						})
					).run,
				).toBeNull();
			});

			it("restored content finds the run describing it however many generations ago it was recorded, for the tab and for a re-run's sources", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const original = await completedRun(documentId, {
					sourceContext: "### Source 1\nOriginal context",
				});
				for (let n = 0; n < PROPOSAL_ANALYSIS_MATCH_WINDOW; n += 1) {
					const liveRunId = `run-later-${n}`;
					await db.projectDocument.update({
						where: { id: documentId },
						data: {
							content: `${REWRITTEN} Version ${n}.`,
							liveRunId,
						},
					});
					await new Promise((resolve) => setTimeout(resolve, 5));
					await completedRun(
						documentId,
						{ sourceContext: `### Source 1\nLater context ${n}` },
						liveRunId,
					);
				}
				await db.projectDocument.update({
					where: { id: documentId },
					data: { content: MAIN },
				});

				expect(
					await getAnalysisForCurrentContent({
						organizationId: ORG_A,
						documentId,
						currentProseHash: proseHashOf(MAIN),
						computeProseHash: proseHashOf,
					}),
				).toMatchObject({
					run: { id: original },
					isStale: false,
					newerRun: null,
				});
				const claimed = await claimRerun({
					organizationId: ORG_A,
					projectId: PA,
					documentId,
					promptVersionId: null,
					computeProseHash: proseHashOf,
				});
				if (claimed.outcome !== "claimed") {
					throw new Error(`expected a claim, got ${claimed.reason}`);
				}
				expect(claimed.run.sourceRunId).toBe(original);
				expect(
					await getAnalysisRunInput(claimed.run.analysisId),
				).toMatchObject({
					sourceContextRunId: original,
					sourceContext: "### Source 1\nOriginal context",
				});
			});

			it("after a Reject, a failed run older than the newest completed one is not reported", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const shown = await completedRun(documentId);
				// A regeneration whose analysis failed, then one whose
				// analysis completed, then the Reject.
				await db.projectDocument.update({
					where: { id: documentId },
					data: { content: REWRITTEN, liveRunId: "run-failed" },
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				const failed = await createAnalysisRun({
					documentId,
					runKey: id(`analysis-${documentId}-run-failed`),
					liveRunId: "run-failed",
					sourceContext: "### Source 1\nContext",
					contextCount: 1,
					computeProseHash: proseHashOf,
				});
				if (failed === "superseded") {
					throw new Error("expected the failed run to be recorded");
				}
				expect(
					await failAnalysisRun({
						analysisId: failed.analysisId,
						errorCode: "MODEL_ERROR",
						errorMessage: "The analysis could not be completed.",
					}),
				).toBe("written");
				await db.projectDocument.update({
					where: { id: documentId },
					data: { liveRunId: "run-completed" },
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				await completedRun(documentId, {}, "run-completed");
				await db.projectDocument.update({
					where: { id: documentId },
					data: { content: MAIN },
				});

				expect(
					await getAnalysisForCurrentContent({
						organizationId: ORG_A,
						documentId,
						currentProseHash: proseHashOf(MAIN),
						computeProseHash: proseHashOf,
					}),
				).toMatchObject({
					run: { id: shown },
					isStale: false,
					newerRun: null,
				});
			});
		});

		describe("re-run claim (Fizzy #2946)", () => {
			function claim(documentId: string, projectId = PA) {
				return claimRerun({
					organizationId: ORG_A,
					projectId,
					documentId,
					promptVersionId: null,
					computeProseHash: proseHashOf,
				});
			}

			it("two claims at once create one run; the other is a conflict", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				await completedRun(documentId);

				const outcomes = await Promise.all([
					claim(documentId),
					claim(documentId),
				]);
				expect(outcomes.map((o) => o.outcome).sort()).toEqual([
					"claimed",
					"conflict",
				]);
				expect(
					await db.projectDocumentAnalysis.count({
						where: { documentId, kind: "RERUN" },
					}),
				).toBe(1);
			});

			it("a RUNNING run silent for more than twenty minutes is marked FAILED and does not block", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const stuck = await recordRun({
					documentId,
					runKey: id("analysis-stuck"),
					sourceContext: "",
					contextCount: 0,
				});
				await markAnalysisRunning(stuck.analysisId);
				await db.$executeRaw`
					UPDATE "project_document_analysis"
					SET "createdAt" = ${minutesAgo(40)}, "updatedAt" = ${minutesAgo(21)}
					WHERE "id" = ${stuck.analysisId}`;

				const result = await claim(documentId);
				expect(result).toMatchObject({
					outcome: "claimed",
					run: { timedOutRunIds: [stuck.analysisId] },
				});
				expect(
					await db.projectDocumentAnalysis.findUniqueOrThrow({
						where: { id: stuck.analysisId },
					}),
				).toMatchObject({
					status: "FAILED",
					errorCode: PROPOSAL_ANALYSIS_TIMED_OUT_FAILURE.errorCode,
				});
				expect(
					await completeAnalysisRun({
						analysisId: stuck.analysisId,
						findings,
					}),
				).toBe("superseded");
			});

			it("a RUNNING run created 25 minutes ago but updated 5 minutes ago blocks", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const retried = await recordRun({
					documentId,
					runKey: id("analysis-retried"),
					sourceContext: "",
					contextCount: 0,
				});
				await markAnalysisRunning(retried.analysisId);
				await db.$executeRaw`
					UPDATE "project_document_analysis"
					SET "createdAt" = ${minutesAgo(25)}, "updatedAt" = ${minutesAgo(5)}
					WHERE "id" = ${retried.analysisId}`;

				expect(await claim(documentId)).toEqual({
					outcome: "conflict",
					reason: "ANALYSIS_IN_PROGRESS",
				});
				expect(
					await db.projectDocumentAnalysis.count({
						where: { documentId },
					}),
				).toBe(1);
			});

			it("a GENERATING document is a conflict and gets no run", async () => {
				const documentId = await freshDocument(PA);
				expect(await claim(documentId)).toEqual({
					outcome: "conflict",
					reason: "DOCUMENT_GENERATING",
				});
				expect(
					await db.projectDocumentAnalysis.count({
						where: { documentId },
					}),
				).toBe(0);
			});

			it("after a Reject, the re-run reads the generation run describing the restored content, and its run input follows it", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const original = await completedRun(documentId, {
					sourceContext: "### Source 1\nOriginal context",
					sourceManifest: [
						{
							source: 1,
							kind: "projectContext",
							id: "context-example",
							contextType: "LINK",
							title: "Example link",
							fingerprint: "f1",
						},
					],
				});
				await db.projectDocument.update({
					where: { id: documentId },
					data: { content: REWRITTEN, liveRunId: "run-rejected" },
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				await completedRun(
					documentId,
					{ sourceContext: "### Source 1\nRejected context" },
					"run-rejected",
				);
				await db.projectDocument.update({
					where: { id: documentId },
					data: { content: MAIN },
				});

				const result = await claim(documentId);
				if (result.outcome !== "claimed") {
					throw new Error(`expected a claim, got ${result.reason}`);
				}
				expect(result.run.sourceRunId).toBe(original);
				expect(result.run.runKey).toBe(
					`proposal-analysis-rerun-${documentId}-${result.run.analysisId}`,
				);
				expect(
					await getAnalysisRunInput(result.run.analysisId),
				).toMatchObject({
					kind: "RERUN",
					analyzedContent: MAIN,
					proseHash: proseHashOf(MAIN),
					sourceContextRunId: original,
					sourceContext: "### Source 1\nOriginal context",
					sourceManifest: [
						expect.objectContaining({ id: "context-example" }),
					],
				});
			});

			it("after the newest generation's analysis failed, the re-run reads that generation's stored sources, not an older complete run's", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				await completedRun(documentId, {
					sourceContext: "### Source 1\nOlder context",
				});
				// A newer generation over the same content: it stored its
				// sources, then its analysis failed.
				await db.projectDocument.update({
					where: { id: documentId },
					data: { liveRunId: "run-failed" },
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				const failed = await createAnalysisRun({
					documentId,
					runKey: id(`analysis-${documentId}-run-failed`),
					liveRunId: "run-failed",
					sourceContext: "### Source 1\nFailed run's context",
					contextCount: 3,
					computeProseHash: proseHashOf,
					sourceManifest: [
						{
							source: 1,
							kind: "projectContext",
							id: "context-failed-run",
							contextType: "TEXT",
							title: "Example notes",
							fingerprint: "f2",
						},
					],
				});
				if (failed === "superseded") {
					throw new Error("expected the run to be recorded");
				}
				await markAnalysisRunning(failed.analysisId);
				expect(
					await failAnalysisRun({
						analysisId: failed.analysisId,
						errorCode: "MODEL_ERROR",
						errorMessage: "The analysis could not be completed.",
					}),
				).toBe("written");
				// Newer still: a generation a project guest started, recorded
				// FAILED with no source context. Never a source.
				await db.projectDocument.update({
					where: { id: documentId },
					data: { liveRunId: "run-guest" },
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				const guest = await createAnalysisRun({
					documentId,
					runKey: id(`analysis-${documentId}-run-guest`),
					liveRunId: "run-guest",
					sourceContext: "",
					contextCount: 0,
					computeProseHash: proseHashOf,
					failure: {
						errorCode: "GUEST_TRIGGERED",
						errorMessage: "Started by a project guest.",
					},
				});
				if (guest === "superseded") {
					throw new Error("expected the guest's run to be recorded");
				}
				expect(guest.status).toBe("FAILED");

				const result = await claim(documentId);
				if (result.outcome !== "claimed") {
					throw new Error(`expected a claim, got ${result.reason}`);
				}
				expect(result.run.sourceRunId).toBe(failed.analysisId);
				expect(
					await db.projectDocumentAnalysis.findUniqueOrThrow({
						where: { id: result.run.analysisId },
						select: { contextCount: true, sourceContext: true },
					}),
				).toEqual({ contextCount: 3, sourceContext: "" });
				expect(
					await getAnalysisRunInput(result.run.analysisId),
				).toMatchObject({
					kind: "RERUN",
					sourceContextRunId: failed.analysisId,
					sourceContext: "### Source 1\nFailed run's context",
					sourceManifest: [
						expect.objectContaining({ id: "context-failed-run" }),
					],
				});
			});
		});

		describe("evidence sources read now (Fizzy #2946)", () => {
			const longText = (letter: string) =>
				letter.repeat(PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH + 500);

			async function context(
				projectId: string,
				organizationId: string,
				data: Partial<Prisma.ProjectContextUncheckedCreateInput> = {},
			): Promise<string> {
				const row = await db.projectContext.create({
					data: {
						projectId,
						organizationId,
						type: "TEXT",
						content: "Example notes.",
						...data,
					},
					select: { id: true },
				});
				return row.id;
			}

			async function companySource(
				organizationId: string,
				data: Partial<Prisma.CompanyContextSourceUncheckedCreateInput> = {},
			): Promise<string> {
				const row = await db.companyContextSource.create({
					data: {
						organizationId,
						type: "TEXT",
						content: "Example company notes.",
						...data,
					},
					select: { id: true },
				});
				return row.id;
			}

			it("returns only this project's contexts and the organization's live company sources, with the text head capped and no address", async () => {
				const site = await context(PA, ORG_A, {
					type: "LINK",
					sourceTitle: "Client website",
					sourceUrl: "https://example.com/private-page",
					content: longText("a"),
				});
				const notes = await context(PA, ORG_A, {
					originalFilename: "brief.md",
					sourcePath: `notes/${RUN}.md`,
					content: "Short notes.",
				});
				const otherProject = await context(PD, ORG_A, {
					sourceTitle: "Another project's notes",
				});
				const otherOrganization = await context(PB, ORG_B, {
					sourceTitle: "Another organization's notes",
				});
				const rateCard = await companySource(ORG_A, {
					sourceTitle: "Rate card",
					originalFilename: "rates.pdf",
					sourceUrl: "https://example.com/pricing",
					content: longText("b"),
				});
				const deleting = await companySource(ORG_A, {
					sourceTitle: "Retired price list",
					deletingAt: new Date(),
				});
				const foreign = await companySource(ORG_B, {
					sourceTitle: "Another organization's rate card",
				});

				const read = await readProposalEvidenceSources({
					organizationId: ORG_A,
					projectId: PA,
					contextIds: [
						site,
						notes,
						site,
						otherProject,
						otherOrganization,
						id("context-missing"),
					],
					companySourceIds: [rateCard, deleting, foreign, rateCard],
				});

				const byId = <T extends { id: string }>(rows: T[]) =>
					[...rows].sort((a, b) => a.id.localeCompare(b.id));
				expect(byId(read.contexts)).toEqual(
					byId([
						{
							id: site,
							type: "LINK",
							sourceTitle: "Client website",
							originalFilename: null,
							sourcePath: null,
							contentHead: "a".repeat(
								PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH,
							),
						},
						{
							id: notes,
							type: "TEXT",
							sourceTitle: null,
							originalFilename: "brief.md",
							sourcePath: `notes/${RUN}.md`,
							contentHead: "Short notes.",
						},
					]),
				);
				expect(read.companySources).toEqual([
					{
						id: rateCard,
						sourceTitle: "Rate card",
						originalFilename: "rates.pdf",
						contentHead: "b".repeat(
							PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH,
						),
					},
				]);
				expect(JSON.stringify(read)).not.toContain("https://");
			});

			it("another organization reads none of this project's contexts or this organization's company sources, and no ids read nothing", async () => {
				const notes = await context(PA, ORG_A);
				const theirs = await context(PB, ORG_B);
				const ours = await companySource(ORG_A);

				expect(
					await readProposalEvidenceSources({
						organizationId: ORG_B,
						projectId: PA,
						contextIds: [notes, theirs],
						companySourceIds: [ours],
					}),
				).toEqual({ contexts: [], companySources: [] });
				expect(
					await readProposalEvidenceSources({
						organizationId: ORG_A,
						projectId: PA,
						contextIds: [],
						companySourceIds: [],
					}),
				).toEqual({ contexts: [], companySources: [] });
			});
		});

		describe("finding responses (Fizzy #2946)", () => {
			it("two first answers racing on one key leave one row and never a unique-key error", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const runId = await completedRun(documentId);

				const outcomes = await Promise.all([
					upsertFindingResponse(answer(documentId, runId)),
					upsertFindingResponse(
						answer(documentId, runId, { text: "Another answer." }),
					),
				]);
				expect(outcomes.map((o) => o.outcome).sort()).toEqual([
					"stale",
					"written",
				]);
				expect(
					await db.projectDocumentFindingResponse.count({
						where: { documentId },
					}),
				).toBe(1);
			});

			it("two edits of one version racing: one is written, the other is stale with it", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const runId = await completedRun(documentId);
				const seen = written(
					await upsertFindingResponse(answer(documentId, runId)),
				);

				const outcomes = await Promise.all([
					upsertFindingResponse({
						...answer(documentId, runId, { text: "First edit." }),
						expectedResponseId: seen.id,
						expectedVersion: 1,
					}),
					upsertFindingResponse({
						...answer(documentId, runId, { text: "Second edit." }),
						expectedResponseId: seen.id,
						expectedVersion: 1,
					}),
				]);
				expect(outcomes.map((o) => o.outcome).sort()).toEqual([
					"stale",
					"written",
				]);
				const stale = outcomes.find((o) => o.outcome === "stale");
				expect(stale).toMatchObject({
					current: { id: seen.id, version: 2 },
				});
				const [row] = await listResponsesForDocument({
					organizationId: ORG_A,
					documentId,
				});
				expect(row?.version).toBe(2);
			});

			it("an edit or a clear naming an answer cleared and given again since is stale and changes nothing, though the new answer is back at version 1", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const runId = await completedRun(documentId);
				const stableKey = "commercial|scope|pricing";
				const seen = written(
					await upsertFindingResponse(answer(documentId, runId)),
				);
				expect(
					await clearFindingResponse({
						organizationId: ORG_A,
						documentId,
						stableKey,
						responseId: seen.id,
						version: 1,
					}),
				).toEqual({ outcome: "cleared", kind: "RESPONDED" });
				// A colleague answers the same finding again: a new row.
				const colleague = written(
					await upsertFindingResponse(
						answer(documentId, runId, {
							text: "A colleague's answer.",
						}),
					),
				);
				expect(colleague.id).not.toBe(seen.id);
				expect(colleague.version).toBe(1);
				const current = {
					id: colleague.id,
					kind: "RESPONDED",
					text: "A colleague's answer.",
					authorId: USERS.owner,
					version: 1,
				};

				// A tab still holding the first answer's id and version 1.
				expect(
					await upsertFindingResponse({
						...answer(documentId, runId, {
							text: "An edit of the first answer.",
						}),
						expectedResponseId: seen.id,
						expectedVersion: 1,
					}),
				).toMatchObject({ outcome: "stale", current });
				expect(
					await clearFindingResponse({
						organizationId: ORG_A,
						documentId,
						stableKey,
						responseId: seen.id,
						version: 1,
					}),
				).toMatchObject({ outcome: "stale", current });
				expect(
					await listResponsesForDocument({
						organizationId: ORG_A,
						documentId,
					}),
				).toEqual([
					expect.objectContaining({
						...current,
						updatedAt: colleague.updatedAt,
					}),
				]);
			});

			it("deleting the author keeps the answer with no author; deleting the document removes it", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const runId = await completedRun(documentId);
				await upsertFindingResponse(
					answer(documentId, runId, { authorId: DEPARTING_AUTHOR }),
				);

				await db.user.delete({ where: { id: DEPARTING_AUTHOR } });
				expect(
					await listResponsesForDocument({
						organizationId: ORG_A,
						documentId,
					}),
				).toEqual([expect.objectContaining({ authorId: null })]);

				await db.projectDocument.delete({ where: { id: documentId } });
				expect(
					await db.projectDocumentFindingResponse.count({
						where: { documentId },
					}),
				).toBe(0);
			});

			it("answers are invisible to another organization and on another document", async () => {
				const documentId = await freshDocument(PA, {
					status: "COMPLETE",
				});
				const runId = await completedRun(documentId);
				await upsertFindingResponse(answer(documentId, runId));
				const otherDocument = await freshDocument(PA, {
					status: "COMPLETE",
				});

				expect(
					await listResponsesForDocument({
						organizationId: ORG_B,
						documentId,
					}),
				).toEqual([]);
				expect(
					await listResponsesForDocument({
						organizationId: ORG_A,
						documentId: otherDocument,
					}),
				).toEqual([]);
			});

			it("after the project moves to another organization, its answers and runs are unreachable through the owning organization", async () => {
				const documentId = await freshDocument(PC, {
					status: "COMPLETE",
				});
				const runId = await completedRun(documentId);
				await upsertFindingResponse(
					answer(documentId, runId, { projectId: PC }),
				);

				await db.project.update({
					where: { id: PC },
					data: { organizationId: ORG_B },
				});
				expect(
					await listResponsesForDocument({
						organizationId: ORG_B,
						documentId,
					}),
				).toEqual([]);
				expect(
					(
						await getAnalysisForCurrentContent({
							organizationId: ORG_B,
							documentId,
							currentProseHash: proseHashOf(MAIN),
							computeProseHash: proseHashOf,
						})
					).run,
				).toBeNull();
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
					WHERE tablename IN ('project_document_analysis', 'project_document_finding', 'project_document_finding_response', 'project_document_style')
					AND policyname = 'tenant_isolation'`;
				if (policies.length !== 4) {
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
						sourceManifest: [
							{
								source: 1,
								kind: "other",
								fingerprint: "f1",
							},
						],
					})
				).analysisId;
				await completeAnalysisRun({
					analysisId,
					findings,
					report: analysisReport("Internal"),
				});
				await upsertFindingResponse(answer(documentId, analysisId));
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
				await upsertFindingResponse(
					answer(otherDocument, other.analysisId, {
						organizationId: ORG_B,
						projectId: PB,
						authorId: USERS.ownerB,
					}),
				);
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
					name: "project_document_finding_response",
					count: (
						tx: Prisma.TransactionClient,
						organizationId: string,
					) =>
						tx.projectDocumentFindingResponse.count({
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

			it("a project guest reads no source manifest, even on the invited project", async () => {
				const manifests = (ctx: TenantCtx) =>
					asRlsRole(ctx, async (tx) => {
						const [row] = await tx.$queryRaw<{ n: number }[]>`
							SELECT count(*)::int AS n FROM "project_document_analysis"
							WHERE "organizationId" = ${ORG_A}
							AND "sourceManifest" IS NOT NULL`;
						return row?.n ?? 0;
					});
				expect(await manifests(orgA)).toBeGreaterThan(0);
				expect(await manifests(guest)).toBe(0);
				expect(await manifests(orgB)).toBe(0);
			});

			it("another organization and a project guest read no analysis report, even on the invited project (Fizzy #2946)", async () => {
				const reports = (ctx: TenantCtx) =>
					asRlsRole(ctx, async (tx) => {
						const [row] = await tx.$queryRaw<{ n: number }[]>`
							SELECT count(*)::int AS n FROM "project_document_analysis"
							WHERE "organizationId" = ${ORG_A}
							AND ("report" IS NOT NULL OR "reportText" IS NOT NULL)`;
						return row?.n ?? 0;
					});
				expect(await reports(orgA)).toBeGreaterThan(0);
				expect(await reports(orgB)).toBe(0);
				expect(await reports(guest)).toBe(0);

				const run = (ctx: TenantCtx) =>
					asRlsRole(ctx, (tx) =>
						tx.projectDocumentAnalysis.findFirst({
							where: { id: analysisId },
							select: { report: true, reportText: true },
						}),
					);
				expect((await run(orgA))?.reportText).toContain(
					"Internal report",
				);
				expect(await run(orgB)).toBeNull();
				expect(await run(guest)).toBeNull();
			});

			it("a project guest cannot write an answer on the invited project, or change one", async () => {
				expect(
					await attempt(guest, (tx) =>
						tx.projectDocumentFindingResponse.create({
							data: {
								organizationId: ORG_A,
								projectId: PA,
								documentId,
								stableKey: id("guest-key"),
								kind: "RESPONDED",
								text: "Injected.",
								findingTitle: "Injected",
								answeredRunId: analysisId,
								sectionKey: "scope#0",
								sectionHash: "p1:scope",
							},
						}),
					),
				).toBe("denied");
				const updated = await asRlsRole(guest, (tx) =>
					tx.projectDocumentFindingResponse.updateMany({
						where: { documentId },
						data: { text: "Guest edit" },
					}),
				);
				expect(updated.count).toBe(0);
				const removed = await asRlsRole(guest, (tx) =>
					tx.projectDocumentFindingResponse.deleteMany({
						where: { documentId },
					}),
				);
				expect(removed.count).toBe(0);
			});

			it("an organization cannot write an answer into another organization", async () => {
				expect(
					await attempt(orgA, (tx) =>
						tx.projectDocumentFindingResponse.create({
							data: {
								organizationId: ORG_B,
								projectId: PA,
								documentId,
								stableKey: id("cross-tenant-key"),
								kind: "CONFIRMED",
								findingTitle: "Cross-tenant",
								answeredRunId: analysisId,
								sectionKey: "scope#0",
								sectionHash: "p1:scope",
							},
						}),
					),
				).toBe("denied");
			});

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
