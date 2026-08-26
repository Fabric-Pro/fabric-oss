/**
 * Findings — one distinct FAILURE, tracked across runs.
 *
 * Identity is the fingerprint the caller computes with `fingerprintFinding`,
 * which is derived from what broke and why, never from the run id or the clock.
 * So the same broken assertion recurring nightly is ONE row with a rising
 * `occurrences`, not N rows nobody reads.
 *
 * A finding is the observation; a bug is the decision to act on it. These
 * queries deliberately never open a bug on their own — promotion is a person's
 * call, made in {@link promoteFindingToBug}.
 */

import { db, Prisma, type TestFailureKind } from "../../client";
import { createStory } from "./stories";

/** One failure as the caller observed it in a run. */
export interface ObservedFailure {
	/** From `fingerprintFinding` — the grouping key. */
	fingerprint: string;
	testName: string;
	classname?: string | null;
	failureMessage?: string | null;
	/** The case the linkage cascade matched, when it resolved one. */
	testCaseId?: string | null;
}

export interface RecordFindingsInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	/** The run these failures were observed in. */
	pipelineRunId: string | null;
	failures: ObservedFailure[];
	/** Defaults to now; injectable so tests are not clock-dependent. */
	observedAt?: Date;
}

export interface RecordFindingsResult {
	/** Fingerprints seen for the first time in this project. */
	created: number;
	/** Fingerprints that already existed and had their occurrence bumped. */
	updated: number;
}

/**
 * Upsert one finding per distinct failure in a run.
 *
 * De-duplicates WITHIN the run first: a suite that fails the same assertion in
 * twenty parameterised cases reports twenty failures with one fingerprint, and
 * that is one finding seen once — not one finding seen twenty times, which
 * would make `occurrences` a measure of suite shape rather than of recurrence.
 *
 * A finding that had been RESOLVED or IGNORED and then recurs is reopened: the
 * failure is back, and leaving it closed is how a regression goes unnoticed. A
 * PROMOTED one is left alone — its bug is already tracking it, and flipping it
 * back to OPEN would double-report.
 */
export async function recordFindingsForRun(
	input: RecordFindingsInput,
): Promise<RecordFindingsResult> {
	const observedAt = input.observedAt ?? new Date();

	const distinct = new Map<string, ObservedFailure>();
	for (const f of input.failures) {
		if (!distinct.has(f.fingerprint)) {
			distinct.set(f.fingerprint, f);
		}
	}
	if (distinct.size === 0) {
		return { created: 0, updated: 0 };
	}

	const existing = await db.testFinding.findMany({
		where: {
			projectId: input.projectId,
			fingerprint: { in: [...distinct.keys()] },
		},
		select: { fingerprint: true, status: true },
	});
	const existingByPrint = new Map(existing.map((e) => [e.fingerprint, e]));

	let created = 0;
	let updated = 0;

	// Built as a list and sent as ONE batch rather than awaited per fingerprint.
	// A broad suite failing produces one of these per distinct fault, and a
	// sequential await each was a round trip each — on the ingest hot path, inside
	// an activity with a timeout. Still `upsert` rather than createMany + update:
	// two runs ingesting concurrently must not race on the
	// `@@unique([projectId, fingerprint])`, and only the upsert is atomic there.
	const writes: Prisma.PrismaPromise<unknown>[] = [];

	for (const [fingerprint, failure] of distinct) {
		const prior = existingByPrint.get(fingerprint);
		// PROMOTED stays promoted: its bug is already tracking this failure, and
		// reopening would report the same problem twice.
		const status =
			prior && prior.status !== "PROMOTED" ? "OPEN" : prior?.status;

		writes.push(
			db.testFinding.upsert({
				where: {
					projectId_fingerprint: {
						projectId: input.projectId,
						fingerprint,
					},
				},
				create: {
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.userId,
					fingerprint,
					testName: failure.testName,
					classname: failure.classname ?? null,
					failureMessage: failure.failureMessage ?? null,
					testCaseId: failure.testCaseId ?? null,
					lastPipelineRunId: input.pipelineRunId,
					firstSeenAt: observedAt,
					lastSeenAt: observedAt,
				},
				update: {
					occurrences: { increment: 1 },
					lastSeenAt: observedAt,
					lastPipelineRunId: input.pipelineRunId,
					// Refresh the text: the newest occurrence is the one a reader will
					// look at, and the fingerprint already guarantees it is the same
					// fault despite the exact string differing (paths, line numbers).
					failureMessage: failure.failureMessage ?? null,
					// The NAME is display text on the same terms, and was previously
					// written once and never again — so a finding whose name improved
					// (or was wrong) kept the original forever. That is not
					// hypothetical: agentic findings were created with a raw case cuid
					// as their name, and fixing the writer alone would only have
					// helped findings that did not exist yet.
					//
					// This branch was UNREACHABLE for agentic findings until
					// 2026-07-27. `fingerprintFinding` hashes the failure message
					// alongside the identity, and an agentic run's message is model
					// prose that differs every execution, so each re-run created a new
					// finding instead of updating this one. Fixed at the caller
					// (`run-lifecycle.ts`), which now fingerprints on the case id
					// alone. Recorded because an earlier version of this comment
					// asserted the opposite as settled fact, and that claim was used
					// to justify the change it describes.
					testName: failure.testName,
					testCaseId: failure.testCaseId ?? null,
					...(status ? { status } : {}),
				},
			}),
		);

		if (prior) {
			updated++;
		} else {
			created++;
		}
	}

	await db.$transaction(writes);

	return { created, updated };
}

/**
 * Close findings that did not appear in the latest run for a case.
 *
 * Without this a finding stays OPEN forever after the test is fixed, and the
 * list becomes a graveyard nobody trusts. Scoped to the fingerprints the caller
 * saw so an unrelated failure elsewhere is never resolved by accident, and
 * PROMOTED findings are left alone — their bug owns the lifecycle now.
 */
export async function resolveFindingsNotSeen(input: {
	projectId: string;
	/** Fingerprints observed in this run — everything else for these cases closes. */
	seenFingerprints: string[];
	/** Only consider findings attached to these cases. */
	testCaseIds: string[];
	resolvedAt?: Date;
}): Promise<number> {
	if (input.testCaseIds.length === 0) {
		return 0;
	}
	const { count } = await db.testFinding.updateMany({
		where: {
			projectId: input.projectId,
			testCaseId: { in: input.testCaseIds },
			status: "OPEN",
			fingerprint: { notIn: input.seenFingerprints },
			deletedAt: null,
		},
		data: { status: "RESOLVED", updatedAt: input.resolvedAt ?? new Date() },
	});
	return count;
}

/**
 * Turn a finding into a tracked BUG — the mocks' "Promote to bug".
 *
 * Deliberately a separate, human-triggered step rather than something ingestion
 * does: most findings are not worth a backlog item, and auto-filing them is how
 * a backlog stops being read. Idempotent — a finding already promoted returns
 * its existing story rather than opening a second one.
 */
export async function promoteFindingToBug(input: {
	projectId: string;
	findingId: string;
	createdById: string;
}): Promise<{ storyId: string; alreadyPromoted: boolean }> {
	// projectId in the WHERE is the tenant guard: a finding id from another
	// project matches nothing rather than being promoted into this one.
	const finding = await db.testFinding.findFirst({
		where: {
			id: input.findingId,
			projectId: input.projectId,
			deletedAt: null,
		},
		select: {
			id: true,
			fingerprint: true,
			testName: true,
			classname: true,
			failureMessage: true,
			occurrences: true,
			firstSeenAt: true,
			testCaseId: true,
			promotedStoryId: true,
		},
	});
	if (!finding) {
		throw new Error("Finding not found in this project");
	}
	if (finding.promotedStoryId) {
		return { storyId: finding.promotedStoryId, alreadyPromoted: true };
	}

	const lines = [
		`Automated test failing: ${finding.testName}`,
		finding.classname ? `In: ${finding.classname}` : null,
		"",
		`Seen ${finding.occurrences} time(s) since ${finding.firstSeenAt.toISOString().slice(0, 10)}.`,
		finding.failureMessage
			? `\nWhat CI reported:\n\n\`\`\`\n${finding.failureMessage.slice(0, 1500)}\n\`\`\``
			: null,
		"",
		`Promoted from QA finding \`${finding.fingerprint}\`.`,
	].filter((l): l is string => l !== null);

	const story = await createStory({
		projectId: input.projectId,
		createdById: input.createdById,
		kind: "BUG",
		source: "PIPELINE_FAILURE",
		originTestCaseId: finding.testCaseId ?? undefined,
		title: `Automated test failing: ${finding.testName}`,
		description: lines.join("\n"),
		priority: "P2_MEDIUM",
	});

	await db.testFinding.update({
		where: { id: finding.id },
		data: { status: "PROMOTED", promotedStoryId: story.id },
	});

	return { storyId: story.id, alreadyPromoted: false };
}

/** A finding as the QA findings list renders it. */
export interface FindingRow {
	id: string;
	fingerprint: string;
	testName: string;
	classname: string | null;
	failureMessage: string | null;
	status: string;
	occurrences: number;
	firstSeenAt: Date;
	lastSeenAt: Date;
	testCaseId: string | null;
	promotedStoryId: string | null;
	/** The AI analysis, null until someone asks for one. */
	suspectedCause: string | null;
	suspectedKind: string | null;
	analysedAt: Date | null;
	analysisModel: string | null;
	/**
	 * The diff that analysis reasoned over, or null when it had none.
	 *
	 * Typed as `unknown` rather than the concrete shape: it is a Json column, so
	 * the database cannot promise what is in it, and a lie at this boundary would
	 * be believed all the way to the JSX. The caller narrows it — see
	 * `parseAnalysisDiff`.
	 */
	analysisDiff: unknown;
}

/**
 * What the failure analysis was shown about the change under suspicion.
 *
 * Mirrors `ResolvedFailureDiff` in `@repo/api`, which owns the shape. Restated
 * here rather than imported because `@repo/database` must not depend on the API
 * layer — and asserted against it by a test in that package, so the two cannot
 * drift silently.
 *
 * A `type`, not an `interface`, and that is load-bearing: Prisma's
 * `InputJsonValue` requires an implicit index signature, which TypeScript grants
 * to object type aliases and withholds from interfaces. Declared as an interface
 * this fails to assign to the Json column, and the usual workaround is a cast
 * that would silence a real check on the way in.
 */
export type FindingAnalysisDiff = {
	commitRange: { baseSha: string; headSha: string };
	changedFiles: Array<{ path: string; reason: string }>;
	truncated: boolean;
};

/**
 * Narrow a stored `analysisDiff` to something safe to render.
 *
 * Every field is checked. The column is Json and rows predate the shape, so
 * "it was written by our own code" is not a guarantee that survives a migration,
 * a rollback or a hand-edited row — and the consumer is UI that would otherwise
 * throw on a missing `changedFiles`. Anything unrecognised degrades to null,
 * which renders as "no diff" rather than as an error.
 */
export function parseAnalysisDiff(raw: unknown): FindingAnalysisDiff | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const value = raw as Record<string, unknown>;
	const range = value.commitRange as Record<string, unknown> | undefined;
	if (
		!range ||
		typeof range.baseSha !== "string" ||
		typeof range.headSha !== "string"
	) {
		return null;
	}
	if (!Array.isArray(value.changedFiles)) {
		return null;
	}
	const changedFiles = value.changedFiles.flatMap((entry) => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const file = entry as Record<string, unknown>;
		return typeof file.path === "string" && typeof file.reason === "string"
			? [{ path: file.path, reason: file.reason }]
			: [];
	});
	// A range with no surviving files is not a diff worth showing: it would
	// render as a commit range that blames nothing.
	if (changedFiles.length === 0) {
		return null;
	}
	return {
		commitRange: { baseSha: range.baseSha, headSha: range.headSha },
		changedFiles,
		truncated: value.truncated === true,
	};
}

/** The columns the findings list returns. Shared so a projection cannot drift. */
const findingSelect = {
	id: true,
	fingerprint: true,
	testName: true,
	classname: true,
	failureMessage: true,
	status: true,
	occurrences: true,
	firstSeenAt: true,
	lastSeenAt: true,
	testCaseId: true,
	promotedStoryId: true,
	suspectedCause: true,
	suspectedKind: true,
	analysedAt: true,
	analysisModel: true,
	analysisDiff: true,
} as const;

/**
 * The evidence the analysis reasons over, plus the finding's own tenant owner.
 *
 * `organizationId` rides along so the caller resolves the org's prompt override
 * from a SERVER-side fact rather than a client-supplied id. It is the XOR owner
 * copied from the project at ingest, so it cannot disagree with the project the
 * permission check already passed.
 */
export interface FindingAnalysisSubject {
	id: string;
	testName: string;
	classname: string | null;
	failureMessage: string | null;
	occurrences: number;
	firstSeenAt: Date;
	lastSeenAt: Date;
	caseTitle: string | null;
	organizationId: string | null;
	/**
	 * The matched case's automation file path, when one is recorded. The
	 * strongest signal available for correlating a failure against a diff (spec
	 * §7.2): if the test's own spec file changed, that is nearly always the
	 * answer.
	 */
	specFilePath: string | null;
}

/**
 * Load one finding as analysis input. Returns null when it is not in this
 * project — `projectId` is in the WHERE, so a foreign id matches nothing rather
 * than being analysed into this tenant.
 */
export async function getFindingForAnalysis(input: {
	projectId: string;
	findingId: string;
}): Promise<FindingAnalysisSubject | null> {
	const row = await db.testFinding.findFirst({
		where: {
			id: input.findingId,
			projectId: input.projectId,
			deletedAt: null,
		},
		select: {
			id: true,
			testName: true,
			classname: true,
			failureMessage: true,
			occurrences: true,
			firstSeenAt: true,
			lastSeenAt: true,
			organizationId: true,
			// The matched case's title is real context for the model — "resets the
			// password" tells it what the test was for in a way the test's own
			// symbol name often does not.
			testCase: { select: { title: true, automationFilePath: true } },
		},
	});
	if (!row) {
		return null;
	}
	const { testCase, ...rest } = row;
	return {
		...rest,
		caseTitle: testCase?.title ?? null,
		specFilePath: testCase?.automationFilePath ?? null,
	};
}

/**
 * Store an analysis on a finding.
 *
 * Overwrites any previous one: the newest occurrence is the one worth reasoning
 * about, and a pile of stale hypotheses is worse than one current hypothesis.
 *
 * Deliberately touches ONLY the four analysis columns. It must not change
 * `status`, must not set `promotedStoryId`, and must not open anything — the
 * analysis is advisory and promotion stays a person's action (product ruling,
 * 2026-07-26). Written as an explicit `data` rather than a spread so that
 * remains true by construction if the input type ever grows.
 */
export async function setFindingAnalysis(input: {
	projectId: string;
	findingId: string;
	suspectedCause: string;
	suspectedKind: TestFailureKind;
	analysisModel: string | null;
	/**
	 * The diff this analysis saw, or null when it had none.
	 *
	 * REQUIRED, not optional, and always written. An optional field would let a
	 * caller re-analyse without it and leave the previous run's file list sitting
	 * under a brand-new cause — presenting a hypothesis as diff-correlated when
	 * it was not. Making the absence explicit forces every caller to say which
	 * happened.
	 */
	analysisDiff: FindingAnalysisDiff | null;
	analysedAt?: Date;
}): Promise<{ updated: boolean }> {
	const { count } = await db.testFinding.updateMany({
		// `deletedAt` matters as much here as in the read above. Without it a
		// finding soft-deleted between the read and this write still receives an
		// analysis — harmless today, and exactly the read/write asymmetry that
		// becomes a real bug the moment something starts acting on the columns.
		where: {
			id: input.findingId,
			projectId: input.projectId,
			deletedAt: null,
		},
		data: {
			suspectedCause: input.suspectedCause,
			suspectedKind: input.suspectedKind,
			analysisModel: input.analysisModel,
			analysedAt: input.analysedAt ?? new Date(),
			// `Prisma.DbNull`, not `null`: on a Json column a bare `null` is the
			// JSON value `null` rather than SQL NULL, and the two read back
			// differently. DbNull is what "there was no diff" must persist as, so
			// a later analysis with no diff genuinely clears the previous one.
			analysisDiff: input.analysisDiff ?? Prisma.DbNull,
		},
	});
	return { updated: count > 0 };
}

/**
 * This project's findings, worst-first: open before resolved, then most
 * recently seen. Scoped by projectId — the caller's project access is the
 * tenant boundary.
 *
 * `storyId` narrows to the failures that belong to ONE feature, for the feature
 * QA tab. It reaches through the matched case's work-item link, which means it
 * necessarily excludes findings with no `testCaseId` — a failure in a test
 * Fabric tracks no case for cannot be attributed to a feature at all. That is
 * the honest answer rather than a bug: those failures stay on the project-level
 * surface, which is the only place they can be triaged.
 */
export async function listFindings(input: {
	projectId: string;
	storyId?: string | null;
	status?: "OPEN" | "RESOLVED" | "PROMOTED" | "IGNORED";
	limit?: number;
}): Promise<FindingRow[]> {
	return db.testFinding.findMany({
		where: {
			projectId: input.projectId,
			deletedAt: null,
			...(input.status ? { status: input.status } : {}),
			...(input.storyId
				? {
						testCase: {
							deletedAt: null,
							workItemLinks: {
								some: { userStoryId: input.storyId },
							},
						},
					}
				: {}),
		},
		orderBy: [{ lastSeenAt: "desc" }],
		take: Math.min(input.limit ?? 50, 200),
		select: findingSelect,
	});
}

/**
 * Stop showing a finding, without pretending it was fixed.
 *
 * `RESOLVED` already exists and means "the test passed again" — ingestion writes
 * it. Dismissing is the human equivalent for a row that is noise: a known-flaky
 * test, a failure someone has decided not to chase. Kept as distinct states
 * because collapsing them would let a dismissal masquerade as a green test, and
 * the recurrence logic reopens a RESOLVED finding when the failure returns.
 *
 * A PROMOTED finding is refused rather than silently ignored: its bug is
 * tracking the failure, and hiding the finding would leave that bug orphaned
 * from the evidence that justified it.
 */
export async function dismissFinding(input: {
	projectId: string;
	findingId: string;
	dismissedAt?: Date;
}): Promise<{ findingId: string; alreadyDismissed: boolean }> {
	const finding = await db.testFinding.findFirst({
		// projectId in the WHERE is the tenant boundary — a foreign id matches
		// nothing rather than reading across projects.
		where: {
			id: input.findingId,
			projectId: input.projectId,
			deletedAt: null,
		},
		select: { id: true, status: true },
	});
	if (!finding) {
		throw new Error("Finding not found in this project");
	}
	if (finding.status === "PROMOTED") {
		throw new Error("A promoted finding cannot be dismissed");
	}
	if (finding.status === "IGNORED") {
		return { findingId: finding.id, alreadyDismissed: true };
	}

	await db.testFinding.update({
		where: { id: finding.id },
		data: { status: "IGNORED", updatedAt: input.dismissedAt ?? new Date() },
	});
	return { findingId: finding.id, alreadyDismissed: false };
}

export interface MergeFindingsResult {
	primaryId: string;
	/** How many rows were folded in — excludes ids that were already merged away. */
	mergedCount: number;
	/** The primary's occurrence total after folding. */
	occurrences: number;
}

/**
 * Fold duplicate findings into one.
 *
 * The need is historical rather than hypothetical: fingerprints are computed at
 * INSERT, so every row written before a fingerprint change keeps its old hash
 * forever. Agentic findings used to hash the failure message — model prose that
 * differs every execution — so one fault produced a new row per run, each
 * reading "Seen 1 time". The writer was fixed; the rows it already wrote cannot
 * be. This is how a person repairs them.
 *
 * Deliberately NOT a migration. A backfill would have to guess which historical
 * rows were the same fault, and guessing wrong silently destroys evidence. A
 * person looking at the list knows.
 *
 * The duplicates are soft-deleted rather than hard-deleted: `deletedAt` keeps
 * them out of every read while leaving the merge reversible in the database if
 * someone folds the wrong row. Their fingerprints stay put, so a recurrence
 * writing that fingerprint again lands on the soft-deleted row rather than
 * colliding with `@@unique([projectId, fingerprint])`.
 */
export async function mergeFindings(input: {
	projectId: string;
	primaryId: string;
	duplicateIds: string[];
	mergedAt?: Date;
}): Promise<MergeFindingsResult> {
	const mergedAt = input.mergedAt ?? new Date();
	const duplicateIds = [
		...new Set(input.duplicateIds.filter((id) => id !== input.primaryId)),
	];

	const rows = await db.testFinding.findMany({
		where: {
			projectId: input.projectId,
			id: { in: [input.primaryId, ...duplicateIds] },
			deletedAt: null,
		},
		select: {
			id: true,
			status: true,
			occurrences: true,
			firstSeenAt: true,
			lastSeenAt: true,
		},
	});

	const primary = rows.find((r) => r.id === input.primaryId);
	if (!primary) {
		throw new Error("Finding not found in this project");
	}
	const duplicates = rows.filter((r) => r.id !== input.primaryId);
	if (duplicates.length === 0) {
		return {
			primaryId: primary.id,
			mergedCount: 0,
			occurrences: primary.occurrences,
		};
	}
	// Refusing here rather than skipping: a caller who selected a promoted row
	// has misunderstood what they are about to do, and quietly dropping it from
	// the merge would leave them believing the list was tidier than it is.
	if (duplicates.some((d) => d.status === "PROMOTED")) {
		throw new Error("A promoted finding cannot be merged into another");
	}

	// The whole point of merging is that recurrence becomes readable, so the
	// counts have to add up and the window has to widen to cover every row.
	const occurrences =
		primary.occurrences + duplicates.reduce((n, d) => n + d.occurrences, 0);
	const firstSeenAt = duplicates.reduce(
		(earliest, d) => (d.firstSeenAt < earliest ? d.firstSeenAt : earliest),
		primary.firstSeenAt,
	);
	const lastSeenAt = duplicates.reduce(
		(latest, d) => (d.lastSeenAt > latest ? d.lastSeenAt : latest),
		primary.lastSeenAt,
	);

	await db.$transaction([
		db.testFinding.update({
			where: { id: primary.id },
			data: { occurrences, firstSeenAt, lastSeenAt, updatedAt: mergedAt },
		}),
		db.testFinding.updateMany({
			where: {
				id: { in: duplicates.map((d) => d.id) },
				projectId: input.projectId,
			},
			data: { deletedAt: mergedAt, updatedAt: mergedAt },
		}),
	]);

	return {
		primaryId: primary.id,
		mergedCount: duplicates.length,
		occurrences,
	};
}
