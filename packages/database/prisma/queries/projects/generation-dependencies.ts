import {
	DOCUMENT_TIERS,
	isDocumentAvailable,
} from "../../../src/document-dependency-graph";
import {
	GENERATION_DEPENDENCY_CATEGORIES,
	type GenerationDependencyCategory,
} from "../../../src/generation-dependency-categories";
import { db, type ProjectDocumentType } from "../../client";

/**
 * One answer to "is anything this document generation needs still in flight,
 * and did any of it fail in a way waiting will never fix?" (Fizzy #2199).
 *
 * The queue workflow polls this between its dispatch and its first model call,
 * so the answer crosses a Temporal activity boundary and has to survive
 * `JSON.stringify` unchanged: no `Set`, no `Map`, no `Date` anywhere in the
 * return type. Pinned by `__tests__/generation-dependencies.test.ts`.
 */

/**
 * The queue-explanation vocabulary lives in `src/generation-dependency-categories`
 * — client-safe, so the card that renders a wait shares the union with the probe
 * that produces it rather than re-declaring six strings that can drift apart.
 */

/** One bucket of dependency work: what kind, and how many of it. */
export type GenerationDependencyEntry = {
	category: GenerationDependencyCategory;
	count: number;
};

export type GenerationDependencies = {
	/**
	 * `failed` outranks `waiting`: once a required input is gone for good,
	 * continuing to wait on the rest only delays a refusal the caller has
	 * already earned.
	 */
	verdict: "clear" | "waiting" | "failed";
	/** Work that is running now. Empty means nothing to wait for. */
	outstanding: GenerationDependencyEntry[];
	/** Required inputs that will never arrive. Empty means nothing is lost. */
	failed: GenerationDependencyEntry[];
};

export type ResolveGenerationDependenciesArgs = {
	projectId: string;
	organizationId: string | null;
	/**
	 * A `ProjectDocumentType`, typed as `string` for the same reason
	 * `DOCUMENT_TIERS` keys on one: every caller holds a plain string read off a
	 * row or a request body, and narrowing here would only push an `as` cast out
	 * to each of them.
	 */
	documentType: string;
	/**
	 * The document this run is generating. Its row already exists at `QUEUED`
	 * when the probe first runs, so without this it is visible to the probe as
	 * project state — work to wait on rather than the reason for the wait.
	 */
	excludeDocumentId?: string | null;
	/**
	 * The source this run supplied for itself. `create-document` writes the
	 * `ProjectContext` at `PENDING` and fires embedding IN PARALLEL with the
	 * dispatch, so every create-with-pasted-text request would otherwise queue
	 * behind its own embedding — and be refused outright if that embedding
	 * failed, even though the pasted text reaches the generator directly and
	 * never needed the index at all.
	 */
	excludeContextId?: string | null;
	/**
	 * When THIS attempt was requested — the `generationStartedAt` the queue write
	 * returned — as a `Date` or as the ISO-8601 string the workflow carries.
	 *
	 * It exists to scope the FAILED arms below to this run. Optional, because a
	 * dispatcher that predates it must still get an answer; when it is absent the
	 * failed arms fall back to the same staleness window the outstanding arms use
	 * — coarser than the truth, but still bounded, which is the whole point.
	 */
	generationStartedAt?: Date | string | null;
};

/**
 * Background-job kinds that ingest a conversation into the project's context.
 * `SLACK_BACKFILL` is here beside the live monitors because it is the same
 * work: history arriving after the fact still changes what the generator reads.
 */
const MONITOR_JOB_KINDS = [
	"TEAMS_CHANNEL_MONITOR",
	"TEAMS_CHAT_MONITOR",
	"SLACK_CHANNEL_MONITOR",
	"SLACK_BACKFILL",
] as const;

/**
 * The project does not exist in the organization the run was authorized under.
 *
 * A named class rather than a bare `Error` because of where this is thrown
 * from: the probe runs inside a Temporal activity with a retry budget, and this
 * condition is permanent — no number of attempts makes a project reappear in an
 * organization it is not in, so retrying it only burns the budget and delays
 * the refusal the run has already earned. Its sibling
 * `assertRequesterMayGenerate` answers the identical condition with a
 * non-retryable failure; this is the same answer, expressed from a package that
 * cannot say it directly.
 *
 * `@repo/database` must not depend on `@temporalio/*` — the query layer is
 * imported by the web app and the API server, neither of which should drag a
 * worker SDK in behind a thrown error — so the classification travels as a type
 * instead. **The activity wrapper owns the marking**:
 * `probeGenerationDependencies` is responsible for turning this into a
 * non-retryable `ApplicationFailure`.
 */
export class GenerationDependencyProjectNotFoundError extends Error {
	/**
	 * Structural discriminant beside the class, for a classifier that cannot
	 * use `instanceof`: a worker holding a second copy of this module, or a
	 * boundary the error crossed serialized, still sees this flag.
	 */
	readonly nonRetryable = true;

	constructor(
		readonly projectId: string,
		readonly organizationId: string | null,
	) {
		// Wording preserved verbatim from the plain Error this replaced — the
		// message is what an operator greps for in the activity's failure.
		super(
			`Project ${projectId} was not found in the requested organization`,
		);
		this.name = "GenerationDependencyProjectNotFoundError";
	}
}

/** A document type already on the project satisfies a prerequisite. */
const SATISFYING_DOCUMENT_STATUS = "COMPLETE";

/** Statuses in which a sibling document is on its way to satisfying one. */
const IN_FLIGHT_DOCUMENT_STATUSES = ["QUEUED", "GENERATING"] as const;

/**
 * How long an in-flight ingestion row may go without a write before this probe
 * stops treating it as something to wait for.
 *
 * Deliberately the SAME number, and the same per-deployment override, as the
 * stale-generation watchdog's ceiling — see
 * `packages/temporal/src/activities/document-generation-watchdog-activities.ts`.
 * Both answer "is this in-flight thing still plausibly alive?", and two answers
 * that may drift apart is one answer too many: a project could sit blocked on a
 * row the watchdog has already given up on.
 *
 * Generous on purpose, and it can afford to be, because every row the
 * outstanding arms read is touched by its OWN progress: a code index writes
 * `indexedFileCount` per embed batch, a background job bumps `heartbeatAt` on
 * every step. So this bounds SILENCE, not duration — an index that legitimately
 * runs for hours keeps resetting the clock and is never called stale, while one
 * whose worker died goes quiet immediately.
 */
const DEFAULT_DEPENDENCY_STALE_MINUTES = 30;

/**
 * Read at call time rather than at import, so a worker that reads its
 * environment after this module loads still sees the override, and a test can
 * set one without re-importing.
 */
function resolveDependencyStaleMinutes(): number {
	const configured = Number.parseInt(
		process.env.FABRIC_DOCUMENT_GENERATION_STALE_MINUTES ?? "",
		10,
	);
	return Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_DEPENDENCY_STALE_MINUTES;
}

/**
 * The attempt identity arrives as a `Date` from an in-process caller and as an
 * ISO-8601 string from the workflow, whose payload converter does not preserve
 * `Date`. An unparseable value is treated as absent rather than as epoch zero,
 * which would restore the unbounded read this bound exists to remove.
 */
function toCutoffDate(value: Date | string | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function emptyTally(): Record<GenerationDependencyCategory, number> {
	return {
		codebaseIndexing: 0,
		sourceExtraction: 0,
		linkedSiteCrawl: 0,
		securityScan: 0,
		monitorIngestion: 0,
		prerequisiteDocument: 0,
	};
}

/** Fixed category order in, fixed entry order out — the answer is compared. */
function toEntries(
	tally: Record<GenerationDependencyCategory, number>,
): GenerationDependencyEntry[] {
	return GENERATION_DEPENDENCY_CATEGORIES.filter(
		(category) => tally[category] > 0,
	).map((category) => ({ category, count: tally[category] }));
}

/**
 * Probe every dependency a document generation can be waiting on, in one batch.
 *
 * ## What counts as outstanding
 *
 * Only rows that describe work happening NOW. A source with no rows at all is
 * absent, not outstanding — a project that never connected a repository has no
 * `ProjectCodeIndex` and no indexing job, so it contributes nothing here
 * without a single branch spent on saying so. That property is why the reads
 * below are all counts over in-flight predicates rather than "is this source
 * configured, and if so is it done".
 *
 * A dependency that failed one attempt but is still being retried is
 * outstanding, not failed, and that also falls out of the row rather than a
 * rule: a retrying extraction sits at `PENDING`/`EXTRACTING` with its last
 * error recorded beside it, and a Temporal-retried job stays `RUNNING`. Only a
 * status the writer stamps when it gives up reads as failed.
 *
 * Outstanding is also bounded in TIME. A status alone says a row was in flight
 * once, not that anything is still working on it, and this repository has a
 * documented history of ingestion rows left mid-flight by a crashed worker — a
 * `urlActiveWorkflowId` a dead crawl never cleared, a `PENDING` extraction
 * nobody picked up. Counted unbounded, one of those parks every generation in
 * the project until Temporal's own history limit ends the run, which is days.
 * So a row counts as outstanding only while its last write is inside
 * {@link DEFAULT_DEPENDENCY_STALE_MINUTES}; past that, the generation stops
 * waiting and runs against what the project actually has, which is a far better
 * outcome than an indefinite wait on work that is never going to finish.
 *
 * ## What counts as failed
 *
 * A category is REQUIRED — able to refuse the run rather than merely delay it —
 * when its failure means an input the generator would have read never arrived
 * at all. When a failure only leaves the previous data in place, the generation
 * still has something to read and must not be refused.
 *
 * Every required category is ALSO scoped to this run. The arm exists for one
 * narrow case: an input that died while this request was waiting on it, where
 * continuing to wait only delays a refusal already earned. A historical failure
 * is not that. Extraction failures are ordinary — a bad PDF, a dead link, a
 * source since deleted — and nothing cleans them up, so counting them
 * project-wide and unbounded meant a single row that failed months ago refused
 * EVERY generation in that project, permanently. The failed arms therefore read
 * only rows written since this attempt was requested:
 *
 *   - `sourceExtraction` is required. `FAILED` is stamped only on a row that
 *     never finished extracting; a source that extracted and later failed to
 *     index keeps `COMPLETED` and records the error beside it (see
 *     `buildIndexingFailureUpdate` in `contexts.ts`), so it never reaches here.
 *   - `codebaseIndexing` is required only with `lastFullIndexAt` still null. A
 *     repository that indexed once and failed a refresh still has an index to
 *     search; refusing on that would make one bad refresh block generation on a
 *     project whose codebase is right there.
 *   - `prerequisiteDocument` is required only when nothing satisfies the type
 *     and nothing is on its way to — a failed PRD beside a completed PROPOSAL
 *     blocks nothing, because either satisfies tier 2. It carries the same
 *     cutoff for the same reason: a PRD that failed months ago is not this
 *     run's problem, and left unscoped it refused every ARCHITECTURE,
 *     TECHNICAL_SPEC and API_SPEC the project would ever ask for. Dropping the
 *     old row leaves the tier simply unsatisfied, which is already the honest
 *     answer — nothing is coming, so the generator writes from context alone.
 *   - `linkedSiteCrawl`, `securityScan` and `monitorIngestion` are never
 *     required. A crawl, a scan and a monitor poll are refresh work over data
 *     that is already on the project; a failed one is worth waiting through,
 *     never worth refusing a document over. (The crawl has no failure state of
 *     its own to read in any case — a crawl that dies clears its workflow id
 *     and leaves the outcome on the context row, where `sourceExtraction`
 *     already reads it.)
 */
export async function resolveGenerationDependencies({
	projectId,
	organizationId,
	documentType,
	excludeDocumentId,
	excludeContextId,
	generationStartedAt,
}: ResolveGenerationDependenciesArgs): Promise<GenerationDependencies> {
	const prerequisites = DOCUMENT_TIERS[documentType]?.prerequisites ?? [];

	// Two cutoffs, because the two arms ask different questions of the same rows.
	//
	// `liveCutoff` bounds OUTSTANDING: a row whose last write is older than this
	// is not plausibly still being worked on, and a generation must not park
	// behind a worker that died.
	//
	// `failureCutoff` bounds FAILED, which refuses the run outright, so it is
	// tighter: only a failure recorded since this attempt was requested is this
	// run's problem. With no attempt identity to scope by it degrades to
	// `liveCutoff` — coarser than the truth but still bounded, which is what
	// stops one ancient row refusing the project forever.
	const liveCutoff = new Date(
		Date.now() - resolveDependencyStaleMinutes() * 60_000,
	);
	const failureCutoff = toCutoffDate(generationStartedAt) ?? liveCutoff;

	// `updatedAt` is the freshness column on every table here but one, and it is
	// the one the schema can defend: Prisma stamps it on every write to the row,
	// so it is exactly "when did anything last happen to this piece of work". A
	// failure stamps it when the writer records the terminal status; an in-flight
	// row stamps it on each progress write. (`BackgroundJob` is the exception —
	// it carries a purpose-built `heartbeatAt`, and the read below uses it.)
	//
	// The one imprecision: an unrelated edit to a long-failed source — renaming
	// it, say — refreshes its `updatedAt`, so one attempt can read a historical
	// failure as current. It self-heals rather than sticking, because the next
	// attempt carries a later `generationStartedAt` and the row falls back out of
	// range; the old behaviour had no such exit.
	//
	// One context row can be excluded from every context read; both reads share
	// the clause so the run's own source is invisible to the probe, not merely
	// discounted in one of the two places it shows up.
	const contextScope = {
		projectId,
		...(excludeContextId ? { id: { not: excludeContextId } } : {}),
	};

	const [
		project,
		extractionGroups,
		crawlingContextCount,
		codeIndexGroups,
		runningJobGroups,
		scanCount,
		prerequisiteDocuments,
	] = await Promise.all([
		// Fail-closed scope. Every read below is keyed on `projectId` alone, so
		// this is the one that decides whether the caller may have an answer at
		// all — a project the organization does not own yields no verdict rather
		// than a clear one.
		db.project.findFirst({
			where: { id: projectId, organizationId },
			select: { id: true },
		}),
		// PENDING/EXTRACTING are in flight; FAILED is a source that never
		// produced content. Grouping keeps all three in one round trip and lets
		// Postgres do the counting, which matters because a long-lived project
		// accumulates failed rows without bound — and is the same reason the FAILED
		// arm carries the tighter cutoff: read unbounded, those accumulated rows
		// refuse every generation the project will ever ask for.
		db.projectContext.groupBy({
			by: ["extractionStatus"],
			where: {
				...contextScope,
				OR: [
					{
						extractionStatus: { in: ["PENDING", "EXTRACTING"] },
						updatedAt: { gte: liveCutoff },
					},
					{
						extractionStatus: "FAILED",
						updatedAt: { gte: failureCutoff },
					},
				],
			},
			_count: { _all: true },
		}),
		// The crawl's only live signal: the workflow id is written when the crawl
		// starts and cleared when it finalizes, whatever the outcome. "Whatever the
		// outcome" is precisely what a crashed crawl never gets to do, which is why
		// this arm needs the freshness bound most: a workflow id nobody is left to
		// clear is otherwise a permanent wait.
		db.projectContext.count({
			where: {
				...contextScope,
				urlActiveWorkflowId: { not: null },
				updatedAt: { gte: liveCutoff },
			},
		}),
		// The OR is what makes the grouping legible: a FAILED row only enters the
		// result set when it has never fully indexed, so `status` alone separates
		// in-flight from required-and-gone once the rows come back. Bounding the
		// in-flight arm by silence is safe here because the embed loop writes
		// `indexedFileCount` on every batch — a long index is a NOISY row, so the
		// tens of minutes one legitimately takes never reads as stale.
		db.projectCodeIndex.groupBy({
			by: ["status"],
			where: {
				projectId,
				OR: [
					{
						status: { in: ["PENDING", "INDEXING"] },
						updatedAt: { gte: liveCutoff },
					},
					{
						status: "FAILED",
						lastFullIndexAt: null,
						updatedAt: { gte: failureCutoff },
					},
				],
			},
			_count: { _all: true },
		}),
		// CODE_INDEXING is here as well as in `ProjectCodeIndex` above, and it
		// has to be: the index row is written INSIDE the indexing workflow,
		// seconds after the trigger returns. Between "connect a repository" and
		// "the row appears" there is nothing else to see, and that window is
		// precisely the one this feature exists for — a generation dispatched in
		// it would otherwise read clear and run against an empty index.
		//
		// `heartbeatAt`, not `updatedAt`, on this one: the column exists precisely
		// to say a worker is still alive, and `failStaleBackgroundJobs` already
		// fails RUNNING rows whose heartbeat goes cold. Reading the same signal here
		// means a generation stops waiting on a dead job at the same moment the
		// background-job watchdog gives up on it, instead of after it.
		db.backgroundJob.groupBy({
			by: ["kind"],
			where: {
				projectId,
				status: "RUNNING",
				kind: { in: ["CODE_INDEXING", ...MONITOR_JOB_KINDS] },
				heartbeatAt: { gte: liveCutoff },
			},
			_count: { _all: true },
		}),
		// A scan writes its row at PENDING and next touches it to finish, so an
		// abandoned one stays PENDING forever with nothing left to close it. Stale
		// here means the generation runs against the findings the project already
		// has — a scan is refresh work, never a required input, so proceeding
		// without the newest results costs far less than an unbounded wait.
		db.projectScan.count({
			where: {
				projectId,
				status: { in: ["PENDING", "RUNNING"] },
				updatedAt: { gte: liveCutoff },
			},
		}),
		// Only types that can satisfy THIS document. An empty prerequisite list
		// makes this an `in: []`, which matches nothing — tier 1 asks the
		// database for no rows rather than asking and discarding them.
		//
		// The OR scopes the FAILED half to this attempt, and only that half: a
		// COMPLETE row satisfies the tier however old it is, and a QUEUED or
		// GENERATING sibling is work on the way whenever it started. Only the
		// status that can REFUSE the run needs an age, and a prerequisite that
		// failed before this request was even made is not something this run
		// waited on. Dropped here, the tier simply reads unsatisfied — the
		// answer the generator has always been allowed to act on.
		db.projectDocument.findMany({
			where: {
				projectId,
				isActive: true,
				type: { in: prerequisites as ProjectDocumentType[] },
				...(excludeDocumentId
					? { id: { not: excludeDocumentId } }
					: {}),
				OR: [
					{ status: { not: "FAILED" } },
					{ status: "FAILED", updatedAt: { gte: failureCutoff } },
				],
			},
			select: { type: true, status: true },
		}),
	]);

	if (!project) {
		throw new GenerationDependencyProjectNotFoundError(
			projectId,
			organizationId,
		);
	}

	const outstanding = emptyTally();
	const failed = emptyTally();

	for (const group of extractionGroups) {
		if (group.extractionStatus === "FAILED") {
			failed.sourceExtraction += group._count._all;
		} else {
			outstanding.sourceExtraction += group._count._all;
		}
	}

	outstanding.linkedSiteCrawl = crawlingContextCount;
	outstanding.securityScan = scanCount;

	let indexingRowCount = 0;
	for (const group of codeIndexGroups) {
		if (group.status === "FAILED") {
			failed.codebaseIndexing += group._count._all;
		} else {
			indexingRowCount += group._count._all;
		}
	}

	let indexingJobCount = 0;
	for (const group of runningJobGroups) {
		if (group.kind === "CODE_INDEXING") {
			indexingJobCount += group._count._all;
		} else {
			outstanding.monitorIngestion += group._count._all;
		}
	}

	// The job row and the index row are the same run seen from two places, so
	// the larger of the two is the number of repositories being indexed. Summing
	// them would report two waits for one repository the moment the index row
	// catches up with the job that writes it.
	outstanding.codebaseIndexing = Math.max(indexingRowCount, indexingJobCount);

	const satisfiedTypes = new Set(
		prerequisiteDocuments
			.filter((doc) => doc.status === SATISFYING_DOCUMENT_STATUS)
			.map((doc) => String(doc.type)),
	);

	if (!isDocumentAvailable(documentType, satisfiedTypes)) {
		const inFlight = prerequisiteDocuments.filter((doc) =>
			IN_FLIGHT_DOCUMENT_STATUSES.some((status) => status === doc.status),
		);

		if (inFlight.length > 0) {
			outstanding.prerequisiteDocument = inFlight.length;
		} else {
			// Nothing satisfies the type and nothing is coming. A prerequisite
			// that FAILED is the input that never arrived; no prerequisite row at
			// all is not a failure — the generator has always been allowed to
			// write a tier-2 document from context alone, and refusing that here
			// would take away a thing that works today.
			failed.prerequisiteDocument = prerequisiteDocuments.filter(
				(doc) => doc.status === "FAILED",
			).length;
		}
	}

	const failedEntries = toEntries(failed);
	const outstandingEntries = toEntries(outstanding);

	return {
		verdict:
			failedEntries.length > 0
				? "failed"
				: outstandingEntries.length > 0
					? "waiting"
					: "clear",
		outstanding: outstandingEntries,
		failed: failedEntries,
	};
}
