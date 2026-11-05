/**
 * Problem Log (Fizzy #2277) against a real Postgres: fingerprint
 * aggregation, the per-project / per-user split, reopen on recurrence, the
 * tenant guard on projectId, and status changes with their audit rows.
 *
 * Self-skips without a reachable DATABASE_URL. Run with:
 *   DATABASE_URL=... pnpm --filter @repo/database exec vitest run __tests__/problem-log.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { failBackgroundJob } from "../prisma/queries/background-jobs";
import {
	draftProblemsFromContext,
	listProblemLogEntries,
	listProblemLogReportRows,
	listProblemLogStatusHistory,
	problemDedupKey,
	type RecordProblemInput,
	recordProblem,
	reviewProblemLogEntry,
	setProblemLogEntryStatus,
} from "../prisma/queries/problem-log";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN = `${Date.now()}-${process.pid}`;
const id = (name: string) => `problem-log-it-${name}-${RUN}`;

const USER = id("user");
const OTHER_USER = id("other-user");
const ORG_A = id("org-a");
const ORG_B = id("org-b");
const PA = id("project-a");
const PA2 = id("project-a2");
const PB = id("project-b");

function event(
	overrides: Partial<RecordProblemInput> = {},
): RecordProblemInput {
	return {
		organizationId: ORG_A,
		projectId: PA,
		affectedUserId: USER,
		category: "SYSTEM_ERROR",
		severity: "ERROR",
		source: "api:projects.get",
		title: "TypeError in projects.get",
		fingerprint: `fp-${RUN}`,
		...overrides,
	};
}

async function entryFor(input: RecordProblemInput, organizationId = ORG_A) {
	return db.problemLogEntry.findUnique({
		where: {
			organizationId_dedupKey: {
				organizationId,
				dedupKey: problemDedupKey(input),
			},
		},
	});
}

async function mustEntryFor(input: RecordProblemInput) {
	const entry = await entryFor(input);
	if (!entry) {
		throw new Error("expected a Problem Log entry");
	}
	return entry;
}

describe.skipIf(!hasReachableDatabaseUrl())("Problem Log (Fizzy #2277)", () => {
	beforeAll(async () => {
		const now = new Date();
		for (const userId of [USER, OTHER_USER]) {
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
		for (const [projectId, organizationId] of [
			[PA, ORG_A],
			[PA2, ORG_A],
			[PB, ORG_B],
		] as const) {
			await db.project.create({
				data: {
					id: projectId,
					name: `Example ${projectId}`,
					userId: USER,
					organizationId,
					techStack: [],
					features: [],
					tags: [],
				},
			});
		}
	});

	afterAll(async () => {
		await db.$transaction(async (tx) => {
			await tx.$executeRaw`SET LOCAL app.audit_allow_delete = 'on'`;
			await tx.auditLog.deleteMany({
				where: {
					organizationId: { in: [ORG_A, ORG_B] },
					resourceType: "problem_log_entry",
				},
			});
		});
		await db.problemLogEntry.deleteMany({
			where: { organizationId: { in: [ORG_A, ORG_B] } },
		});
		await db.member.deleteMany({
			where: { organizationId: { in: [ORG_A, ORG_B] } },
		});
		await db.project.deleteMany({ where: { id: { in: [PA, PA2, PB] } } });
		await db.organization.deleteMany({
			where: { id: { in: [ORG_A, ORG_B] } },
		});
		await db.user.deleteMany({ where: { id: { in: [USER, OTHER_USER] } } });
	});

	it("aggregates repeated occurrences into one entry and escalates severity", async () => {
		const input = event({ fingerprint: id("aggregate") });
		await recordProblem(input);
		await recordProblem(input);
		await recordProblem({ ...input, severity: "CRITICAL" });

		const entry = await mustEntryFor(input);
		expect(entry.occurrenceCount).toBe(3);
		expect(entry.severity).toBe("CRITICAL");
		expect(entry?.status).toBe("OPEN");
		expect(entry?.reviewState).toBe("CONFIRMED");
		expect(entry.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
			entry.firstSeenAt.getTime(),
		);
	});

	it("keeps a separate entry per affected user and per project", async () => {
		const base = event({ fingerprint: id("split") });
		await recordProblem(base);
		await recordProblem({ ...base, affectedUserId: OTHER_USER });
		await recordProblem({ ...base, projectId: PA2 });

		const rows = await db.problemLogEntry.findMany({
			where: {
				organizationId: ORG_A,
				source: base.source,
				title: base.title,
			},
		});
		const keys = new Set(rows.map((row) => row.dedupKey));
		expect(keys.has(problemDedupKey(base))).toBe(true);
		expect(
			keys.has(problemDedupKey({ ...base, affectedUserId: OTHER_USER })),
		).toBe(true);
		expect(keys.has(problemDedupKey({ ...base, projectId: PA2 }))).toBe(
			true,
		);
	});

	it("aggregates concurrent first occurrences without losing a count", async () => {
		const input = event({ fingerprint: id("race") });
		await Promise.all(
			Array.from({ length: 5 }, () => recordProblem(input)),
		);
		expect((await entryFor(input))?.occurrenceCount).toBe(5);
	});

	it("drops INFO and organization-less events", async () => {
		const info = event({ fingerprint: id("info"), severity: "INFO" });
		await recordProblem(info);
		await recordProblem(
			event({ fingerprint: id("no-org"), organizationId: null }),
		);
		expect(await entryFor(info)).toBeNull();
	});

	it("drops a projectId that belongs to another organization", async () => {
		const foreign = event({ fingerprint: id("foreign"), projectId: PB });
		await recordProblem(foreign);
		const entry = await entryFor({ ...foreign, projectId: null });
		expect(entry).not.toBeNull();
		expect(entry?.projectId).toBeNull();
	});

	it("resolves with an audit row, reopens on recurrence, and keeps the history", async () => {
		const input = event({ fingerprint: id("lifecycle") });
		await recordProblem(input);
		const entry = await mustEntryFor(input);

		const resolved = await setProblemLogEntryStatus({
			organizationId: ORG_A,
			entryId: entry.id,
			status: "RESOLVED",
			note: "Fixed by retrying the sync",
			actor: { userId: USER },
		});
		expect(resolved?.status).toBe("RESOLVED");
		expect(resolved?.resolvedById).toBe(USER);

		// Same status again: no-op, no second audit row.
		await setProblemLogEntryStatus({
			organizationId: ORG_A,
			entryId: entry.id,
			status: "RESOLVED",
			actor: { userId: USER },
		});

		await recordProblem(input);
		const reopened = await mustEntryFor(input);
		expect(reopened.status).toBe("OPEN");
		expect(reopened.resolvedAt).toBeNull();
		expect(reopened.occurrenceCount).toBe(2);

		const history = await listProblemLogStatusHistory(ORG_A, entry.id);
		expect(
			history.map((h) => [h.previousStatus, h.newStatus, h.actorType]),
		).toEqual([
			["OPEN", "RESOLVED", "user"],
			["RESOLVED", "OPEN", "system"],
		]);
		expect(history[0]?.note).toBe("Fixed by retrying the sync");
	});

	it("refuses a status change from another organization", async () => {
		const input = event({ fingerprint: id("cross-org") });
		await recordProblem(input);
		const entry = await mustEntryFor(input);
		const result = await setProblemLogEntryStatus({
			organizationId: ORG_B,
			entryId: entry.id,
			status: "RESOLVED",
			actor: { userId: OTHER_USER },
		});
		expect(result).toBeNull();
		expect((await entryFor(input))?.status).toBe("OPEN");
	});

	it("logs a background job closed as FAILED, once per job close", async () => {
		const workflowId = id("code-index-wf");
		await db.backgroundJob.create({
			data: {
				kind: "CODE_INDEXING",
				title: "Index example-repo",
				workflowId,
				projectId: PA,
				userId: USER,
				organizationId: ORG_A,
			},
		});
		await failBackgroundJob(
			{ workflowId },
			{
				error: "Repository not reachable",
				errorClass: "RepoUnreachable",
			},
		);
		// A second close finds no RUNNING row and must not log again.
		await failBackgroundJob(
			{ workflowId },
			{
				error: "Repository not reachable",
				errorClass: "RepoUnreachable",
			},
		);

		const rows = await db.problemLogEntry.findMany({
			where: { organizationId: ORG_A, source: "job:CODE_INDEXING" },
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			category: "BACKGROUND_JOB_FAILURE",
			projectId: PA,
			affectedUserId: USER,
			title: "Index example-repo failed",
			description: "Repository not reachable",
			occurrenceCount: 1,
		});
		await db.backgroundJob.deleteMany({ where: { workflowId } });
	});

	it("lists only the requested projects; 'all' includes organization-level entries", async () => {
		const orgLevel = event({
			fingerprint: id("org-level"),
			projectId: null,
		});
		await recordProblem(orgLevel);

		const scoped = await listProblemLogEntries({
			organizationId: ORG_A,
			projectIds: [PA2],
		});
		expect(scoped.items.every((row) => row.projectId === PA2)).toBe(true);

		const all = await listProblemLogEntries({
			organizationId: ORG_A,
			projectIds: "all",
			limit: 100,
		});
		expect(all.items.some((row) => row.projectId === null)).toBe(true);
		expect(all.items.every((row) => row.organizationId === ORG_A)).toBe(
			true,
		);

		const none = await listProblemLogEntries({
			organizationId: ORG_A,
			projectIds: [],
		});
		expect(none.items).toEqual([]);
	});

	describe("drafts from project context", () => {
		const TRANSCRIPT = id("transcript");
		const actor = { userId: USER };

		async function drafts() {
			return db.problemLogEntry.findMany({
				where: { organizationId: ORG_A, sourceId: TRANSCRIPT },
				orderBy: { title: "asc" },
			});
		}

		it("writes PENDING drafts that the confirmed list never shows", async () => {
			const written = await draftProblemsFromContext({
				organizationId: ORG_A,
				projectId: PA,
				sourceType: "MEETING_TRANSCRIPT",
				sourceId: TRANSCRIPT,
				drafts: [
					{
						category: "PROJECT_BLOCKER",
						title: "Vendor API keys not issued",
						sourceQuote: "we still have no keys from the vendor",
					},
					{
						category: "PROJECT_RISK",
						title: "Launch may slip a week",
					},
				],
			});
			expect(written).toBe(2);
			const rows = await drafts();
			expect(rows.map((r) => r.reviewState)).toEqual([
				"PENDING",
				"PENDING",
			]);
			expect(
				rows.find((r) => r.category === "PROJECT_BLOCKER"),
			).toMatchObject({
				severity: "ERROR",
				sourceType: "MEETING_TRANSCRIPT",
				sourceQuote: "we still have no keys from the vendor",
			});

			const confirmed = await listProblemLogEntries({
				organizationId: ORG_A,
				projectIds: [PA],
				limit: 100,
			});
			expect(confirmed.items.some((r) => r.sourceId === TRANSCRIPT)).toBe(
				false,
			);
			const pending = await listProblemLogEntries({
				organizationId: ORG_A,
				projectIds: [PA],
				reviewState: "PENDING",
			});
			expect(
				pending.items.filter((r) => r.sourceId === TRANSCRIPT),
			).toHaveLength(2);
		});

		it("is idempotent per source: re-extraction adds nothing", async () => {
			const written = await draftProblemsFromContext({
				organizationId: ORG_A,
				projectId: PA,
				sourceType: "MEETING_TRANSCRIPT",
				sourceId: TRANSCRIPT,
				drafts: [
					// Re-worded case and punctuation, re-labelled category.
					{
						category: "PROJECT_ISSUE",
						title: "vendor API keys not issued!",
					},
				],
			});
			expect(written).toBe(0);
			expect(await drafts()).toHaveLength(2);
		});

		it("refuses a project of another organization", async () => {
			const written = await draftProblemsFromContext({
				organizationId: ORG_A,
				projectId: PB,
				sourceType: "MEETING_TRANSCRIPT",
				sourceId: id("foreign"),
				drafts: [
					{ category: "PROJECT_RISK", title: "Should not land" },
				],
			});
			expect(written).toBe(0);
		});

		it("confirms with the reviewer's edits and writes one audit row", async () => {
			const [blocker] = (await drafts()).filter(
				(r) => r.category === "PROJECT_BLOCKER",
			);
			const confirmed = await reviewProblemLogEntry({
				organizationId: ORG_A,
				entryId: blocker.id,
				decision: "CONFIRM",
				edits: {
					title: "Vendor keys blocked go-live",
					severity: "CRITICAL",
				},
				actor,
			});
			expect(confirmed).toMatchObject({
				reviewState: "CONFIRMED",
				title: "Vendor keys blocked go-live",
				severity: "CRITICAL",
				status: "OPEN",
				reviewedById: USER,
			});

			// A second review of the same draft is refused.
			expect(
				await reviewProblemLogEntry({
					organizationId: ORG_A,
					entryId: blocker.id,
					decision: "DISMISS",
					actor,
				}),
			).toBeNull();

			const audits = await db.auditLog.findMany({
				where: {
					organizationId: ORG_A,
					action: "project.problem_log.reviewed",
					resourceId: blocker.id,
				},
			});
			expect(audits).toHaveLength(1);
			expect(audits[0].metadata).toMatchObject({
				decision: "CONFIRM",
				editedFields: ["title", "severity"],
			});
		});

		it("dismisses without applying edits, and a dismissed draft never returns", async () => {
			const [risk] = (await drafts()).filter(
				(r) => r.category === "PROJECT_RISK",
			);
			const dismissed = await reviewProblemLogEntry({
				organizationId: ORG_A,
				entryId: risk.id,
				decision: "DISMISS",
				edits: { title: "ignored" },
				actor,
			});
			expect(dismissed).toMatchObject({
				reviewState: "DISMISSED",
				title: "Launch may slip a week",
			});
			await draftProblemsFromContext({
				organizationId: ORG_A,
				projectId: PA,
				sourceType: "MEETING_TRANSCRIPT",
				sourceId: TRANSCRIPT,
				drafts: [
					{
						category: "PROJECT_RISK",
						title: "Launch may slip a week",
					},
				],
			});
			const again = await db.problemLogEntry.findUniqueOrThrow({
				where: { id: risk.id },
			});
			expect(again.reviewState).toBe("DISMISSED");
		});

		it("refuses a review from another organization", async () => {
			const [row] = await drafts();
			expect(
				await reviewProblemLogEntry({
					organizationId: ORG_B,
					entryId: row.id,
					decision: "CONFIRM",
					actor,
				}),
			).toBeNull();
		});
	});

	describe("incident report rows", () => {
		it("returns one confirmed entry with its project resolved", async () => {
			const input = event({ fingerprint: id("report") });
			await recordProblem(input);
			const entry = await mustEntryFor(input);

			const report = await listProblemLogReportRows({
				organizationId: ORG_A,
				projectId: PA,
				entryId: entry.id,
			});
			expect(report.truncated).toBe(false);
			expect(report.rows).toHaveLength(1);
			expect(report.rows[0]).toMatchObject({
				id: entry.id,
				projectName: `Example ${PA}`,
				status: "OPEN",
			});
		});

		it("names an affected user only when they are a member of the organization", async () => {
			const member = event({ fingerprint: id("report-member") });
			const outsider = event({
				fingerprint: id("report-outsider"),
				affectedUserId: OTHER_USER,
			});
			await recordProblem(member);
			await recordProblem(outsider);
			await db.member.create({
				data: {
					id: id("member"),
					organizationId: ORG_A,
					userId: USER,
					role: "member",
					createdAt: new Date(),
				},
			});
			const memberEntry = await mustEntryFor(member);
			const outsiderEntry = await mustEntryFor(outsider);

			const report = await listProblemLogReportRows({
				organizationId: ORG_A,
				projectId: PA,
			});
			const byId = new Map(report.rows.map((r) => [r.id, r]));
			expect(byId.get(memberEntry.id)?.affectedUser).toBe(USER);
			expect(byId.get(outsiderEntry.id)?.affectedUser).toBeNull();
		});

		it("keeps only entries seen inside the range", async () => {
			const input = event({ fingerprint: id("report-range") });
			await recordProblem(input);
			const entry = await mustEntryFor(input);
			const before = new Date(entry.firstSeenAt.getTime() - 86_400_000);

			const outside = await listProblemLogReportRows({
				organizationId: ORG_A,
				projectId: PA,
				from: new Date(before.getTime() - 86_400_000),
				to: before,
			});
			expect(outside.rows.some((r) => r.id === entry.id)).toBe(false);

			const inside = await listProblemLogReportRows({
				organizationId: ORG_A,
				projectId: PA,
				from: before,
			});
			expect(inside.rows.some((r) => r.id === entry.id)).toBe(true);
		});

		it("never reports drafts or another organization's project", async () => {
			const pending = await listProblemLogReportRows({
				organizationId: ORG_A,
				projectId: PA,
			});
			const ids = (
				await db.problemLogEntry.findMany({
					where: {
						organizationId: ORG_A,
						reviewState: { not: "CONFIRMED" },
					},
					select: { id: true },
				})
			).map((r) => r.id);
			expect(pending.rows.some((r) => ids.includes(r.id))).toBe(false);

			const foreign = await listProblemLogReportRows({
				organizationId: ORG_B,
				projectId: PA,
			});
			expect(foreign.rows).toEqual([]);
		});
	});
});
