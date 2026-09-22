/**
 * Gathers everything the capability rules are allowed to read (Fizzy #1930).
 *
 * The rules never query. They receive this bundle and nothing else, so the cost
 * of the whole matrix is a fixed number of round trips rather than one per rule,
 * and every rule is testable against a plain object with no database in sight.
 *
 * Twelve reads, not one per capability: the aggregates are grouped counts, so a
 * single `groupBy` answers four fields at once wherever the shapes allow it.
 *
 * ## What this file deliberately does not read
 *
 * Not the readiness checklist — not its item states, not its level, not its
 * evidence. The two surfaces answer different questions and a person saying
 * "not yet, stop asking" about a checklist row must never unlock a capability.
 * A test reads this directory's source text to enforce it, which is why nothing
 * below names that module even in prose.
 *
 * ## The one predicate that has already cost two regressions
 *
 * `codebase.usable` and `codebase.healthy` are separate booleans and must stay
 * separate. A re-index that fails does not take away the snapshot the project
 * is being served from: the last-good graph is still there and still answering.
 * Collapsing the two hard-blocks those projects at the exact moment their map
 * is working. So `usable` keys on the DURABLE fact — a full index completed at
 * some point and its output survived — and `healthy` keys on the TRANSIENT one:
 * the latest run's outcome and the connection's own status. Good snapshot plus
 * failed refresh gathers `usable: true, healthy: false`, which the rules turn
 * into a warning rather than a block.
 */

import { ORPCError } from "@orpc/server";
import {
	canEditProject,
	canEditProjectSettings,
	db,
	type RepositoryIntegrationStatus,
} from "@repo/database";
import {
	isCodeIndexingDeploymentEnabled,
	isCodeIndexingEnabled,
} from "../projects/lib/code-indexing-enabled";
import type { CapabilityEvidence, JobSnapshot } from "./types";

/**
 * Document statuses that mean the row is finished.
 *
 * Finished is only half the question — see {@link DOCUMENT_STATUSES_THAT_COUNT}.
 */
const USABLE_DOCUMENT_STATUSES = ["COMPLETE", "REVIEW"] as const;

/**
 * Statuses a document passes through while a run is working on it.
 *
 * Regeneration mutates the SAME row, so keying on status alone drops a document
 * the project plainly has the moment someone hits Refresh, and leaves it dropped
 * once the run fails. What survives a failed re-run is the content: the previous
 * version is still on the row and still what retrieval reads.
 *
 * QUEUED belongs here for the same reason GENERATING does — a re-run waiting on
 * the project's context work has not touched the existing content yet, and that
 * wait can last an hour.
 */
const RERUNNING_DOCUMENT_STATUSES = ["QUEUED", "GENERATING", "FAILED"] as const;

/**
 * Every status at which a document can count — but only ever WITH CONTENT.
 *
 * The content test applies to all of them, and the symmetry is the point. The
 * field answers one question: can this document ground a generation? An empty
 * row grounds nothing, and the status written on it does not change that. So a
 * row mid-rerun or outright failed counts when it already holds content, and a
 * COMPLETE row with an empty body does not — the same rule read from both ends,
 * rather than a content test on one arm and a status test on the other.
 *
 * That symmetry is what collapses this to a single predicate instead of an OR
 * of two, and the collapse is the evidence it is right: the two arms were never
 * really different rules.
 *
 * DRAFT and IN_PROGRESS are absent throughout. They are states a document is
 * being written INTO, not states it has come out of.
 */
const DOCUMENT_STATUSES_THAT_COUNT = [
	...USABLE_DOCUMENT_STATUSES,
	...RERUNNING_DOCUMENT_STATUSES,
] as const;

/** Document statuses that mean a run is in flight on that row right now. */
const IN_FLIGHT_DOCUMENT_STATUSES = ["QUEUED", "GENERATING"] as const;

/**
 * Context kinds a PERSON supplied, which is what "how much context does this
 * project have" is actually asking.
 *
 * Three families are excluded on purpose, and each exclusion prevents a
 * double-count rather than merely trimming the list:
 *
 * - `CODE_FILE` / `CODE_FILE_SUMMARY` are written by the indexer. Counting them
 *   makes `context.technical` a restatement of `codebase.usable`, so any
 *   composite rule reading both would weigh one fact twice — and they are the
 *   highest-cardinality rows in the table, so excluding them in the WHERE
 *   clause is also what keeps this read cheap on a large repository.
 * - `ARCHITECTURE_DECISION` and `TEST_CASE` are mirrors: the decision log and
 *   the authored test cases already exist elsewhere and are copied here for
 *   retrieval. The mirror is not a second source.
 * - `TECH_STACK`, `FEATURES`, `GOALS` and `DESCRIPTION` are mirrors of columns
 *   on the project row, one of which this bundle reports separately as
 *   `descriptionLength`.
 */
const HUMAN_SUPPLIED_CONTEXT_TYPES = [
	"FILE",
	"LINK",
	"TEXT",
	"DOCUMENT",
	"IMAGE",
	"SPREADSHEET",
	"INTEGRATION",
	"MEETING_TRANSCRIPT",
	"SLACK_HUDDLE_NOTES",
	"API_SPEC",
] as const;

/** A context source only counts once extraction finished successfully. */
const CONTEXT_INDEXED = "COMPLETED" as const;

/** Extraction states that mean a source is still being ingested. */
const CONTEXT_IN_FLIGHT_STATUSES = ["PENDING", "EXTRACTING"] as const;

/**
 * Context kinds that can ground an architecture or technical answer on their
 * own, without consulting the row's category.
 */
const TECHNICAL_CONTEXT_TYPES = new Set<string>(["API_SPEC"]);

/**
 * Context kinds that describe product intent on their own — what someone wants
 * built and why, rather than how it is built.
 *
 * An uploaded file or document counts here too. Someone who uploads their PRD
 * or brief as a PDF has given the project grounding, and leaving it in neither
 * split made every generator still ask them to "add a PRD". It counts as
 * product grounding only, never as a technical source: an upload tagged with a
 * document type becomes a typed project document after processing and is
 * weighed as that, so an UNTAGGED one says nothing about being technical.
 */
const PRODUCT_CONTEXT_TYPES = new Set<string>([
	"TEXT",
	"MEETING_TRANSCRIPT",
	"SLACK_HUDDLE_NOTES",
	"FILE",
	"DOCUMENT",
]);

/** Which side of the grounding split one context row falls on, if either. */
function classifyContext(
	type: string,
	category: string | null,
): "technical" | "product" | null {
	// A link says what it is; every other kind is classified by its kind
	// alone. Kinds that could honestly be either — an image, a spreadsheet, a
	// synced integration — are counted in neither split, so
	// `technical + product` is a lower bound on `total` rather than a
	// partition of it.
	if (type === "LINK") {
		const linkCategory = category ?? "";
		if (TECHNICAL_LINK_CATEGORIES.has(linkCategory)) {
			return "technical";
		}
		return PRODUCT_LINK_CATEGORIES.has(linkCategory) ? "product" : null;
	}
	if (TECHNICAL_CONTEXT_TYPES.has(type)) {
		return "technical";
	}
	return PRODUCT_CONTEXT_TYPES.has(type) ? "product" : null;
}

/**
 * Link categories that settle the question for a `LINK` row.
 *
 * A link is the one kind whose own column says what it is, so it is classified
 * from the category rather than guessed from the kind. `KNOWLEDGE_BASE_WIKI`
 * and `OTHER` are absent deliberately: a wiki holds either sort of material and
 * `OTHER` is free text, so both stay uncounted rather than being assigned to a
 * side they may not belong to.
 */
const TECHNICAL_LINK_CATEGORIES = new Set<string>([
	"TECHNICAL_DEVELOPER_DOCUMENTATION",
	"API_DOCUMENTATION",
	"COMPLIANCE_SECURITY_DOCUMENTATION",
]);
const PRODUCT_LINK_CATEGORIES = new Set<string>([
	"PRODUCT_DOCUMENTATION",
	"HELP_CENTER_SUPPORT_DOCS",
	"MARKETING_WEBSITE",
]);

/** Background job kinds this bundle reports on, read in one grouped pass. */
const GATED_JOB_KINDS = [
	"CODE_INDEXING",
	"CONTEXT_PROCESSING",
	"DOCUMENT_GENERATION",
] as const;

/** Code index states that mean a run is in flight on that row. */
const CODE_INDEX_IN_FLIGHT_STATUSES = new Set<string>(["PENDING", "INDEXING"]);

/**
 * One row of a status-grouped aggregate, normalised so the three sources that
 * back a {@link JobSnapshot} can share one derivation.
 *
 * `orderedAt` is when the run ENDED, falling back to when its row was created.
 * The distinction decides correctness, not tidiness: runs of one kind overlap —
 * context ingestion routinely runs several sources at once — so ordering two
 * terminal outcomes by creation time can rank a run that failed at 10:30 behind
 * one created five minutes later that finished immediately, which hides the
 * more recent failure. Both models carry a completion timestamp, and it is only
 * null on a row that has not reached a terminal state — which is exactly the
 * row that never takes part in the comparison.
 *
 * `progressAt` is the source's own sign of life and may be null — a background
 * job heartbeats, a project scan has no heartbeat column at all and is measured
 * from when it started, and a run that never started has neither.
 */
interface StatusGroup {
	status: string;
	count: number;
	orderedAt: Date | null;
	progressAt: Date | null;
}

/** Which statuses of one source mean what, for {@link snapshotFrom}. */
interface StatusVocabulary {
	running: readonly string[];
	failed: readonly string[];
	completed: readonly string[];
}

const latestDate = (dates: readonly (Date | null)[]): Date | null =>
	dates.reduce<Date | null>(
		(latest, date) =>
			date && (latest === null || date > latest) ? date : latest,
		null,
	);

const latestOf = (
	groups: StatusGroup[],
	pick: (group: StatusGroup) => Date | null,
): Date | null => latestDate(groups.map(pick));

/**
 * Collapse a status-grouped aggregate into the flat shape the rules read.
 *
 * `lastRunFailed` is decided by ORDERING the two terminal outcomes rather than
 * by the mere presence of a failure: a project that failed once and has since
 * succeeded is healthy, and a source whose only terminal rows are failures is
 * not. See {@link StatusGroup} for why the ordering clock is the completion
 * timestamp rather than when the run started or when its row appeared.
 *
 * `lastProgressAt` is reported only while something is running, because it
 * exists for one purpose: letting the resolver decide whether an in-flight run
 * has stalled. A finished run has no staleness to measure. A running source
 * whose clock cannot be read stays null, and the resolver treats an unknown age
 * as "not stalled" — an unreadable clock is not evidence of death.
 */
function snapshotFrom(
	groups: StatusGroup[],
	vocabulary: StatusVocabulary,
): JobSnapshot {
	const inStatuses = (statuses: readonly string[]): StatusGroup[] =>
		groups.filter(
			(group) => group.count > 0 && statuses.includes(group.status),
		);

	const runningGroups = inStatuses(vocabulary.running);
	const failedGroups = inStatuses(vocabulary.failed);
	const completedGroups = inStatuses(vocabulary.completed);

	const failedAt = latestOf(failedGroups, (group) => group.orderedAt);
	const completedAt = latestOf(completedGroups, (group) => group.orderedAt);

	return {
		running: runningGroups.length > 0,
		lastProgressAt: latestOf(runningGroups, (group) => group.progressAt),
		lastRunFailed:
			failedAt !== null &&
			(completedAt === null || failedAt > completedAt),
	};
}

/** An empty snapshot: nothing of this kind has ever run. */
const NO_RUNS: JobSnapshot = {
	running: false,
	lastProgressAt: null,
	lastRunFailed: false,
};

/**
 * Deliberately not exported: every call site builds this literally, nothing
 * imports the name, and an exported type with no importer is a dead-export
 * finding on the dependency gate.
 */
interface GatherCapabilityEvidenceInput {
	projectId: string;
	/** The viewer. Permissions are resolved for THIS user, not the project's owner. */
	userId: string;
	/**
	 * The tenant the caller believes it is in.
	 *
	 * Checked against the project row's own column rather than believed. Nothing
	 * below filters on this value; it only has to AGREE with what the project
	 * says, and a disagreement means the caller is asking about a project that
	 * is not theirs. The project's own column is what every subsequent read is
	 * scoped by, so a caller cannot widen its reach by passing a different one.
	 */
	organizationId: string | null;
	/**
	 * Ask Atlas for its own verdict on the analysis. **Off by default, and the
	 * default is the point.**
	 *
	 * `AtlasService.getStatus` is not a cheap read and cannot be made into one.
	 * On the ordinary healthy path — a READY snapshot over a live credential —
	 * it asks the provider how far the branch has moved since the analysed
	 * commit, which is an outbound HTTP call to a third party; for a GitHub
	 * OAuth integration it may also attempt a credential refresh. And a run
	 * that has been in flight for more than five hours is reconciled ON READ,
	 * which writes: the analysis is finalized FAILED, its run row completed,
	 * and an audit entry recorded.
	 *
	 * This gather runs on every project page load and again before every gated
	 * action, so none of that may happen unconditionally. Deciding what to draw
	 * must not reach a third-party API, and it must not write an audit row.
	 *
	 * So the caller asks for the Atlas verdict only when the answer is about
	 * to be used — the Atlas surface itself and the Atlas doors — and every
	 * other path derives {@link CodebaseEvidence.healthy} from rows alone.
	 * What that costs is stated on the derivation below.
	 */
	includeAtlasStatus?: boolean;
}

/**
 * Atlas's own verdict on the analysis, or `null` if it could not be had.
 *
 * `@repo/atlas` is imported HERE rather than at the top of the file, and that
 * is load-bearing for two separate reasons.
 *
 * It keeps the package out of the static module graph of everything that
 * reaches this module. The capability guard is imported by procedures across
 * the app, and `@repo/atlas` pulls in the usage recorder, which pulls in the
 * payments package, which registers a hook against the database barrel at
 * module top level — so a static import here made ten unrelated test suites
 * fail at import time, on partial database mocks that had no reason to know
 * about any of it. The same lazy-import pattern, for the same stated reason,
 * is used for the Temporal client in the scan helpers.
 *
 * It also means that with the verdict not requested, the package is not merely
 * unused but never loaded at all.
 *
 * Never throws. The accessor makes a network call, so it can fail for reasons
 * that say nothing about this project, and a gather that failed with it would
 * take a page down over someone else's outage.
 */
async function resolveAtlasStatus(
	projectId: string,
	userId: string,
	organizationId: string | null,
): Promise<string | null> {
	try {
		const { AtlasService } = await import("@repo/atlas");
		const status = await new AtlasService({
			userId,
			organizationId,
		}).getStatus({ projectId, repositoryIntegrationId: null });
		return status.status;
	} catch {
		return null;
	}
}

/**
 * Thrown when the project does not resolve inside the caller's tenant.
 *
 * Gating fails CLOSED. Returning a default bundle would resolve every
 * capability against an empty project, and the strictest-first composite rule
 * turns an empty project into a page of blocks — plausible-looking output for a
 * question that was never answered. A throw makes the defect visible at the
 * call site instead.
 *
 * A structured NOT_FOUND rather than a plain error, so a door that lets it
 * through refuses with a 404 the caller can read instead of a 500 — and NOT
 * FOUND rather than FORBIDDEN, because telling a caller in another tenant that
 * the project exists is itself a leak.
 */
export class CapabilityEvidenceUnavailableError extends ORPCError<
	"NOT_FOUND",
	undefined
> {
	/** Kept for logs; never part of the message a caller sees. */
	readonly projectId: string;

	constructor(projectId: string) {
		super("NOT_FOUND", { message: "Project not found." });
		this.name = "CapabilityEvidenceUnavailableError";
		this.projectId = projectId;
	}
}

export async function gatherCapabilityEvidence({
	projectId,
	userId,
	organizationId,
	includeAtlasStatus = false,
}: GatherCapabilityEvidenceInput): Promise<CapabilityEvidence> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			userId: true,
			organizationId: true,
			description: true,
			// Both legacy columns. They are null on every project connected or
			// indexed through the current path, so reading only them reports
			// "no codebase" on projects that plainly have one — and reading
			// only the current path regresses the projects that predate it.
			// Each is therefore an OR arm beside its modern equivalent below,
			// never a replacement for it.
			repositoryUrl: true,
			codeAnalysisStatus: true,
			// Which scan engines are switched on — the one thing that decides
			// whether scanning needs a repository at all. Two of the four read
			// repository code and both are opt-in; the two that run by default
			// are AI reviewers over documents and features and never touch it.
			//
			// Nested onto this read rather than asked for separately: it is a
			// one-row join on a unique index against a table this gather has
			// to resolve anyway, so it costs no extra round trip. The absent
			// row is not a missing answer — a project that never opened scan
			// settings has the schema defaults, and both of these default off.
			scanConfig: {
				select: { semgrepEnabled: true, gitHistoryEnabled: true },
			},
			// The project half of "will anything ever index this repository".
			// Nested for the same reason as the scan config: a one-row join the
			// gather pays nothing extra for. An absent row is the default, off.
			ragSettings: { select: { codeSearchEnabled: true } },
		},
	});

	// Exclusive tenant check, never an OR of two predicates. The project's own
	// column decides; the caller's claim only has to match it.
	if (!project || project.organizationId !== organizationId) {
		throw new CapabilityEvidenceUnavailableError(projectId);
	}

	const tenantOrganizationId = project.organizationId;

	const [
		codeIndexes,
		repositoryIntegrations,
		jobGroups,
		contextGroups,
		usableDocumentGroups,
		documentsInFlightByType,
		scanGroups,
		viewerCanEditProjectSettings,
		viewerCanUpdateProject,
		atlasStatus,
	] = await Promise.all([
		// Every index row for the project, which is at most a handful — the
		// table is unique on (project, repository, branch). One read answers
		// both halves of the split predicate: whether a full index ever
		// completed (durable) and whether a row is currently failed or in
		// flight (transient).
		db.projectCodeIndex.findMany({
			where: { projectId },
			select: {
				status: true,
				lastFullIndexAt: true,
				updatedAt: true,
				repositoryIntegrationId: true,
			},
		}),
		// NOT filtered to ACTIVE, unlike the readiness-style "is a codebase
		// attached" count. A lapsed credential is a repository that is still
		// connected and whose remedy is "reconnect" — quite different from no
		// repository at all, whose remedy is "connect one". Filtering here
		// would collapse the two and send half the affected viewers to a page
		// with no action for them.
		db.projectRepositoryIntegration.findMany({
			where: { projectId },
			select: { id: true, status: true, updatedAt: true },
			orderBy: { updatedAt: "desc" },
		}),
		// Three job-backed snapshots in one read. Grouping by (kind, status)
		// and taking the max of each clock gives, per kind: whether anything is
		// running, the newest heartbeat among the running rows, and which
		// terminal outcome happened last — without materialising a single job
		// row.
		db.backgroundJob.groupBy({
			by: ["kind", "status"],
			where: { projectId, kind: { in: [...GATED_JOB_KINDS] } },
			_count: { _all: true },
			_max: { createdAt: true, completedAt: true, heartbeatAt: true },
		}),
		// One read serves four fields: the indexed total, the technical and
		// product splits, and whether any source failed ingestion. Grouping by
		// the category as well as the kind is what lets a link be classified
		// without a second query, and restricting the kinds keeps the indexer's
		// own rows — by far the most numerous in this table — out of the scan.
		db.projectContext.groupBy({
			by: ["type", "extractionStatus", "knowledgeBaseSourceCategory"],
			where: {
				projectId,
				type: { in: [...HUMAN_SUPPLIED_CONTEXT_TYPES] },
			},
			_count: { _all: true },
			// The fallback clock for a source in flight with no job row —
			// see `context.processing` below.
			_max: { updatedAt: true },
		}),
		// Active documents that have come out of a run AND hold something — see
		// DOCUMENT_STATUSES_THAT_COUNT for why those are one condition and not
		// two. The predicate TESTS that the row holds content rather than
		// selecting it, so a large document costs nothing to weigh.
		db.projectDocument.groupBy({
			by: ["type"],
			where: {
				projectId,
				isActive: true,
				content: { not: "" },
				status: { in: [...DOCUMENT_STATUSES_THAT_COUNT] },
			},
			_count: { _all: true },
		}),
		// A second, deliberately separate document read. The job rows above
		// carry the clock and the last outcome, but a generation started before
		// those rows existed has no job to report it — and a document sitting
		// in QUEUED or GENERATING is work in flight from the user's side
		// whether or not anything recorded a heartbeat for it. By type, because
		// a generator whose source is one of these is waiting, not missing one.
		db.projectDocument.findMany({
			where: {
				projectId,
				isActive: true,
				status: { in: [...IN_FLIGHT_DOCUMENT_STATUSES] },
			},
			select: { type: true },
			distinct: ["type"],
		}),
		// Project-scoped scans only — see the `scan` field below for what that
		// leaves out. No heartbeat column exists on this model, so `startedAt`
		// is the progress clock (creation time for a run that never started)
		// and creation time orders the outcomes.
		db.projectScan.groupBy({
			by: ["status"],
			where: { projectId, targetType: "PROJECT" },
			_count: { _all: true },
			_max: { createdAt: true, completedAt: true, startedAt: true },
		}),
		// Resolved once for the viewer rather than per rule. These are the
		// HIGHER permissions in play: resolving a gate needs only project
		// access, while clearing one by re-running a job needs whichever of
		// these that job's own door checks — settings-edit to re-index a
		// repository, project-update to start a scan — so an ordinary member
		// routinely sees a block they cannot clear.
		canEditProjectSettings(projectId, userId),
		canEditProject(projectId, userId),
		// Asked for only when the caller says it will use the answer, because
		// this one reaches the network and can write — see `includeAtlasStatus`.
		// When it is read, it is read through the accessor and never from the
		// analysis rows: the accessor reconciles a run that was interrupted, so
		// the rows on their own report ANALYZING for a run the Atlas view
		// itself shows as failed. The repository is left for the accessor to
		// resolve, so this can sit in the parallel gather rather than waiting
		// on the integration read beside it.
		includeAtlasStatus
			? resolveAtlasStatus(projectId, userId, tenantOrganizationId)
			: null,
	]);

	// ── Codebase ─────────────────────────────────────────────────────────────

	// The durable fact. Keyed on `lastFullIndexAt` rather than on status
	// because status flips to INDEXING on every refresh, so a status check
	// would take usability away from a project each time it re-indexes — which
	// is precisely the moment its existing snapshot is still serving.
	const fullIndexCompleted = codeIndexes.some(
		(index) => index.lastFullIndexAt !== null,
	);
	const codebaseUsable =
		fullIndexCompleted || project.codeAnalysisStatus === "COMPLETED";

	const codeIndexFailed = codeIndexes.some(
		(index) => index.status === "FAILED",
	);
	const inFlightIndexes = codeIndexes.filter((index) =>
		CODE_INDEX_IN_FLIGHT_STATUSES.has(index.status),
	);
	const codeIndexInFlight = inFlightIndexes.length > 0;

	const lastIndexCompletedAt = codeIndexes.reduce<Date | null>(
		(latest, index) =>
			index.lastFullIndexAt &&
			(latest === null || index.lastFullIndexAt > latest)
				? index.lastFullIndexAt
				: latest,
		null,
	);

	// Prefer an ACTIVE integration when several are attached, else the most
	// recently touched one. Deterministic either way: a project with one live
	// repository and one lapsed one describes itself by the live one, and the
	// remedy the gate points at follows from that choice rather than from
	// whichever row the database happened to return first.
	const reportedIntegration =
		repositoryIntegrations.find(
			(integration) => integration.status === "ACTIVE",
		) ?? repositoryIntegrations.at(0);

	// Either path counts, so a project connected before integrations existed
	// does not read as disconnected. Such a project has no integration row and
	// therefore no status — which is why `integrationStatus` below can be null
	// on a connected project, and why the rules read the two fields together.
	const codebaseConnected =
		repositoryIntegrations.length > 0 || Boolean(project.repositoryUrl);

	const jobSnapshot = (kind: string): JobSnapshot =>
		snapshotFrom(
			jobGroups
				.filter((group) => group.kind === kind)
				.map((group) => ({
					status: group.status,
					count: group._count._all,
					orderedAt: group._max.completedAt ?? group._max.createdAt,
					progressAt: group._max.heartbeatAt,
				})),
			{
				running: ["RUNNING"],
				failed: ["FAILED"],
				completed: ["COMPLETED"],
			},
		);

	const indexingJob = jobSnapshot("CODE_INDEXING");

	// An index row still marked in flight with no job row RUNNING is the
	// signature of a worker that died mid-run. The watchdog closes the JOB
	// row, but only the workflow's own failure activity closes the INDEX row,
	// and a dead worker never runs it — so the row stays INDEXING forever.
	//
	// Two things follow. If the job that was driving it has since FAILED,
	// that is the answer: the run is over and it failed, whatever the index
	// row still says. Otherwise the index row's own last write is the clock,
	// so the run can at least be measured and called stalled — a run with no
	// readable clock is never declared dead, which here would mean Processing
	// for good.
	const orphanedInFlight = codeIndexInFlight && !indexingJob.running;
	const orphanFailed = orphanedInFlight && indexingJob.lastRunFailed;
	const indexing: JobSnapshot = {
		// The index row's own state counts alongside the job's: an index that
		// is INDEXING with no job row is still an index in flight.
		running: indexingJob.running || (codeIndexInFlight && !orphanFailed),
		lastProgressAt:
			indexingJob.lastProgressAt ??
			(orphanedInFlight && !orphanFailed
				? latestDate(inFlightIndexes.map((index) => index.updatedAt))
				: null),
		lastRunFailed: indexingJob.lastRunFailed || codeIndexFailed,
	};

	// The transient half. Three independent ways the codebase can be unwell,
	// and any one of them is enough: the credential no longer works, the last
	// index run failed, or the analysis itself failed. None of them touches
	// `usable` — that is the whole point of the split.
	//
	// The integration status is taken from the integration row rather than
	// from the Atlas accessor's copy of it: the accessor substitutes a
	// synthetic value when it cannot resolve a repository, which is a
	// different claim from a status observed on the row.
	//
	// WHAT THE DEFAULT GIVES UP. Without `includeAtlasStatus`, `atlasStatus` is
	// null — not "healthy", but "not asked" — and the last arm goes inert.
	// Precisely three things change, and none of them touches `usable`:
	//
	//  1. A FAILED Atlas analysis no longer makes the codebase unhealthy. The
	//     code index and the dependency graph are built by different pipelines
	//     and fail independently, so a project whose index is fine and whose
	//     graph failed reads healthy here while the Atlas tab shows its error.
	//  2. The accessor's reconciliation of a run interrupted more than five
	//     hours ago does not happen from this path. Nothing here depended on
	//     that write, but the FAILED verdict it produces is not available
	//     either, so such a run is invisible to gating until something opens
	//     Atlas or a caller asks for the verdict.
	//  3. A GitHub OAuth credential that lapsed between scheduled health checks
	//     is not lazily refreshed, so the integration row may still read
	//     TOKEN_EXPIRED where the accessor would have restored it to ACTIVE.
	//     That errs toward unhealthy, which is the safe direction: the split
	//     predicate turns it into a warning over a working snapshot, never a
	//     block.
	const codebaseHealthy =
		codebaseConnected &&
		(reportedIntegration === undefined ||
			reportedIntegration.status === "ACTIVE") &&
		!indexing.lastRunFailed &&
		atlasStatus !== "FAILED";

	// What a codebase retry re-indexes: the repository whose index is the
	// problem — failed, or stuck in flight — and failing that the one the
	// gate reports on. Never all of them: a retry is a full rebuild, and
	// multiplying it across repositories nobody asked about is expensive. A
	// row with no integration belongs to the legacy path, which the re-index
	// door cannot target, so it names nothing.
	const troubledIndex = codeIndexes.find(
		(index) =>
			index.repositoryIntegrationId !== null &&
			(index.status === "FAILED" ||
				CODE_INDEX_IN_FLIGHT_STATUSES.has(index.status)),
	);
	const retryTargetId =
		troubledIndex?.repositoryIntegrationId ??
		reportedIntegration?.id ??
		null;

	// ── Context ──────────────────────────────────────────────────────────────

	let contextTotal = 0;
	let contextTechnical = 0;
	let contextProduct = 0;
	let hasFailedSource = false;
	let contextExtracting = 0;
	let contextExtractingSince: Date | null = null;
	let contextTechnicalInFlight = 0;
	let contextProductInFlight = 0;

	for (const group of contextGroups) {
		const count = group._count._all;
		if (group.extractionStatus === "FAILED") {
			hasFailedSource = true;
			continue;
		}
		if (
			CONTEXT_IN_FLIGHT_STATUSES.includes(
				group.extractionStatus as (typeof CONTEXT_IN_FLIGHT_STATUSES)[number],
			)
		) {
			contextExtracting += count;
			contextExtractingSince = latestDate([
				contextExtractingSince,
				group._max.updatedAt,
			]);
			const side = classifyContext(
				group.type,
				group.knowledgeBaseSourceCategory,
			);
			if (side === "technical") {
				contextTechnicalInFlight += count;
			} else if (side === "product") {
				contextProductInFlight += count;
			}
			continue;
		}
		if (group.extractionStatus !== CONTEXT_INDEXED) {
			// CANCELLED. The source gave the project nothing and is not on its
			// way to doing so, so it counts towards neither the totals nor the
			// in-flight work.
			continue;
		}

		contextTotal += count;

		const side = classifyContext(
			group.type,
			group.knowledgeBaseSourceCategory,
		);
		if (side === "technical") {
			contextTechnical += count;
		} else if (side === "product") {
			contextProduct += count;
		}
	}

	const contextJob = jobSnapshot("CONTEXT_PROCESSING");
	const documentJob = jobSnapshot("DOCUMENT_GENERATION");

	return {
		projectId,

		viewer: {
			canEditProjectSettings: viewerCanEditProjectSettings,
			canUpdateProject: viewerCanUpdateProject,
		},

		codebase: {
			connected: codebaseConnected,
			indexingEnabled: isCodeIndexingEnabled(
				project.ragSettings?.codeSearchEnabled,
			),
			indexingAvailable: isCodeIndexingDeploymentEnabled(),
			usable: codebaseUsable,
			healthy: codebaseHealthy,
			// Null means "no repository at all", which is a different state
			// from ACTIVE and leads to different copy. A project attached only
			// through the legacy column also lands here — it has a repository
			// but no integration row whose status could be reported.
			integrationStatus:
				(reportedIntegration?.status as
					| RepositoryIntegrationStatus
					| undefined) ?? null,
			indexing,
			lastIndexCompletedAt,
			retryTargetId,
			// Only ever true when the caller asked Atlas; see
			// `includeAtlasStatus` for why that is not every caller.
			graphReady: atlasStatus === "READY",
		},

		context: {
			total: contextTotal,
			technical: contextTechnical,
			product: contextProduct,
			processing: {
				// A source sitting in PENDING or EXTRACTING is work in flight
				// whether or not a job row was recorded for it — and with no
				// job row running, the source's own last write is the only
				// clock there is. Without it that source could never be called
				// stalled, and would read as Processing for good.
				running: contextJob.running || contextExtracting > 0,
				lastProgressAt:
					contextJob.lastProgressAt ??
					(contextExtracting > 0 ? contextExtractingSince : null),
				lastRunFailed: contextJob.lastRunFailed,
			},
			// Distinct from `processing.lastRunFailed`: that one asks whether
			// the most recent ingestion RUN failed, this one whether any source
			// is currently sitting in a failed state and therefore unusable.
			// A project can have both, or either alone.
			hasFailedSource,
			technicalInFlight: contextTechnicalInFlight,
			productInFlight: contextProductInFlight,
		},

		documents: {
			usableTypes: new Set(
				usableDocumentGroups.map((group) => String(group.type)),
			),
			inFlightTypes: new Set(
				documentsInFlightByType.map((row) => String(row.type)),
			),
			generating: {
				running:
					documentJob.running || documentsInFlightByType.length > 0,
				lastProgressAt: documentJob.lastProgressAt,
				lastRunFailed: documentJob.lastRunFailed,
			},
		},

		descriptionLength: project.description?.trim().length ?? 0,

		// Project-scoped scans only. The interface carries one snapshot, not
		// one per scope, so a feature-scoped scan running against a single
		// story does not make the project's scanning surface read as busy —
		// which is the right answer for a project-level gate and a deliberate
		// omission rather than an oversight.
		scan: {
			// Asked of the configuration, not of any run: a project that has
			// never scanned still has to know whether scanning would need a
			// repository, because that is the question the gate turns into
			// either "connect a repository" or nothing at all.
			requiresCodebase: Boolean(
				project.scanConfig?.semgrepEnabled ||
					project.scanConfig?.gitHistoryEnabled,
			),
			...(scanGroups.length === 0
				? NO_RUNS
				: snapshotFrom(
						scanGroups.map((group) => ({
							status: group.status,
							count: group._count._all,
							orderedAt:
								group._max.completedAt ?? group._max.createdAt,
							// No heartbeat column on this model, so staleness
							// is measured from when the run started — or, for
							// one that never started, from when it was
							// created. A PENDING row whose workflow never
							// began has no start time at all, and treating
							// that as "no clock" left it Processing forever
							// and every later scan refused behind it. The
							// sweep closes such rows on the same clock.
							progressAt:
								group._max.startedAt ?? group._max.createdAt,
						})),
						{
							running: ["PENDING", "RUNNING"],
							failed: ["FAILED"],
							completed: ["COMPLETED"],
						},
					)),
		},

		// `sufficiency` is omitted, not defaulted. No generating capability
		// produces the signal yet, and an empty object would look like an
		// answer of "nothing is sufficient" to a rule that checks for a key.
		// Every v1 rule falls back to its explicit minimum-dependency rule.
	};
}
