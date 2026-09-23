/**
 * Dependency-aware capability gating — shared types (Fizzy #1930).
 *
 * Two invariants hold this module together, and both are load-bearing enough
 * that a test enforces them rather than a convention:
 *
 * **Nothing about a gate is stored.** Every state below is derived from live
 * system state on each read, the same way project readiness derives completion,
 * so a gate can never drift from what the project actually looks like. The only
 * persisted thing is warning suppression — a choice a person made deliberately —
 * and that is applied *after* resolution and can only ever hide a warning.
 *
 * **This module never reads the readiness checklist.** Not its item states, not
 * its level, not its evidence. The two answer different questions: readiness
 * asks "has this project been set up", gating asks "can this capability run
 * right now". A snoozed checklist item is a person saying "not yet, stop asking"
 * — it is not the dependency appearing, and it must never unlock anything.
 * `__tests__/readiness-isolation.test.ts` reads this directory's source text and
 * fails the build if an import of `../projects/lib/readiness` ever appears.
 */

import type { RepositoryIntegrationStatus } from "@repo/database";

/**
 * What a capability resolves to for one viewer, right now.
 *
 * The order of the union is the order of severity, and `resolve.ts` depends on
 * that: a composite gate takes the strictest state of its prerequisites.
 */
export type CapabilityState =
	| "HARD_BLOCK"
	| "SOFT_BLOCK"
	| "PROCESSING"
	| "WARNING"
	| "AVAILABLE"
	| "HIDDEN";

/**
 * Severity for the composite rule, lower wins.
 *
 * `HIDDEN` sits outside the ladder deliberately: it is not a severity but an
 * applicability verdict. An action with no eligible object to act on is not
 * "more available" than one that is blocked — it simply should not be on the
 * page. A rule returns it directly or not at all, and it never competes.
 */
export const STATE_SEVERITY: Record<
	Exclude<CapabilityState, "HIDDEN">,
	number
> = {
	HARD_BLOCK: 0,
	SOFT_BLOCK: 1,
	PROCESSING: 2,
	WARNING: 3,
	AVAILABLE: 4,
};

/**
 * The remedy a blocked capability points at.
 *
 * This is not cosmetic. The repository status enum already distinguishes an
 * expired credential from a repository the credential simply cannot read, and
 * its own schema comment says reconnecting cannot fix the second one. Pointing
 * both at "reconnect" sends half the affected users to a page with no action
 * for them, so the remedy travels with the gate instead of being inferred from
 * the state at render time.
 */
export type RemedyKind =
	| "CONNECT_REPOSITORY"
	| "RECONNECT_CREDENTIAL"
	| "INSTALL_REPOSITORY_APP"
	| "ADD_CONTEXT"
	| "GENERATE_PREREQUISITE_DOCUMENT"
	| "CONFIGURE_INTEGRATION"
	| "ENABLE_CODE_SEARCH"
	| "RETRY_JOB"
	| "WAIT";

/**
 * Whether the viewer can act on a retryable failure.
 *
 * Three axes, not two, because they fail independently and the copy differs for
 * each. `supported` — there is a job to re-enqueue at all. `permitted` — this
 * viewer holds the permission the re-run needs, which is a *higher* permission
 * than the one that resolved the gate, so an ordinary member routinely sees a
 * block they cannot clear. `available` — no run is in flight, so pressing again
 * would only duplicate it.
 *
 * When `permitted` is false the control still renders, disabled, referring the
 * viewer to a project admin. Hiding it would make the block look unfixable,
 * which is the opposite of what this feature exists to do.
 */
export interface RetryAffordance {
	supported: boolean;
	permitted: boolean;
	available: boolean;
	/**
	 * What a retry re-runs, when the re-run needs one named. For a codebase
	 * retry this is the repository integration to re-index — the one whose
	 * index failed or never ran, not every repository on the project, because
	 * a retry is a full rebuild and multiplying it across repositories nobody
	 * asked about is expensive. `null` when the re-run needs no target, or
	 * when there is none to name.
	 */
	targetId: string | null;
}

/**
 * The permission a retry's re-run is checked against at its own door.
 *
 * Not one permission for every retry, because the doors disagree: re-indexing a
 * repository is a settings action, starting a scan is an ordinary project
 * update. Resolving both against one permission would hand some viewers an
 * enabled button that is refused when pressed, and others a disabled one they
 * could have used.
 */
type RetryPermission = "projectSettingsEdit" | "projectUpdate";

/** A resolved gate for one capability. */
export interface CapabilityGate {
	capabilityKey: string;
	state: CapabilityState;
	/**
	 * Why, in a form the UI can map to copy and a test can assert on.
	 * `null` only when the state is `AVAILABLE`.
	 */
	reasonKey: string | null;
	/**
	 * The specific prerequisite that produced this state, named.
	 *
	 * The requirements are explicit that a composite message must name what is
	 * missing rather than announce a verdict, so this is never optional for a
	 * non-available gate: "Do Both is not ready" helps nobody, "connect a
	 * project management system first" does.
	 */
	blockingDependency: string | null;
	remedy: RemedyKind | null;
	retry: RetryAffordance;
	/** True when suppression is currently hiding this warning from this viewer. */
	suppressed: boolean;
	/**
	 * The facts this gate's rule read, in the form a suppression is matched
	 * against. Carried on the gate so a client-held dismissal — one that lives
	 * only for the browser session — can come back on exactly the same material
	 * change a stored one does.
	 */
	fingerprint: string;
}

/**
 * How much usable context a generating capability believes it has.
 *
 * Declared now, unused in v1. The requirements forbid this feature from
 * implementing its own sufficiency model and tell it to consume a signal the
 * generating capability returns; no generator produces one yet. Defining the
 * seam here means the first one that does can be read without a redesign, while
 * v1 decides warn-versus-block from explicit minimum-dependency rules only.
 */
type SufficiencySignal = "sufficient" | "thin-but-usable" | "insufficient";

/**
 * A background job's state as far as gating cares.
 *
 * Deliberately flattened away from any one table. Three different mechanisms
 * back the surfaces this feature gates — background-job rows, Atlas's own
 * analysis record, and project scans — and they disagree about almost
 * everything except this shape. Normalising at the evidence boundary keeps the
 * rules from growing a branch per source.
 */
export interface JobSnapshot {
	/** A run is currently in flight. */
	running: boolean;
	/**
	 * The clock this source's staleness is measured from.
	 *
	 * Not always a heartbeat: background-job rows carry one, project scans do
	 * not and are measured from when they started. A source whose clock cannot
	 * be read is never treated as stalled — an unknown age is not evidence of
	 * death.
	 */
	lastProgressAt: Date | null;
	/** The most recent run finished in a failed or timed-out state. */
	lastRunFailed: boolean;
}

/**
 * The codebase predicate, split in two on purpose.
 *
 * Collapsing these is the single most expensive mistake available here, and it
 * has already been made twice on the readiness checklist. A re-index that fails
 * does not take away the snapshot the project is being served from right now:
 * Atlas keeps its last-good graph and answers questions from it. If `usable`
 * and `healthy` are one boolean, the strictest-first composite hard-blocks
 * those projects at the exact moment their Atlas tab is working.
 *
 * So: `usable` answers "may a dependent capability run", and keys on the
 * durable fact — an index completed at some point and its output survived.
 * `healthy` answers "what should we tell them", and keys on the latest outcome
 * and the connection's own status. Good snapshot plus failed refresh is a
 * warning, not a block.
 */
interface CodebaseEvidence {
	/** A repository is attached to this project at all. */
	connected: boolean;
	/**
	 * Whether anything would ever index this repository: the deployment's
	 * code-indexing switch AND the project's own code-search setting. The
	 * setting defaults off, so on most projects nothing runs, and a gate that
	 * waited for an index there would wait forever.
	 */
	indexingEnabled: boolean;
	/**
	 * The deployment half of `indexingEnabled` on its own: whether code
	 * indexing exists here at all. When it does not, the project's own
	 * setting is not the remedy, and the gate must not say it is.
	 */
	indexingAvailable: boolean;
	/** Durable: a full index completed and its output is still there. */
	usable: boolean;
	/** Transient: the latest run succeeded and the credential still works. */
	healthy: boolean;
	/**
	 * `null` when no repository is connected — distinct from `ACTIVE`, because
	 * "nothing to be wrong with" and "known good" lead to different copy.
	 */
	integrationStatus: RepositoryIntegrationStatus | null;
	indexing: JobSnapshot;
	/**
	 * When a full index last completed, across the project's repositories.
	 * Not a usability fact — `usable` is that — but a completion marker: a
	 * dismissed stale-index warning has to come back after a later run
	 * succeeds and a still later one fails, and nothing else in this bundle
	 * moves between those two moments.
	 */
	lastIndexCompletedAt: Date | null;
	/**
	 * The repository integration a codebase retry should re-index, or `null`
	 * when there is none to name (a project attached only through the legacy
	 * column has no integration row to target).
	 */
	retryTargetId: string | null;
	/**
	 * Atlas's own graph is built and serving. A separate pipeline from the
	 * code index, and read only when the caller asked for Atlas's verdict —
	 * `false` otherwise, which means "not asked", never "known not ready".
	 */
	graphReady: boolean;
}

/**
 * Everything the rules are allowed to read, gathered once per request in a
 * fixed number of aggregate queries.
 *
 * Rules receive this and nothing else — they cannot issue their own queries,
 * which keeps the per-rule cost at zero and makes every rule testable against a
 * plain object with no database in sight.
 *
 * Note what is absent, and note that the absence is the point: there is no
 * field here for a checklist item state, a snooze, or a readiness level. A rule
 * cannot consult what it cannot see.
 */
export interface CapabilityEvidence {
	projectId: string;
	/** Resolved once for the viewer, not per rule. */
	viewer: {
		/** Holds PROJECT_SETTINGS_EDIT — what re-indexing a repository needs. */
		canEditProjectSettings: boolean;
		/** Holds PROJECT_UPDATE — what starting a scan needs. */
		canUpdateProject: boolean;
	};
	codebase: CodebaseEvidence;
	/** Context sources that finished ingestion successfully, by kind. */
	context: {
		total: number;
		/** Sources of a kind that can ground an architecture or technical answer. */
		technical: number;
		/** Sources describing product intent — notes, transcripts, proposals. */
		product: number;
		/** Ingestion currently running for at least one source. */
		processing: JobSnapshot;
		/** At least one source failed ingestion and is therefore not usable. */
		hasFailedSource: boolean;
		/**
		 * Sources of each kind still being ingested. A generator whose only
		 * source is one of these is waiting for it, not missing one — and the
		 * right thing to show is that it is on its way, not "add a source".
		 */
		technicalInFlight: number;
		productInFlight: number;
	};
	/** Document types that exist AND hold content, so they can ground a generation. */
	documents: {
		usableTypes: ReadonlySet<string>;
		/** Types with a generation queued or running right now. */
		inFlightTypes: ReadonlySet<string>;
		generating: JobSnapshot;
	};
	/** The project's own description, the cheapest grounding of all. */
	descriptionLength: number;
	/**
	 * Security and accessibility scanning, plus whether it needs a repository.
	 *
	 * `requiresCodebase` exists because the obvious reading of the requirement
	 * would delete a working feature. A scan runs up to four engines, and the
	 * two that are on by default are AI reviewers over documents and features —
	 * they read no code at all. Only the Semgrep SAST scan and the git-history
	 * secret scan touch the repository, and both are opt-in and off by default.
	 *
	 * So gating every scan on a connected codebase would take spec review away
	 * from precisely the projects that have nothing but specs, which is the
	 * opposite of what this suite is for. The gate asks about the repository
	 * only when an engine that reads it has been switched on.
	 */
	scan: JobSnapshot & { requiresCodebase: boolean };
	/**
	 * Optional, and optional on purpose — see `SufficiencySignal`. A rule that
	 * finds nothing here falls back to its explicit minimum-dependency rule,
	 * which is what every v1 rule does.
	 */
	sufficiency?: Partial<Record<string, SufficiencySignal>>;
}

/**
 * One row of the approved gating matrix, in code.
 *
 * The pairing with a named test is the point: `registry.ts` holds one entry per
 * matrix row and `__tests__/registry.test.ts` holds one test per entry, so a
 * rule cannot quietly drift from the specification without a named failure.
 */
export interface CapabilityRule {
	key: string;
	/** Human-readable, used in messages and in the test names. */
	label: string;
	/**
	 * The surface this capability lives on. Lets one page ask for its own gates
	 * without resolving the whole matrix.
	 */
	surface: CapabilitySurface;
	/**
	 * Resolve this capability against the evidence.
	 *
	 * Returns the state plus the named cause. Pure: no clock reads beyond the
	 * `now` handed in, no queries, no randomness — so a frozen-clock test is
	 * exact rather than approximate.
	 */
	evaluate: (evidence: CapabilityEvidence, now: Date) => RuleVerdict;
	/**
	 * The facts this rule reads, as the parts of its suppression fingerprint.
	 *
	 * Per rule rather than one global string, because a global one moves when
	 * ANY fact moves: adding a context source would resurrect a stale-index
	 * warning on the security page, which reads no context at all.
	 */
	fingerprint: (evidence: CapabilityEvidence) => readonly string[];
}

/** What a rule returns, before suppression is applied. */
export interface RuleVerdict {
	state: CapabilityState;
	reasonKey: string | null;
	blockingDependency: string | null;
	remedy: RemedyKind | null;
	retry?: Partial<Omit<RetryAffordance, "permitted">> & {
		/** Which permission the re-run's own door checks. */
		requires: RetryPermission;
	};
}

export type CapabilitySurface =
	| "documents"
	| "context"
	| "atlas"
	| "security"
	| "release-notes"
	| "settings";
