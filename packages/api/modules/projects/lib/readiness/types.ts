/**
 * Project readiness checklist — shared types (Fizzy #2165).
 *
 * The one invariant worth stating up front: **completion is never stored**. It is
 * derived from live project state on every read, so a readiness level can never
 * drift from what the project actually looks like. The only persisted things are
 * the states a person chose deliberately (snooze / not applicable / help
 * requested) and the previous verdict, which exists solely so "recently
 * completed" is answerable — derivation alone only ever sees the present.
 */

import type {
	ProjectPhase,
	ProjectReadinessItemStateValue,
} from "@repo/database";

/** How much a given item matters in a given phase. */
export type NeedLevel = "MUST" | "SHOULD" | "COULD" | "NOT_APPLICABLE";

/** Grouping used for display order and section headings in the panel. */
type ReadinessCategory =
	| "PROJECT_BASICS"
	| "CONTEXT_AND_CONNECTIONS"
	| "DOCUMENTS"
	| "ROADMAP"
	| "MEMBERS"
	| "AUTOMATION"
	| "VALUABLE_FEATURES";

/**
 * Where the item's call-to-action sends the user. Settings sub-tabs are not
 * URL-addressable (only the newsletter tab accepts an incoming deep link), so
 * these are resolved by the in-app navigation helper rather than by href.
 */
type ReadinessTarget =
	| { kind: "tab"; tab: string }
	| { kind: "settings"; subTab: string };

/** The three levels a project rolls up to. */
export type ReadinessLevel = "NOT_READY" | "PARTIALLY_READY" | "READY";

/**
 * Where the phase being graded against came from.
 *
 * `set` — somebody chose it. `inferred` — nobody has, so it was worked out from
 * the project's own state. The distinction is surfaced in the UI rather than
 * hidden: an assumed phase that looks identical to a chosen one is precisely how
 * a requirement acquires false authority.
 */
export type PhaseSource = "set" | "inferred";

/**
 * Everything the 26 rules are allowed to read, gathered once per request in a
 * fixed number of aggregate queries. Rules receive this and nothing else — they
 * cannot issue their own queries, which is what keeps the per-rule cost at zero
 * and makes every rule trivially unit-testable against a plain object.
 */
export interface ReadinessEvidence {
	phase: ProjectPhase | null;
	expectedDevelopmentStartDate: Date | null;
	/**
	 * Length of the project description. The sheet's rule is "greater than 50
	 * characters" — a length rather than a boolean, because a one-word
	 * description passes "exists" while telling Fabric nothing.
	 */
	descriptionLength: number;

	/**
	 * Work already underway that will satisfy an item once it lands.
	 *
	 * The sheet's Definitions tab lists **In Progress** as an item state, and
	 * the 20 August walkthrough asked for it in as many words — "it may need to
	 * scan, so there's like an in-progress kind of state". Without it, doing the
	 * thing and watching the row sit there unchanged is indistinguishable from
	 * the action having failed.
	 */
	inFlight: {
		/**
		 * Context sources still PENDING or EXTRACTING, cut the same four ways
		 * as `indexedContext`.
		 *
		 * Deliberately mirrored: an item may only claim to be In Progress about
		 * work that would actually satisfy IT. A project-wide count says a wiki
		 * is being scanned because someone pasted a marketing link, which is a
		 * lie the user cannot check.
		 */
		context: {
			total: number;
			meetingTranscripts: number;
			knowledgeBaseLinks: number;
			notionSources: number;
		};
		/** A full or refresh index currently running. */
		codebaseIndexing: boolean;
		/** Document types with a row still generating. */
		documentTypes: ReadonlySet<string>;
		/** A security scan currently running. */
		scan: boolean;
	};

	/** Free-form project metadata the Overview tab collects. */
	featureCount: number;
	techStackCount: number;

	/** Context sources that finished extraction successfully, by kind. */
	indexedContext: {
		total: number;
		meetingTranscripts: number;
		/** LINK sources categorised as a knowledge base / wiki. */
		knowledgeBaseLinks: number;
		/** INTEGRATION rows for a wiki provider that actually ingests. */
		notionSources: number;
	};

	/** Chat and transcript capture configuration. */
	chat: {
		slackConnected: boolean;
		teamsConnected: boolean;
		slackChannelMonitorEnabled: boolean;
		teamsChannelMonitorEnabled: boolean;
		teamsChatMonitorEnabled: boolean;
		transcriptAutoAnalyzeEnabled: boolean;
	};

	/** Project-management connection and sync configuration. */
	pm: {
		/** A PM system is selected on the project. */
		connected: boolean;
		/** Outbound writes are enabled — connection alone does not sync. */
		autoPushEnabled: boolean;
		/** Read-only mode blocks every outbound write regardless of auto-push. */
		readOnlyMode: boolean;
		autoCloseEnabled: boolean;
		terminalStatusCount: number;
	};

	/** Codebase connection and the outcome of the latest analysis. */
	code: {
		repositoryConnected: boolean;
		analysisCompleted: boolean;
		/** An Atlas graph exists for this project. */
		atlasAnalysisExists: boolean;
	};

	/**
	 * Documents that exist AND are usable — the 19 August tightening. A row with
	 * no readable content does not count, and neither does one in `GENERATING`
	 * or `FAILED` that has never held any: nothing has been produced yet. A
	 * re-run over a document that already has content does count, because that
	 * content is still the project's document — see `evidence.ts`.
	 */
	completeDocumentTypes: Set<string>;

	/** Members whose invitation has been accepted; pending invites do not count. */
	acceptedMemberCount: number;

	/** Live, non-archived work items on the roadmap. */
	roadmapItemCount: number;

	/** At least one security scan has finished successfully. */
	successfulScanExists: boolean;

	/** Release-notes newsletter is switched on. */
	newsletterEnabled: boolean;
}

/** One entry in the rule registry — the code form of a spreadsheet row. */
export interface ReadinessRule {
	/** Stable identifier. Never a display string; copy can change freely. */
	key: string;
	category: ReadinessCategory;
	/** Translation key for the item name, short description and tooltip. */
	i18nKey: string;
	ctaLabelKey: string;
	target: ReadinessTarget;
	needLevel: Record<ProjectPhase, NeedLevel>;
	/** Keys this item is only meaningful once satisfied. */
	dependsOn?: string[];
	/**
	 * Keys that make this item unnecessary when they are complete. Any one of
	 * them is enough — the sheet's supersession cells are all disjunctions.
	 */
	supersededBy?: string[];
	detect: (evidence: ReadinessEvidence) => boolean;
	/**
	 * Whether the work that satisfies this item is already running.
	 *
	 * Only consulted while the item is incomplete. Omit it for rules whose
	 * satisfying action is instantaneous — there is no meaningful window during
	 * which "add a team member" is in progress.
	 */
	inProgress?: (evidence: ReadinessEvidence) => boolean;
}

/** A rule plus everything computed about it for one project and one viewer. */
export interface ResolvedReadinessItem {
	key: string;
	category: ReadinessCategory;
	i18nKey: string;
	ctaLabelKey: string;
	target: ReadinessTarget;
	needLevel: NeedLevel;
	/** True when detection passed, or a supersession made it unnecessary. */
	isComplete: boolean;
	/**
	 * Something is running that will complete this item. Never true alongside
	 * `isComplete` — once the work lands, the item is simply done.
	 */
	isInProgress: boolean;
	/** Set when completion came from supersession rather than detection. */
	supersededBy?: string;
	/** The manual state a person put this item in, if any. */
	manualState: ProjectReadinessItemStateValue | null;
	snoozeUntil: Date | null;
	/** False when a dependency is unmet — the panel does not show it. */
	isVisible: boolean;
	/**
	 * True when this item is an unmet Must or Should for the active phase, i.e.
	 * something the project genuinely still owes. Snoozed items are excluded.
	 */
	isActiveGap: boolean;
}
