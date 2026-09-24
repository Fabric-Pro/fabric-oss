/**
 * The capability gating matrix, in code (Fizzy #1930).
 *
 * One entry per row of the approved matrix, one named unit test per entry in
 * `__tests__/registry.test.ts`. That pairing is the whole point: a rule cannot
 * quietly drift from the specification without a named test failing, which is
 * the same discipline the project readiness registry uses and for the same
 * reason.
 *
 * ## Where the Roadmap rows live
 *
 * The Roadmap rows were first left to the Project Suite cards that build the
 * Roadmap surfaces, and now sit here, by the user decision of 2026-09-18: PM
 * pull, sync and import (3A, FR51-54), feature recommendations and Do Both
 * (3B, FR55-59), and removing an AI-recommended batch (3C, FR60).
 *
 * Work Capture (FR76-81) and living-document refresh (FR72-75) were decided on
 * 2026-09-23: each is a warning and never a block, because the capability
 * still runs, only on less than it could.
 *
 * ## What is deliberately absent
 *
 * **Anything the card puts out of scope**: the readiness checklist, request
 * help, permissions, broad empty-state redesign, and the agent chat surfaces.
 *
 * **The Settings PM Sync toggle and terminal-status rows.** Those controls are
 * disabled in place until a PM tool is connected, which says more than a
 * banner above them could.
 *
 * **Paths that run ungated on purpose.** The scheduled newsletter send and the
 * scheduled document refresh both start inside Temporal, with no person at a
 * door to show a gate to. The doors guard the actions a person or an API
 * caller takes.
 *
 * **Reports.** AC-13 is unmet by design — see the note where a Reports rule
 * would sit.
 *
 * ## Why so many rules end in a warning rather than a block
 *
 * The product direction is explicit that breadth stays discoverable: tabs stay
 * visible, actions gate, and a capability that *can* run on thin input is
 * allowed to, with a warning. Blocking is reserved for the cases where the
 * output would be worthless or the action would simply fail.
 */

// The dependency graph the generation queue waits by. A pure module — one
// type-only import — so this file stays free of the database client.
import { DOCUMENT_TIERS } from "@repo/database/src/document-dependency-graph";
import { isStalled, strictest } from "./resolve";
import { MIN_GROUNDING_DESCRIPTION_LENGTH } from "./thresholds";
import type { CapabilityEvidence, CapabilityRule, RuleVerdict } from "./types";

const AVAILABLE: RuleVerdict = {
	state: "AVAILABLE",
	reasonKey: null,
	blockingDependency: null,
	remedy: null,
};

/**
 * Can the connected repository be reached at all?
 *
 * The first of the two codebase layers, and the only one every code-dependent
 * capability shares. Seven surfaces depend on the repository — Atlas
 * exploration, codebase question answering, the security scan, release notes
 * and three document generators — and the requirements say a source that
 * cannot be used must not be treated as usable by ANY of them. One function, so
 * they cannot disagree about the credential: a divergence here is exactly the
 * bug the requirement is written to prevent.
 *
 * The index is deliberately NOT part of this. Only some of those capabilities
 * read the index at all — the scanners clone the repository live, Atlas builds
 * its own graph, and release notes read the provider directly — so asking them
 * to wait for an index they never consult blocks them on a job that, on a
 * project with code search off, never runs.
 *
 * The two credential cases outrank a good snapshot. A repository whose token
 * has expired may still have a perfectly good index on disk, and serving
 * answers from it would be telling the user their connection works when it
 * does not.
 *
 * `null` means the connection is fine and the caller decides what else to ask.
 */
function connectionVerdict(evidence: CapabilityEvidence): RuleVerdict | null {
	const { codebase } = evidence;

	if (!codebase.connected) {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.not-connected",
			blockingDependency: "a connected repository",
			remedy: "CONNECT_REPOSITORY",
		};
	}

	if (codebase.integrationStatus === "TOKEN_EXPIRED") {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.credentials-expired",
			blockingDependency: "valid repository credentials",
			remedy: "RECONNECT_CREDENTIAL",
		};
	}

	// Not a credential verdict. The schema's own comment says so: the token is
	// fine, it simply cannot read this repository, and reconnecting with the
	// same grant changes nothing. Sending someone to the reconnect flow here
	// wastes their time and teaches them the message is unreliable.
	if (codebase.integrationStatus === "REPO_UNAVAILABLE") {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.repository-unreachable",
			blockingDependency: "access to the connected repository",
			remedy: "INSTALL_REPOSITORY_APP",
		};
	}

	return null;
}

/**
 * Is the repository's index usable — asked only once the connection is.
 *
 * The one rule that governs this function: **Processing is only ever returned
 * while a run is actually in flight.** A repository that nothing is indexing is
 * not "on its way", and a gate that says it is blocks forever with no remedy.
 * So an index that never ran is a hard block naming why — code search is off,
 * or it is on and a first run has to be started — and never a spinner.
 *
 * A retry here is a full re-index of one repository. It is available even for
 * a stalled run: the re-index supersedes the live workflow rather than racing
 * it, so a duplicate is impossible and refusing the button protects nothing.
 * It is supported only where it can succeed — there is a repository to target
 * and indexing is switched on — because a button whose door always refuses is
 * worse than none.
 */
function indexVerdict(
	evidence: CapabilityEvidence,
	now: Date,
	capability: string,
): RuleVerdict {
	const { codebase } = evidence;
	const retry = {
		supported: codebase.retryTargetId !== null && codebase.indexingEnabled,
		available: true,
		targetId: codebase.retryTargetId,
		requires: "projectSettingsEdit" as const,
	};

	if (isStalled(codebase.indexing, "backgroundJob", now)) {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.indexing-stalled",
			blockingDependency: `indexing for ${capability}`,
			remedy: "RETRY_JOB",
			retry,
		};
	}

	if (codebase.indexing.running) {
		return {
			state: "PROCESSING",
			reasonKey: "codebase.indexing",
			blockingDependency: "repository indexing",
			remedy: "WAIT",
		};
	}

	// The split predicate, and the reason it exists. A failed refresh over a
	// surviving snapshot is a warning: the capability genuinely works, on
	// slightly old data. Hard-blocking here would take answers away from
	// projects whose index is being served successfully at that moment.
	if (codebase.usable && !codebase.healthy) {
		return {
			state: "WARNING",
			reasonKey: "codebase.index-stale",
			blockingDependency: "the most recent indexing run",
			remedy: "RETRY_JOB",
			retry,
		};
	}

	if (codebase.usable) {
		return AVAILABLE;
	}

	// Checked before everything below, and apart from the project setting.
	// With code indexing off for the whole deployment, nothing anyone does on
	// this project will index it — the code-search toggle may already be on,
	// and pointing at it would send someone to a switch that changes nothing.
	// No project-level remedy exists, so none is offered.
	if (!codebase.indexingAvailable) {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.indexing-unavailable",
			blockingDependency: "code indexing on this deployment",
			remedy: null,
		};
	}

	// Checked before a failed run, not after it. With code search off a retry
	// is refused at its own door, so pointing at "run it again" would send
	// someone to a button that cannot work; the setting is the real remedy.
	if (!codebase.indexingEnabled) {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.code-search-off",
			blockingDependency: "code search for this project",
			remedy: "ENABLE_CODE_SEARCH",
		};
	}

	if (codebase.indexing.lastRunFailed) {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.indexing-failed",
			blockingDependency: "a completed index of the repository",
			remedy: "RETRY_JOB",
			retry,
		};
	}

	// Enabled, connected, and nothing has ever run — typically a repository
	// connected before code search was switched on, since turning it on does
	// not index what is already attached. Nothing is going to start this on
	// its own, so it is a block with the first run as its remedy.
	return {
		state: "HARD_BLOCK",
		reasonKey: "codebase.never-indexed",
		blockingDependency: "a completed index of the repository",
		remedy: "RETRY_JOB",
		retry,
	};
}

/** Both layers, for a capability that reads the index. */
function codebaseVerdict(
	evidence: CapabilityEvidence,
	now: Date,
	capability: string,
): RuleVerdict {
	return (
		connectionVerdict(evidence) ?? indexVerdict(evidence, now, capability)
	);
}

/**
 * The facts a codebase verdict reads, for a suppression fingerprint.
 *
 * `lastIndexCompletedAt` is the completion marker: a stale-index warning that
 * was dismissed must come back after a later run succeeds and a still later
 * one fails, and without it the two moments would fingerprint identically.
 */
function codebaseFacts(evidence: CapabilityEvidence): string[] {
	const { codebase } = evidence;
	return [
		codebase.connected ? "repo" : "no-repo",
		codebase.integrationStatus ?? "no-integration",
		codebase.usable ? "indexed" : "not-indexed",
		codebase.indexingAvailable ? "indexing-available" : "no-indexing",
		codebase.indexingEnabled ? "search-on" : "search-off",
		`completed:${codebase.lastIndexCompletedAt?.toISOString() ?? "never"}`,
	];
}

/** The grounding facts a document rule reads. */
function groundingFacts(evidence: CapabilityEvidence): string[] {
	return [
		`tech:${evidence.context.technical}`,
		`prod:${evidence.context.product}`,
		`docs:${[...evidence.documents.usableTypes].sort().join("+") || "none"}`,
		`desc:${
			evidence.descriptionLength >= MIN_GROUNDING_DESCRIPTION_LENGTH
				? "grounding"
				: "thin"
		}`,
	];
}

/** Warn when a generation has only the thinnest possible grounding. */
function thinContextWarning(evidence: CapabilityEvidence): RuleVerdict {
	// Any real source grounds the generation regardless of how the brief reads:
	// a project with documents or context is not thin, however terse its
	// description. The brief only carries the decision when it is the ONLY
	// thing there, and then it has to be substantial — see
	// MIN_GROUNDING_DESCRIPTION_LENGTH for why this bound cannot sit at the
	// creation floor.
	const grounded =
		evidence.context.product > 0 ||
		evidence.documents.usableTypes.size > 0 ||
		evidence.descriptionLength >= MIN_GROUNDING_DESCRIPTION_LENGTH;
	if (grounded) {
		return AVAILABLE;
	}
	return {
		state: "WARNING",
		reasonKey: "context.thin",
		blockingDependency: "project context",
		remedy: "ADD_CONTEXT",
	};
}

/**
 * The document and context sources one grounding question is asked of — the
 * ones that are ready, or with the in-flight ones added.
 */
interface Sources {
	types: ReadonlySet<string>;
	technical: number;
	product: number;
}

function readySources(evidence: CapabilityEvidence): Sources {
	return {
		types: evidence.documents.usableTypes,
		technical: evidence.context.technical,
		product: evidence.context.product,
	};
}

/**
 * Ready plus in flight — but only what the generation workflow will actually
 * wait for.
 *
 * "Waiting on a source" is a promise, and the dependency queue keeps it for
 * exactly two things: a source still being ingested (every generator waits on
 * those), and a document of one of its OWN prerequisite types in the shared
 * dependency graph. An architecture document generating does not hold an API
 * specification back — they are the same tier and run side by side — so
 * counting it would say the queue waits when it does not, and the run would
 * start without the source it was told it had. The generator's own type is
 * never its own prerequisite, so a regeneration never waits on itself.
 */
function eventualSources(
	evidence: CapabilityEvidence,
	ownType: string,
): Sources {
	const waitedOn = new Set(DOCUMENT_TIERS[ownType]?.prerequisites ?? []);
	return {
		types: new Set([
			...evidence.documents.usableTypes,
			...[...evidence.documents.inFlightTypes].filter((type) =>
				waitedOn.has(type),
			),
		]),
		technical:
			evidence.context.technical + evidence.context.technicalInFlight,
		product: evidence.context.product + evidence.context.productInFlight,
	};
}

/**
 * Soft-block a generator that has no source of the kind it needs.
 *
 * Soft rather than hard throughout: the page stays usable and the other
 * generators on it keep working — only this one action is out of reach, which
 * is what the action-level-first direction asks for.
 *
 * Before saying "add a source", two better answers are tried.
 *
 * **A source is on its way.** A document still generating or a source still
 * being ingested would ground this generator once it lands. That is
 * Processing — the dependency queue waits on it — and telling someone to add
 * what they just added would be false.
 *
 * **The repository is the only way.** For a generator the repository can
 * ground on its own (`canUseCodebase`), "add a source" is the wrong thing to
 * say when the source is there and not ready: the codebase verdict's reason
 * and remedy are returned instead, still as a soft block — code search is off,
 * indexing has not run, it is running, it failed, the credential lapsed — and
 * the person is pointed at the remedy that actually applies. The index counts only when usable AND reachable through a
 * working connection; an index behind an expired credential is not one,
 * whatever is on disk. When a document or context source grounds the
 * generation, the index's state does not matter at all.
 */
function requiresSource(
	evidence: CapabilityEvidence,
	now: Date,
	source: {
		ownType: string;
		grounds: (sources: Sources) => boolean;
		canUseCodebase: boolean;
		reasonKey: string;
		dependency: string;
	},
): RuleVerdict {
	if (source.grounds(readySources(evidence))) {
		return AVAILABLE;
	}
	// The repository before anything in flight: a usable index already
	// grounds this generator, and saying "waiting on a source" over one would
	// describe a wait that is not happening. A stale index still grounds it,
	// with its warning.
	const codebase =
		source.canUseCodebase && evidence.codebase.connected
			? codebaseVerdict(evidence, now, "this document")
			: null;
	if (codebase?.state === "AVAILABLE" || codebase?.state === "WARNING") {
		return codebase;
	}
	if (source.grounds(eventualSources(evidence, source.ownType))) {
		return {
			state: "PROCESSING",
			reasonKey: "documents.source-processing",
			blockingDependency: source.dependency,
			remedy: "WAIT",
		};
	}
	// The repository is the only way, and it is not ready. Its own reason and
	// remedy travel — "Turn on code search", "Start indexing", "Reconnect" —
	// but as a SOFT block, like every other "no source" answer a generator
	// gives. A document generator can be grounded by what the person supplies
	// with the request, so this must be the kind of block pasted source text
	// lifts; a hard block would send someone who pasted their API docs to a
	// code-search toggle instead. Atlas, the scanners and release notes read
	// the repository itself and keep their hard blocks.
	if (codebase) {
		return { ...codebase, state: "SOFT_BLOCK" };
	}
	return {
		state: "SOFT_BLOCK",
		reasonKey: source.reasonKey,
		blockingDependency: source.dependency,
		remedy: "ADD_CONTEXT",
	};
}

/**
 * Does the project hold a technical source other than the repository?
 *
 * The repository is weighed separately by {@link requiresSource}, which knows
 * how to tell "no source" from "a source that is not ready yet".
 */
function hasTechnicalDocumentOrContext(sources: Sources): boolean {
	return (
		sources.technical > 0 ||
		sources.types.has("ARCHITECTURE") ||
		sources.types.has("TECHNICAL_SPEC")
	);
}

/** The facts a document rule that may fall back to the repository reads. */
function sourceFacts(evidence: CapabilityEvidence): string[] {
	return [...groundingFacts(evidence), ...codebaseFacts(evidence)];
}

/** The verdicts a composite rule actually has, without the absent ones. */
function present(verdicts: readonly (RuleVerdict | null)[]): RuleVerdict[] {
	return verdicts.filter(
		(verdict): verdict is RuleVerdict => verdict !== null,
	);
}

/**
 * Is the project-management tool reachable through either door path?
 *
 * Either is enough. A legacy project that names only a server has no bulk
 * target, yet its single-item sync and import work, and blocking those would
 * take away something that runs today.
 */
function pmConnectionVerdict(evidence: CapabilityEvidence): RuleVerdict | null {
	if (evidence.pm.bulkTargetResolvable || evidence.pm.itemConfigResolvable) {
		return null;
	}
	return {
		state: "HARD_BLOCK",
		reasonKey: "roadmap.pm-not-connected",
		blockingDependency: "a connected project management system",
		remedy: "CONFIGURE_INTEGRATION",
	};
}

/** A board is chosen in Project Settings, which is where the fix lives. */
function pmBoardVerdict(evidence: CapabilityEvidence): RuleVerdict | null {
	if (evidence.pm.boardSelected) {
		return null;
	}
	return {
		state: "HARD_BLOCK",
		reasonKey: "roadmap.pm-no-board",
		blockingDependency:
			"a project management board selected in Project Settings",
		remedy: "CONFIGURE_PM_BOARD",
	};
}

/**
 * A story pull or push is in flight. A stalled run does not block — the
 * watchdog closes it and a new pull supersedes it — and a failed last run never
 * blocks, because running it again is the remedy.
 */
function pmRunningVerdict(
	evidence: CapabilityEvidence,
	now: Date,
): RuleVerdict | null {
	const { syncing } = evidence.pm;
	if (!syncing.running || isStalled(syncing, "backgroundJob", now)) {
		return null;
	}
	return {
		state: "PROCESSING",
		reasonKey: "roadmap.pm-sync-running",
		blockingDependency: "the running project management sync",
		remedy: "WAIT",
	};
}

/**
 * Can work items be pulled from the PM system right now? Shared by the pull
 * rule and Do Both, so the two can never disagree about the pull half.
 *
 * The connection is listed first on purpose: `strictest` keeps the first of two
 * equally severe verdicts, and "connect a system" must win over "choose a
 * board" when both are missing.
 */
function pmPullVerdict(evidence: CapabilityEvidence, now: Date): RuleVerdict {
	return strictest(
		present([
			pmConnectionVerdict(evidence),
			pmBoardVerdict(evidence),
			pmRunningVerdict(evidence, now),
		]),
	);
}

/** Which half of Do Both a block belongs to, and for the PM half, which fix. */
function doBothReasonKey(verdict: RuleVerdict, pull: RuleVerdict): string {
	if (verdict !== pull) {
		return "roadmap.do-both.needs-context";
	}
	return pull.reasonKey === "roadmap.pm-no-board"
		? "roadmap.do-both.needs-board"
		: "roadmap.do-both.needs-pm";
}

/** The PM facts a Roadmap rule reads, for a suppression fingerprint. */
function pmFacts(evidence: CapabilityEvidence): string[] {
	const { pm } = evidence;
	const connected = pm.bulkTargetResolvable || pm.itemConfigResolvable;
	return [
		`pm:${connected ? "on" : "off"}`,
		`board:${pm.boardSelected ? "on" : "off"}`,
		`ro:${pm.readOnly ? "on" : "off"}`,
	];
}

/**
 * Is there enough to recommend Features from?
 *
 * A real source grounds it outright. Short of one, a substantial description or
 * a Roadmap with items still gives the model something to read, so the run is
 * allowed with a warning. With neither, the batch would be invented, so it is a
 * soft block pointing at adding context. Never HIDDEN and never PROCESSING, and
 * the rollout flag is not an input: whether the feature exists is not a
 * dependency it has.
 */
function recommendVerdict(evidence: CapabilityEvidence): RuleVerdict {
	if (
		evidence.context.product > 0 ||
		evidence.context.technical > 0 ||
		evidence.documents.usableTypes.size > 0
	) {
		return AVAILABLE;
	}
	if (
		evidence.descriptionLength >= MIN_GROUNDING_DESCRIPTION_LENGTH ||
		evidence.roadmap.itemCount > 0
	) {
		return {
			state: "WARNING",
			reasonKey: "context.thin",
			blockingDependency: "project context",
			remedy: "ADD_CONTEXT",
		};
	}
	return {
		state: "SOFT_BLOCK",
		reasonKey: "roadmap.recommend.context-insufficient",
		blockingDependency: "project context",
		remedy: "ADD_CONTEXT",
	};
}

/** The facts the recommendation verdict reads. */
function recommendFacts(evidence: CapabilityEvidence): string[] {
	return [
		...groundingFacts(evidence),
		`roadmap:${evidence.roadmap.itemCount > 0 ? "items" : "empty"}`,
	];
}

export const CAPABILITY_RULES: readonly CapabilityRule[] = [
	// ---------------------------------------------------------------- Documents
	{
		key: "documents.generate-prd",
		label: "Generate PRD",
		surface: "documents",
		evaluate: (e) => thinContextWarning(e),
		fingerprint: groundingFacts,
	},
	{
		key: "documents.generate-business-case",
		label: "Generate Business Case",
		surface: "documents",
		evaluate: (e) => thinContextWarning(e),
		fingerprint: groundingFacts,
	},
	{
		key: "documents.generate-proposal",
		label: "Generate Proposal",
		surface: "documents",
		evaluate: (e) => thinContextWarning(e),
		fingerprint: groundingFacts,
	},
	{
		key: "documents.generate-architecture",
		label: "Generate Architecture Document",
		surface: "documents",
		evaluate: (e, now) =>
			requiresSource(e, now, {
				ownType: "ARCHITECTURE",
				grounds: (s) =>
					hasTechnicalDocumentOrContext(s) ||
					s.types.has("PRD") ||
					s.types.has("PROPOSAL") ||
					s.types.has("BUSINESS_CASE"),
				canUseCodebase: true,
				reasonKey: "documents.no-architecture-source",
				dependency: "a product or architecture source",
			}),
		fingerprint: sourceFacts,
	},
	{
		key: "documents.generate-tech-spec",
		label: "Generate Technical Specification",
		surface: "documents",
		evaluate: (e, now) =>
			requiresSource(e, now, {
				ownType: "TECHNICAL_SPEC",
				grounds: (s) =>
					hasTechnicalDocumentOrContext(s) || s.types.has("PRD"),
				canUseCodebase: true,
				reasonKey: "documents.no-technical-source",
				dependency: "a PRD, architecture document or indexed codebase",
			}),
		fingerprint: sourceFacts,
	},
	{
		key: "documents.generate-api-spec",
		label: "Generate API Specification",
		surface: "documents",
		evaluate: (e, now) =>
			requiresSource(e, now, {
				ownType: "API_SPEC",
				grounds: hasTechnicalDocumentOrContext,
				canUseCodebase: true,
				reasonKey: "documents.no-api-source",
				dependency: "an API-relevant source",
			}),
		fingerprint: sourceFacts,
	},
	{
		key: "documents.generate-qa-strategy",
		label: "Generate QA Strategy",
		surface: "documents",
		evaluate: (e, now) =>
			requiresSource(e, now, {
				ownType: "QA_STRATEGY",
				grounds: (s) => s.types.has("PRD") || s.product > 0,
				canUseCodebase: false,
				reasonKey: "documents.no-requirements-source",
				dependency: "a PRD or equivalent requirements context",
			}),
		fingerprint: groundingFacts,
	},
	{
		key: "documents.auto-refresh",
		label: "Refresh a living document automatically",
		surface: "documents",
		// Warnings only, by product decision: a refresh with nothing to read
		// simply finds nothing to change, which costs a cycle and harms nothing,
		// so the toggle stays usable and the owner is told what it will find.
		//
		// Built from exactly what a refresh reads — retrieved context rows and
		// the linked Slack and Teams conversations fetched live — and nothing
		// else. Not the codebase: its vectors never resolve in that retrieval.
		// Not features or decision threads either: no story is embedded, and a
		// document refresh passes no story to fetch threads for. Retrieval
		// also skips context older than the document itself; that is a fact
		// about one document, and this gate is project-wide, so it answers
		// "is there anything at all" rather than "anything new for this one".
		evaluate: (e, now) => {
			// Processing first. A source still being read is on its way, so
			// "nothing to read" would be false for a project whose only source
			// is that one — and for a project that has others, a refresh that
			// runs now reads them without it. A stalled ingestion is not on its
			// way, which is why it falls through.
			if (
				e.context.processing.running &&
				!isStalled(e.context.processing, "backgroundJob", now)
			) {
				return {
					state: "WARNING",
					reasonKey: "documents.refresh-sources-processing",
					blockingDependency: "sources still being processed",
					remedy: "WAIT",
				};
			}
			if (!e.refreshSources.readable) {
				return {
					state: "WARNING",
					reasonKey: "documents.refresh-nothing-to-read",
					blockingDependency: "a source a refresh can read",
					remedy: "ADD_CONTEXT",
				};
			}
			return AVAILABLE;
		},
		fingerprint: (e) => [
			e.context.processing.running ? "processing" : "idle",
			e.refreshSources.readable ? "readable" : "nothing-readable",
		],
	},

	// ------------------------------------------------------------------ Context
	{
		key: "context.use-linked-source",
		label: "Use a linked knowledge-base source",
		surface: "context",
		evaluate: (e, now) => {
			// No retry. Ingestion is per source and the Context tab has no
			// re-run for one — the way out is removing the stuck source and
			// adding it again, which is what the copy says. Offering a retry
			// no surface could perform would render nothing and promise it.
			if (isStalled(e.context.processing, "backgroundJob", now)) {
				return {
					state: "HARD_BLOCK",
					reasonKey: "context.ingestion-stalled",
					blockingDependency: "source ingestion",
					remedy: null,
				};
			}
			if (e.context.processing.running) {
				return {
					state: "PROCESSING",
					reasonKey: "context.ingesting",
					blockingDependency: "source ingestion",
					remedy: "WAIT",
				};
			}
			return AVAILABLE;
		},
		// Only blocks and processing come out of this rule, and neither can be
		// suppressed; the count is here so the fingerprint is not empty.
		fingerprint: (e) => [`ctx:${e.context.total}`],
	},

	// -------------------------------------------------------------------- Atlas
	{
		key: "atlas.explore",
		label: "Explore the codebase graph",
		surface: "atlas",
		// The connection only. Analysis is what BUILDS the Atlas graph, and it
		// clones the repository itself — it never reads the code index. Asking
		// it to wait for that index made Analyze wait on a different pipeline,
		// one that on a project with code search off never runs at all, and it
		// made Reanalyze (the retry for a failed analysis) refuse itself.
		evaluate: (e) => connectionVerdict(e) ?? AVAILABLE,
		fingerprint: codebaseFacts,
	},
	{
		key: "atlas.codebase-qa",
		label: "Ask a question about the codebase",
		surface: "atlas",
		// Questions need something built to answer from: the Atlas graph, or
		// failing that the code index. Either will do, so a project whose
		// graph is serving is not held back by an index it never needed. The
		// graph's status is read only when the caller asked for Atlas's
		// verdict — the Atlas surface and its doors — and elsewhere this falls
		// through to the index.
		evaluate: (e, now) => {
			const connection = connectionVerdict(e);
			if (connection) {
				return connection;
			}
			if (e.codebase.graphReady) {
				return AVAILABLE;
			}
			return indexVerdict(e, now, "codebase questions");
		},
		fingerprint: (e) => [
			...codebaseFacts(e),
			e.codebase.graphReady ? "graph" : "no-graph",
		],
	},

	// ----------------------------------------------------------------- Security
	{
		key: "security.run-scan",
		label: "Run a security scan",
		surface: "security",
		evaluate: (e, now) => {
			// Only gate on the codebase when an engine that actually reads
			// repository code is switched on.
			//
			// The requirement says a security scan needs a connected, readable
			// codebase, and taken literally that removes a working capability:
			// the two engines that run by DEFAULT are AI reviewers over
			// documents and features, and they need no repository whatsoever.
			// The repository scanners — Semgrep and the git-history secret
			// scan — are both opt-in and off by default. Blocking the whole
			// action on a repository would therefore take spec review away
			// from exactly the projects that have nothing but specs, which is
			// the audience this suite exists to help.
			//
			// And even then only the CONNECTION, never the index: both
			// repository scanners clone the repository at scan time and read
			// the working tree, not the code index. Waiting for an index they
			// never consult would block them on a job that, with code search
			// off, never runs.
			const prerequisites: RuleVerdict[] = [];
			if (e.scan.requiresCodebase) {
				const connection = connectionVerdict(e);
				if (connection) {
					prerequisites.push(connection);
				}
			}
			// Scans are the one source with no heartbeat, so their staleness is
			// measured from when the run started and the window is necessarily
			// generous. A sweep now closes abandoned rows as well; this is what
			// the page shows in the gap before it next runs.
			if (isStalled(e.scan, "projectScan", now)) {
				prerequisites.push({
					state: "HARD_BLOCK",
					reasonKey: "scan.stalled",
					blockingDependency: "the previous scan run",
					remedy: "RETRY_JOB",
					// The retry starts a new scan, and the trigger closes the
					// stalled row first — measured against the same window as
					// this rule, so a row is only ever closed on the server's
					// own clock, never because a client said it was stuck.
					retry: {
						supported: true,
						available: true,
						requires: "projectUpdate",
					},
				});
			} else if (e.scan.running) {
				prerequisites.push({
					state: "PROCESSING",
					reasonKey: "scan.running",
					blockingDependency: "the running scan",
					remedy: "WAIT",
				});
			}

			// Collapsed rather than returned in order. Returning the first
			// non-available verdict looks equivalent and is not: a codebase that
			// is merely stale yields a WARNING, and an early return would hand
			// that back while a scan sat stalled behind it — the weaker state
			// winning purely because it was checked first. The composite rule
			// exists precisely so severity, not evaluation order, decides.
			return strictest(prerequisites);
		},
		fingerprint: (e) => [
			e.scan.requiresCodebase ? "repo-engines" : "no-repo-engines",
			...codebaseFacts(e),
		],
	},

	// ------------------------------------------------------------------ Reports
	//
	// No rule, deliberately, and the reason is structural rather than a matter
	// of effort.
	//
	// Reports are TENANT-scoped: `TemplateInstance` carries a user and an
	// organization and no project at all, and the whole reports module contains
	// no reference to a project id. Every gate here is resolved for one project,
	// so a report gate would either need a project that does not exist or would
	// have to answer about the whole tenant — and a tenant-wide answer applied
	// to one report refuses a correctly configured report because some unrelated
	// one is unconfigured.
	//
	// The requirement it would have served — template cards stay visible in a
	// needs-setup state explaining what to connect, rather than being hidden —
	// is already met, by code that predates this feature and is better placed
	// for it: `apps/web/modules/saas/reports/lib/report-readiness.ts` derives it
	// per instance and feeds the banner, the connection pill and the readiness
	// rail from one source of truth. It also reads live connection diagnostics
	// the server cannot reproduce, so moving it here would lose information
	// rather than gain consistency.
	//
	// A report-scoped gate belongs in a card that can give reports a project, or
	// can accept tenant scope deliberately. It does not belong bolted onto a
	// project-scoped resolver.

	// ------------------------------------------------------------ Release notes
	{
		key: "release-notes.generate",
		label: "Generate release notes",
		surface: "release-notes",
		// v1 is codebase-driven by explicit decision. A project-management
		// system may enrich the output later but never substitutes for the
		// repository, so the gate asks only about the codebase — and only its
		// CONNECTION. The newsletter reads releases and pull requests from the
		// provider live and never touches the code index, so an index is not
		// its prerequisite; a credential that no longer works is, whatever
		// state the index is in.
		evaluate: (e) => connectionVerdict(e) ?? AVAILABLE,
		fingerprint: codebaseFacts,
	},

	// ----------------------------------------------------------------- Settings
	//
	// This rule has no banner, and that is deliberate: its UI half is already
	// served, more precisely, by `ProjectRepositoryIntegrationSettings` via
	// `repo-status-meta`. That row renders the status label, the remedial hint
	// and the unclamped `lastError` as persistent visible text — satisfying
	// AC-15's "hover-only is not acceptable" — and it keeps TOKEN_EXPIRED
	// ("reconnect") apart from REPO_UNAVAILABLE ("grant access", never
	// reconnect), a distinction `repo-status-meta.test.ts` pins and a generic
	// banner would blur. AC-15 asks for the EXISTING Settings/Integrations
	// pattern, so reusing it is the requirement, not a shortcut.
	//
	// The rule stays because the web UI is not the only consumer: `get.ts`
	// serves the whole matrix (or one surface), and coding agents, the public
	// API and Fabric's own tools read it. They need `state`, `reasonKey`,
	// `blockingDependency` and `remedy` — a complete answer that needs no
	// rendered copy. Deleting this entry would quietly narrow AC-12/AC-15
	// coverage to browsers, and no web test would notice, because nothing in
	// the web renders it. A QA pass in 2026-09 reached exactly that wrong
	// conclusion; this note exists so the next reader does not.
	{
		key: "settings.repository-connection",
		label: "Repository connection status",
		surface: "settings",
		evaluate: (e) => {
			// Settings warn, never block — this is where people come to satisfy
			// the prerequisite in the first place, so taking the page away from
			// them would be self-defeating. The value of this rule is honesty:
			// a connection that cannot be used must not read as Connected.
			if (e.codebase.integrationStatus === "TOKEN_EXPIRED") {
				return {
					state: "WARNING",
					reasonKey: "settings.credentials-expired",
					blockingDependency: "valid repository credentials",
					remedy: "RECONNECT_CREDENTIAL",
				};
			}
			if (e.codebase.integrationStatus === "REPO_UNAVAILABLE") {
				return {
					state: "WARNING",
					reasonKey: "settings.repository-unreachable",
					blockingDependency: "access to the connected repository",
					remedy: "INSTALL_REPOSITORY_APP",
				};
			}
			if (e.codebase.connected && !e.codebase.healthy) {
				return {
					state: "WARNING",
					reasonKey: "settings.connection-degraded",
					blockingDependency: "the most recent indexing run",
					remedy: "RETRY_JOB",
					retry: {
						supported:
							e.codebase.retryTargetId !== null &&
							e.codebase.indexingEnabled,
						available: true,
						targetId: e.codebase.retryTargetId,
						requires: "projectSettingsEdit",
					},
				};
			}
			return AVAILABLE;
		},
		fingerprint: codebaseFacts,
	},
	{
		key: "settings.work-capture",
		label: "Capture work from chat",
		surface: "settings",
		// A warning, never a block — this page is where a conversation gets
		// linked, so taking it away would remove the way out. No remedy: the
		// link controls are the cards directly beneath the banner, and a
		// button pointing back at them would be the same section twice.
		evaluate: (e) =>
			e.chat.linkedChannelCount > 0
				? AVAILABLE
				: {
						state: "WARNING",
						reasonKey: "settings.no-linked-channel",
						blockingDependency:
							"a linked Slack or Teams conversation",
						remedy: null,
					},
		fingerprint: (e) => [
			e.chat.linkedChannelCount > 0 ? "linked" : "none-linked",
		],
	},

	// ------------------------------------------------------------------ Roadmap
	{
		key: "roadmap.view",
		label: "View the Roadmap",
		surface: "roadmap",
		// The page itself never gates: its actions do, one by one.
		evaluate: () => AVAILABLE,
		fingerprint: () => ["roadmap-view"],
	},
	{
		key: "roadmap.pull-from-pm",
		label: "Pull work items from the PM system",
		surface: "roadmap",
		evaluate: pmPullVerdict,
		fingerprint: pmFacts,
	},
	{
		key: "roadmap.sync-to-pm",
		label: "Sync work items to the PM system",
		surface: "roadmap",
		// Read-only mode refuses writes to the PM tool and nothing else, so it
		// blocks this and not the pull. It has no remedy to offer: turning it
		// off is a deliberate project decision, not a setup step.
		evaluate: (e, now) =>
			strictest(
				present([
					pmConnectionVerdict(e),
					pmBoardVerdict(e),
					e.pm.readOnly
						? {
								state: "HARD_BLOCK",
								reasonKey: "roadmap.pm-read-only",
								blockingDependency:
									"project management writes to be allowed (read-only mode is on)",
								remedy: null,
							}
						: null,
					pmRunningVerdict(e, now),
				]),
			),
		fingerprint: pmFacts,
	},
	{
		key: "roadmap.pm-import",
		label: "Import a work item from the PM system",
		surface: "roadmap",
		// No board arm: only one provider's import needs a board, and its door
		// checks that itself.
		evaluate: (e, now) =>
			strictest(
				present([pmConnectionVerdict(e), pmRunningVerdict(e, now)]),
			),
		fingerprint: pmFacts,
	},
	{
		key: "roadmap.recommend-features",
		label: "Recommend Features from Context",
		surface: "roadmap",
		evaluate: (e) => recommendVerdict(e),
		fingerprint: recommendFacts,
	},
	{
		key: "roadmap.do-both",
		label: "Do Both",
		surface: "roadmap",
		// The stricter of its two halves. A block is renamed to say which half
		// is missing — "Do Both is not ready" helps nobody — while keeping that
		// half's remedy. A missing board is named apart from a missing
		// connection, because the fix is a different page. Processing and a
		// thin-context warning pass through unchanged, so the warning is
		// dismissible like any other.
		evaluate: (e, now) => {
			const pull = pmPullVerdict(e, now);
			const verdict = strictest([pull, recommendVerdict(e)]);
			if (
				verdict.state !== "HARD_BLOCK" &&
				verdict.state !== "SOFT_BLOCK"
			) {
				return verdict;
			}
			return { ...verdict, reasonKey: doBothReasonKey(verdict, pull) };
		},
		fingerprint: (e) => [...pmFacts(e), ...recommendFacts(e)],
	},
	{
		key: "roadmap.remove-ai-recommended",
		label: "Remove AI Recommended Items",
		surface: "roadmap",
		// Hidden, not blocked, with nothing to remove: there is no object to
		// act on, so the entry has no business on the page.
		evaluate: (e) =>
			e.aiRecommended.eligibleBatchCount === 0
				? {
						state: "HIDDEN",
						reasonKey: "roadmap.no-eligible-ai-batch",
						blockingDependency: "an eligible AI-recommended batch",
						remedy: null,
					}
				: AVAILABLE,
		fingerprint: (e) => [`aiBatches:${e.aiRecommended.eligibleBatchCount}`],
	},
];

/** Look one up without scanning the array at every call site. */
export const CAPABILITY_RULES_BY_KEY: ReadonlyMap<string, CapabilityRule> =
	new Map(CAPABILITY_RULES.map((rule) => [rule.key, rule]));
