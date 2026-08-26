/**
 * Pull-request reviews — what Fabric read from a customer's PR, and what its
 * review lenses made of it.
 *
 * The read (phase 1) and the findings (phase 2) live in one module because they
 * are one lifecycle: a lens run only ever writes findings for a review that
 * exists, and re-running a lens replaces its own set. Splitting them would put
 * `replaceLensFindings` — which touches both tables in one transaction — in a
 * file that owns neither.
 *
 * Findings are their OWN model, not `TestFinding`. An earlier note in this file
 * claimed the opposite; it was wrong. `TestFinding` is a failing test: keyed on a
 * fingerprint from a test's identity, requiring a test name, and RESOLVED there
 * means "the test went green". A review observation like "AC 3 has no case
 * covering it" has none of those, by definition — the point is that there is no
 * test.
 */

import { createHash } from "node:crypto";
import { db } from "../../client";
import { projectTenant } from "./qa-settings";

/** The list row — deliberately without the diff, which can be megabytes. */
export interface PullRequestReviewSummary {
	id: string;
	provider: string;
	repoOwner: string;
	repoName: string;
	prNumber: number;
	title: string;
	authorLabel: string | null;
	headSha: string;
	prUrl: string | null;
	changedFiles: number;
	diffTruncated: boolean;
	status: string;
	failureText: string | null;
	/** Null until the QA lens has run. See the model's doc comment: this is how a
	 * reader tells "not analysed" from "analysed, found nothing". */
	qaAnalysedAt: Date | null;
	qaAnalysisModel: string | null;
	/** Null until the ARCHITECTURE lens has run. No model counterpart — that lens
	 * computes from Atlas's import graph rather than asking one. */
	architectureAnalysedAt: Date | null;
	/** The comment this review was posted as, when it has been. */
	postedCommentId: bigint | null;
	createdAt: Date;
}

const summarySelect = {
	id: true,
	provider: true,
	repoOwner: true,
	repoName: true,
	prNumber: true,
	title: true,
	authorLabel: true,
	headSha: true,
	prUrl: true,
	changedFiles: true,
	diffTruncated: true,
	status: true,
	failureText: true,
	qaAnalysedAt: true,
	qaAnalysisModel: true,
	architectureAnalysedAt: true,
	postedCommentId: true,
	createdAt: true,
} as const;

/** One lens observation, as the review sheet renders it. */
export interface PullRequestReviewFindingRow {
	id: string;
	lens: string;
	severity: string;
	title: string;
	detail: string;
	/** Null on findings stored before the lenses started supplying one. */
	recommendation: string | null;
	filePath: string | null;
	line: number | null;
	storyId: string | null;
	criterionRef: string | null;
	status: string;
	/** Why it was dismissed, when it was. Only INCORRECT is a false positive. */
	dismissalReason: string | null;
	promotedStoryId: string | null;
	model: string | null;
	createdAt: Date;
}

const findingSelect = {
	id: true,
	lens: true,
	severity: true,
	title: true,
	detail: true,
	recommendation: true,
	filePath: true,
	line: true,
	storyId: true,
	criterionRef: true,
	status: true,
	dismissalReason: true,
	promotedStoryId: true,
	model: true,
	createdAt: true,
} as const;

/**
 * Persist one read of a pull request.
 *
 * Upserts on the PR's identity INCLUDING the head commit: re-reading the same
 * commit replaces that read rather than accumulating duplicates, while a new
 * commit is a genuinely different review and gets its own row.
 *
 * Tenant columns come from the parent PROJECT, never the caller — the same rule
 * every other tenant-scoped write here follows, and the function does not accept
 * them so a caller cannot get it wrong.
 */
export async function recordPullRequestRead(input: {
	projectId: string;
	integrationId: string;
	provider: string;
	repoOwner: string;
	repoName: string;
	prNumber: number;
	title: string;
	authorLabel: string | null;
	headSha: string;
	baseSha: string;
	prUrl: string | null;
	diff: string | null;
	diffTruncated: boolean;
	changedFiles: number;
	status: "READ" | "FAILED";
	failureText: string | null;
	requestedById: string;
}): Promise<PullRequestReviewSummary> {
	const tenant = await projectTenant(input.projectId);

	const body = {
		title: input.title,
		authorLabel: input.authorLabel,
		baseSha: input.baseSha,
		prUrl: input.prUrl,
		diff: input.diff,
		diffTruncated: input.diffTruncated,
		changedFiles: input.changedFiles,
		status: input.status,
		failureText: input.failureText,
		requestedById: input.requestedById,
	};

	return db.pullRequestReview.upsert({
		where: {
			projectId_provider_repoOwner_repoName_prNumber_headSha: {
				projectId: input.projectId,
				provider: input.provider,
				repoOwner: input.repoOwner,
				repoName: input.repoName,
				prNumber: input.prNumber,
				headSha: input.headSha,
			},
		},
		update: body,
		create: {
			...body,
			projectId: input.projectId,
			integrationId: input.integrationId,
			provider: input.provider,
			repoOwner: input.repoOwner,
			repoName: input.repoName,
			prNumber: input.prNumber,
			headSha: input.headSha,
			userId: tenant.userId,
			organizationId: tenant.organizationId,
		},
		select: summarySelect,
	});
}

/**
 * A project's reviews, newest first.
 *
 * Bounded, and without the diff column: this list renders in a panel, and
 * loading every stored diff to show a list of titles is the read-path mistake
 * the QA surface already had to fix once.
 */
export async function listPullRequestReviews(input: {
	projectId: string;
	limit?: number;
}): Promise<PullRequestReviewSummary[]> {
	return db.pullRequestReview.findMany({
		where: { projectId: input.projectId },
		orderBy: { createdAt: "desc" },
		take: Math.min(Math.max(input.limit ?? 25, 1), 100),
		select: summarySelect,
	});
}

/**
 * One review including the diff Fabric read and every lens finding on it. Null
 * when it is not this project's.
 */
export async function getPullRequestReview(input: {
	id: string;
	projectId: string;
}): Promise<
	| (PullRequestReviewSummary & {
			diff: string | null;
			findings: PullRequestReviewFindingRow[];
	  })
	| null
> {
	const review = await db.pullRequestReview.findFirst({
		// projectId in the WHERE, not checked after: an id from another project
		// must read as absent rather than as forbidden.
		where: { id: input.id, projectId: input.projectId },
		select: {
			...summarySelect,
			diff: true,
			findings: {
				select: findingSelect,
				// Oldest first here; the severity ranking is applied below. See
				// `bySeverityThenAge` for why the database cannot do it.
				orderBy: { createdAt: "asc" },
			},
		},
	});
	if (review) {
		review.findings.sort(bySeverityThenAge);
	}
	return review;
}

/**
 * Severity sorts alphabetically as HIGH < LOW < MEDIUM, which is not the order a
 * reader wants. Ordering in code keeps the enum-free `severity` column (see the
 * model) without teaching the database a ranking it would then have to migrate.
 */
const SEVERITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function bySeverityThenAge(
	a: { severity: string; createdAt: Date },
	b: { severity: string; createdAt: Date },
): number {
	const rank =
		(SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
	return rank !== 0 ? rank : a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * Replace one lens's findings for one review.
 *
 * Delete-then-insert rather than an upsert, in a single transaction: a re-run
 * SUPERSEDES its previous opinion, and there is no stable identity to match a new
 * observation to an old one. Doing it transactionally is what stops a failed
 * insert leaving the review with no findings at all while its `qaAnalysedAt` says
 * it was analysed.
 *
 * Tenant columns come from the parent PROJECT, never the caller — the same rule
 * every other write here follows, and the function does not accept them.
 *
 * A person's ACCEPTED/DISMISSED judgements are discarded along with the rest.
 * That is deliberate: they were judgements about a previous run's wording over a
 * previous commit's diff, and silently carrying them onto new text would present
 * a verdict nobody actually gave.
 */
export async function replaceLensFindings(input: {
	reviewId: string;
	projectId: string;
	lens: string;
	model: string | null;
	analysedAt: Date;
	findings: Array<{
		severity: string;
		title: string;
		detail: string;
		/** What to change. Both lenses supply one; see the column's own comment. */
		recommendation: string;
		filePath: string | null;
		line: number | null;
		storyId: string | null;
		criterionRef: string | null;
	}>;
}): Promise<PullRequestReviewFindingRow[]> {
	const tenant = await projectTenant(input.projectId);

	return db.$transaction(async (tx) => {
		await tx.pullRequestReviewFinding.deleteMany({
			// projectId as well as reviewId: the caller resolved the review by
			// project, and repeating the scope here means a wrong reviewId cannot
			// delete another tenant's findings even if one leaked in.
			where: {
				reviewId: input.reviewId,
				projectId: input.projectId,
				lens: input.lens,
			},
		});

		if (input.findings.length > 0) {
			await tx.pullRequestReviewFinding.createMany({
				data: input.findings.map((f) => ({
					reviewId: input.reviewId,
					projectId: input.projectId,
					lens: input.lens,
					severity: f.severity,
					title: f.title,
					detail: f.detail,
					recommendation: f.recommendation,
					filePath: f.filePath,
					line: f.line,
					storyId: f.storyId,
					criterionRef: f.criterionRef,
					model: input.model,
					userId: tenant.userId,
					organizationId: tenant.organizationId,
				})),
			});
		}

		// Stamped inside the transaction so "analysed" and the findings it
		// produced can never disagree. An empty set with a timestamp is a real
		// result — the lens ran and found nothing.
		await tx.pullRequestReview.update({
			where: { id: input.reviewId },
			data:
				input.lens === "ARCHITECTURE"
					? { architectureAnalysedAt: input.analysedAt }
					: {
							qaAnalysedAt: input.analysedAt,
							qaAnalysisModel: input.model,
						},
		});

		return tx.pullRequestReviewFinding.findMany({
			where: {
				reviewId: input.reviewId,
				projectId: input.projectId,
				lens: input.lens,
			},
			select: findingSelect,
			orderBy: { createdAt: "asc" },
		});
	});
}

/**
 * The project's import graph, as edges between file paths.
 *
 * Read from the newest READY Atlas analysis for the project. Returns an EMPTY
 * array when there is no analysis — a project whose repository was never indexed
 * has no graph, which is a different thing from a graph with no cycles, and the
 * caller has to be able to say so rather than reporting "no problems found".
 *
 * Keys are mapped to file paths here rather than left as Atlas node keys: a
 * finding naming `src/a.ts → src/b.ts` is actionable, one naming
 * `mod:7f3a → mod:91bc` is not. Nodes with no `filePath` (directories,
 * capabilities) are dropped, because a cycle between directories is a summary of
 * the file cycles underneath it, not a separate fact.
 */
export async function getProjectImportGraph(input: {
	projectId: string;
}): Promise<{
	analysisId: string | null;
	edges: Array<{ from: string; to: string }>;
}> {
	const analysis = await db.atlasAnalysis.findFirst({
		where: { projectId: input.projectId, status: "READY" },
		orderBy: { updatedAt: "desc" },
		select: { id: true },
	});
	if (!analysis) {
		return { analysisId: null, edges: [] };
	}

	const [nodes, edges] = await Promise.all([
		db.atlasNode.findMany({
			where: {
				analysisId: analysis.id,
				mode: "TECHNICAL",
				filePath: { not: null },
			},
			select: { key: true, filePath: true },
		}),
		db.atlasEdge.findMany({
			where: {
				analysisId: analysis.id,
				mode: "TECHNICAL",
				// IMPORTS only. CONTAINS is the directory tree — every folder
				// "contains" its children, so including it would report the whole
				// repository as one enormous cycle.
				kind: "IMPORTS",
			},
			select: { sourceKey: true, targetKey: true },
		}),
	]);

	const pathByKey = new Map(
		nodes.flatMap((n) =>
			n.filePath ? [[n.key, n.filePath] as const] : [],
		),
	);
	const mapped: Array<{ from: string; to: string }> = [];
	for (const e of edges) {
		const from = pathByKey.get(e.sourceKey);
		const to = pathByKey.get(e.targetKey);
		if (from && to) {
			mapped.push({ from, to });
		}
	}
	return { analysisId: analysis.id, edges: mapped };
}

/** What the QA review lens is told about one of the project's features. */
export interface PrReviewFeatureContext {
	storyId: string;
	identifier: string;
	title: string;
	acceptanceCriteria: string | null;
	linkedCaseTitles: string[];
}

/**
 * The features the QA lens reasons against, with the case titles already
 * covering each one.
 *
 * TWO queries regardless of how many features come back — the page of stories,
 * then ONE `findMany` over the link table for every id on that page — the same
 * shape as `listFeatureCoverage`. A per-story read would be N+1 for no benefit.
 *
 * Ordered so the LEAST covered features come first, because the caller caps the
 * list before it reaches the model: dropping the best-covered features loses the
 * least, whereas an arbitrary slice could drop the untested ones the lens exists
 * to notice. Bugs are excluded — a bug is a report of broken behaviour, not a
 * specification a change can fail to cover.
 *
 * `UserStory` has no soft-delete column, so there is nothing to filter there; the
 * live-case filter on the link side is what keeps a deleted case out of the
 * titles.
 */
export async function listFeaturesForPrReview(input: {
	projectId: string;
	limit?: number;
}): Promise<PrReviewFeatureContext[]> {
	const take = Math.min(Math.max(input.limit ?? 40, 1), 200);

	// Rank BEFORE capping. The cap used to run against `createdAt desc` and the
	// coverage ordering was applied in memory afterwards, so a project with more
	// features than the limit had the least-covered ones discarded by the take —
	// precisely the features this lens exists to look at. The ordering is
	// load-bearing (see docs/qa/pr-review.md), so it has to decide the cap
	// rather than be applied after it.
	//
	// Counted in the database rather than by reading every link: the ranking
	// needs one number per feature, and only the capped set needs case titles.
	// The count is filtered to LIVE cases in this project, which is why it
	// cannot be an `orderBy` on the relation — Prisma orders on the unfiltered
	// count, and a deleted case would make an untested feature read as covered.
	const counts = await db.testCaseWorkItemLink.groupBy({
		by: ["userStoryId"],
		where: {
			testCase: { projectId: input.projectId, deletedAt: null },
			userStory: { projectId: input.projectId, kind: "FEATURE" },
		},
		_count: { _all: true },
	});
	const coverage = new Map(
		counts.map((row) => [row.userStoryId, row._count._all]),
	);

	// Two scalar columns for the project's features — enough to rank them, and
	// the only read that grows with the backlog.
	const features = await db.userStory.findMany({
		where: { projectId: input.projectId, kind: "FEATURE" },
		select: { id: true, createdAt: true },
		// Ordered even though the ranking below re-sorts: `Array.sort` is stable,
		// so features tied on BOTH coverage and `createdAt` — bulk-imported rows
		// share a timestamp — would otherwise keep whatever order Postgres
		// happened to return, and which of them land inside the cap could differ
		// between two calls. `id` is the tie-break that makes it decidable.
		orderBy: [{ createdAt: "desc" }, { id: "asc" }],
	});
	if (features.length === 0) {
		return [];
	}

	const ranked = features
		.sort((a, b) => {
			const byCoverage =
				(coverage.get(a.id) ?? 0) - (coverage.get(b.id) ?? 0);
			// Newest first among equally-covered features: the tie-break the
			// previous ordering gave, kept so the cap stays deterministic.
			return byCoverage !== 0
				? byCoverage
				: b.createdAt.getTime() - a.createdAt.getTime();
		})
		.slice(0, take)
		.map((s) => s.id);

	const [stories, links] = await Promise.all([
		db.userStory.findMany({
			where: { id: { in: ranked }, projectId: input.projectId },
			select: {
				id: true,
				identifier: true,
				title: true,
				acceptanceCriteria: true,
			},
		}),
		db.testCaseWorkItemLink.findMany({
			where: {
				userStoryId: { in: ranked },
				testCase: { projectId: input.projectId, deletedAt: null },
			},
			select: {
				userStoryId: true,
				testCase: { select: { title: true } },
			},
		}),
	]);

	const titles = new Map<string, string[]>();
	for (const link of links) {
		const list = titles.get(link.userStoryId) ?? [];
		list.push(link.testCase.title);
		titles.set(link.userStoryId, list);
	}

	const byId = new Map(stories.map((s) => [s.id, s]));
	return ranked.flatMap((id) => {
		const s = byId.get(id);
		return s
			? [
					{
						storyId: s.id,
						identifier: s.identifier,
						title: s.title,
						acceptanceCriteria: s.acceptanceCriteria,
						linkedCaseTitles: titles.get(s.id) ?? [],
					},
				]
			: [];
	});
}

/**
 * Record a person's judgement on one finding. Returns null when the finding is
 * not this project's, so the caller answers NOT_FOUND rather than pretending.
 *
 * DISMISSED is the signal a false-positive rate is measured from, which is why it
 * is a stored state and not a hide.
 */
export async function setPullRequestReviewFindingStatus(input: {
	id: string;
	projectId: string;
	status: "OPEN" | "ACCEPTED" | "DISMISSED";
	/** Only meaningful on DISMISSED; cleared otherwise. */
	dismissalReason?: PrReviewDismissalReason | null;
	judgedById?: string | null;
}): Promise<PullRequestReviewFindingRow | null> {
	const reason =
		input.status === "DISMISSED" ? (input.dismissalReason ?? null) : null;

	const { count } = await db.pullRequestReviewFinding.updateMany({
		where: { id: input.id, projectId: input.projectId },
		data: { status: input.status, dismissalReason: reason },
	});
	if (count === 0) {
		return null;
	}

	const finding = await db.pullRequestReviewFinding.findFirst({
		where: { id: input.id, projectId: input.projectId },
		select: findingSelect,
	});

	// Also into the ledger, which is what the accuracy figure reads. The finding
	// row is deleted whenever its lens is re-run, so a verdict recorded only
	// here would vanish with it.
	if (finding) {
		await recordPrReviewJudgement({
			projectId: input.projectId,
			lens: finding.lens,
			filePath: finding.filePath,
			title: finding.title,
			status: input.status,
			dismissalReason: reason,
			judgedById: input.judgedById ?? null,
		});
	}

	return finding;
}

/**
 * How often each lens gets judged wrong, per project.
 *
 * The feature carries a stated target — under 20% false positives, measured by
 * developer feedback — and until now nothing computed it. The feedback was
 * already being collected: Accept and Dismiss are stored states rather than a
 * hide, precisely so this number exists. It just had no reader.
 *
 * Judged findings only. An OPEN finding is one nobody has ruled on, and counting
 * it as correct would flatter the lens while counting it as wrong would damn it;
 * both are opinions the data does not hold. That makes `judged` the honest
 * denominator, and it is returned alongside the rate so a reader can see how
 * much evidence the percentage rests on — 1 dismissal out of 2 is not a 50%
 * false-positive rate, it is two data points.
 */
/**
 * The success criterion this feature is measured against: a false-positive rate
 * under 20%.
 */
export const PR_REVIEW_FALSE_POSITIVE_TARGET = 0.2;

/** The reasons a person can give for dismissing a finding. */
export const PR_REVIEW_DISMISSAL_REASONS = [
	"INCORRECT",
	"WONT_FIX",
	"OUT_OF_SCOPE",
	"ALREADY_COVERED",
] as const;

export type PrReviewDismissalReason =
	(typeof PR_REVIEW_DISMISSAL_REASONS)[number];

/**
 * Identifies the OBSERVATION rather than the row it was reported on, so a
 * verdict survives the lens re-run that replaces the row.
 *
 * Must stay byte-identical to the `md5(...)` expression in
 * `20260819090000_pr_review_judgement_ledger`, which backfilled the judgements
 * that already existed. chr(31) is the unit separator — it cannot occur in a
 * path or a title, and unlike NUL it is storable in Postgres text.
 */
export function prReviewFindingFingerprint(input: {
	lens: string;
	filePath: string | null;
	title: string;
}): string {
	return createHash("md5")
		.update(
			`${input.lens}\u001f${input.filePath ?? ""}\u001f${input.title}`,
		)
		.digest("hex");
}

export interface PrReviewLensStats {
	lens: string;
	/** Findings somebody ruled on. An OPEN one is not a data point. */
	judged: number;
	dismissed: number;
	/** Dismissed as INCORRECT — the lens was wrong. */
	falsePositives: number;
	/** Dismissed / judged, 0-1. NOT the false-positive rate. */
	dismissedRate: number | null;
	/**
	 * False positives / judged, 0-1. This is the figure the feature's success
	 * criterion names. Null until something has been judged.
	 */
	falsePositiveRate: number | null;
	/** Whether `falsePositiveRate` clears the target. Null when unmeasured. */
	meetsTarget: boolean | null;
	/**
	 * Judgements recorded before dismissal reasons existed, or dismissed
	 * without one. They count in `judged` but cannot count in `falsePositives`,
	 * so a reader can tell a low rate from an unclassified one.
	 */
	unclassifiedDismissals: number;
}

/**
 * How each lens has been judged, read from the judgement LEDGER rather than from
 * the findings.
 *
 * It used to read the findings, and a lens re-run deletes those — so re-running
 * the free architecture lens erased the published number. The ledger keeps a
 * verdict keyed by the observation it was given on.
 */
export async function getPrReviewLensStats(input: {
	projectId: string;
}): Promise<PrReviewLensStats[]> {
	const rows = await db.prReviewJudgement.groupBy({
		by: ["lens", "status", "dismissalReason"],
		where: { projectId: input.projectId },
		_count: { _all: true },
	});

	const byLens = new Map<
		string,
		{ judged: number; dismissed: number; incorrect: number; vague: number }
	>();
	for (const row of rows) {
		const entry = byLens.get(row.lens) ?? {
			judged: 0,
			dismissed: 0,
			incorrect: 0,
			vague: 0,
		};
		entry.judged += row._count._all;
		if (row.status === "DISMISSED") {
			entry.dismissed += row._count._all;
			if (row.dismissalReason === "INCORRECT") {
				entry.incorrect += row._count._all;
			} else if (!row.dismissalReason) {
				entry.vague += row._count._all;
			}
		}
		byLens.set(row.lens, entry);
	}

	return [...byLens.entries()]
		.map(([lens, e]) => {
			const falsePositiveRate =
				e.judged > 0 ? e.incorrect / e.judged : null;
			return {
				lens,
				judged: e.judged,
				dismissed: e.dismissed,
				falsePositives: e.incorrect,
				dismissedRate: e.judged > 0 ? e.dismissed / e.judged : null,
				falsePositiveRate,
				meetsTarget:
					falsePositiveRate === null
						? null
						: falsePositiveRate < PR_REVIEW_FALSE_POSITIVE_TARGET,
				unclassifiedDismissals: e.vague,
			};
		})
		.sort((a, b) => a.lens.localeCompare(b.lens));
}

/**
 * Record a verdict in the ledger, so it survives the lens re-run that replaces
 * the finding it was given on. Upserted on the observation's fingerprint:
 * re-judging the same observation replaces the verdict rather than adding a
 * second data point.
 */
export async function recordPrReviewJudgement(input: {
	projectId: string;
	lens: string;
	filePath: string | null;
	title: string;
	status: "OPEN" | "ACCEPTED" | "DISMISSED";
	dismissalReason: PrReviewDismissalReason | null;
	judgedById: string | null;
}): Promise<void> {
	const fingerprint = prReviewFindingFingerprint(input);

	// Back to OPEN is a withdrawn verdict, not a new one. Leaving the row would
	// keep counting a judgement nobody now stands behind.
	if (input.status === "OPEN") {
		await db.prReviewJudgement.deleteMany({
			where: {
				projectId: input.projectId,
				lens: input.lens,
				fingerprint,
			},
		});
		return;
	}

	const tenant = await projectTenant(input.projectId);
	await db.prReviewJudgement.upsert({
		where: {
			projectId_lens_fingerprint: {
				projectId: input.projectId,
				lens: input.lens,
				fingerprint,
			},
		},
		create: {
			projectId: input.projectId,
			lens: input.lens,
			fingerprint,
			status: input.status,
			dismissalReason: input.dismissalReason,
			judgedById: input.judgedById,
			userId: tenant.userId,
			organizationId: tenant.organizationId,
		},
		update: {
			status: input.status,
			dismissalReason: input.dismissalReason,
			judgedById: input.judgedById,
		},
	});
}

/**
 * One review with what posting a comment back to the code host needs: the
 * repository it came from, the credential it was read through, and its findings.
 *
 * Separate from {@link getPullRequestReview} because the shapes differ in the one
 * way that matters: this returns `integrationId`, and the sheet's read path
 * deliberately does not. A review is posted back through the SAME connection it
 * was read through, so a caller cannot name a different repository's credential.
 */
export async function getPullRequestReviewForPosting(input: {
	id: string;
	projectId: string;
}): Promise<{
	id: string;
	provider: string;
	repoOwner: string;
	repoName: string;
	prNumber: number;
	integrationId: string;
	organizationId: string | null;
	/** The comment a previous run posted, when one was recorded. */
	postedCommentId: bigint | null;
	/**
	 * Null means the lens never ran; a timestamp with no findings means it ran
	 * and found nothing. The comment says which, so these travel with the row.
	 */
	qaAnalysedAt: Date | null;
	architectureAnalysedAt: Date | null;
	findings: PullRequestReviewFindingRow[];
} | null> {
	const review = await db.pullRequestReview.findFirst({
		where: { id: input.id, projectId: input.projectId },
		select: {
			id: true,
			provider: true,
			repoOwner: true,
			repoName: true,
			prNumber: true,
			integrationId: true,
			organizationId: true,
			postedCommentId: true,
			qaAnalysedAt: true,
			architectureAnalysedAt: true,
			findings: {
				select: findingSelect,
				// Oldest first here; ranked by severity below. This ordering
				// reaches the customer's pull request, so getting it wrong shows
				// LOW above MEDIUM in somebody else's repository.
				orderBy: { createdAt: "asc" },
			},
		},
	});
	if (review) {
		review.findings.sort(bySeverityThenAge);
	}
	return review;
}

/**
 * The comment already posted for this PULL REQUEST, from any earlier review of
 * it.
 *
 * A review row is keyed by head commit, so every push makes a new one with no
 * `postedCommentId`, and a per-review lookup therefore concluded "never posted"
 * on the second push and added a second comment. The comment belongs to the
 * pull request, not to one commit's review of it.
 *
 * Newest first, and the current review is excluded so this only ever answers
 * about a PREVIOUS one.
 */
export async function findPostedCommentForPullRequest(input: {
	projectId: string;
	provider: string;
	repoOwner: string;
	repoName: string;
	prNumber: number;
	excludeReviewId: string;
}): Promise<number | null> {
	const previous = await db.pullRequestReview.findFirst({
		where: {
			projectId: input.projectId,
			provider: input.provider,
			repoOwner: input.repoOwner,
			repoName: input.repoName,
			prNumber: input.prNumber,
			id: { not: input.excludeReviewId },
			postedCommentId: { not: null },
		},
		orderBy: { createdAt: "desc" },
		select: { postedCommentId: true },
	});
	return previous?.postedCommentId == null
		? null
		: Number(previous.postedCommentId);
}

/**
 * Remember which GitHub comment a review was posted as.
 *
 * Scoped by projectId as well as id, like every other write here: the caller
 * resolved the review by project, and repeating the scope means a wrong id
 * cannot touch another tenant's row even if one leaked in.
 */
export async function setPullRequestReviewPostedComment(input: {
	id: string;
	projectId: string;
	commentId: number;
}): Promise<void> {
	await db.pullRequestReview.updateMany({
		where: { id: input.id, projectId: input.projectId },
		data: { postedCommentId: BigInt(input.commentId) },
	});
}
