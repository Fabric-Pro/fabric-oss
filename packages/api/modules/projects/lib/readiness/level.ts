/**
 * Readiness resolution and level calculation (Fizzy #2165).
 *
 * Pure: no database, no clock beyond the `now` passed in. Every product decision
 * that is still open with the PO lands in this one file precisely so that a
 * different ruling costs one file and its table tests, not a rewrite.
 *
 * The four decisions encoded here, and what each fixes:
 *
 *  1. **Not Applicable cascades.** Dependencies control visibility, never
 *     completion, and nothing made a dependent item resolve when its dependency
 *     was marked not applicable. Four Development-phase Must items depend on
 *     Should items the sheet itself calls often-unavailable, so a project with
 *     no PM tool, no chat app and no transcripts could never reach Ready no
 *     matter what the user did. An item is also capped at its dependency's need
 *     level: nothing can be more required than the thing it needs.
 *
 *  2. **Snooze is personal, Not Applicable is project-wide.** A snooze quiets one
 *     person's reminder; it must not silently change what teammates see. Not
 *     applicable is a statement about the project, so it applies to everyone.
 *
 *  3. **A phase is inferred when nobody has chosen one, never withheld.** The
 *     card's migration plan is explicit — "missing project phase should default
 *     to Discovery / Planning until updated" — and an earlier cut of this file
 *     deviated from it by refusing to grade at all. That made the feature
 *     invisible on every project that predates it, which is all of them.
 *
 *     The fix is not a blind default either: a two-year-old codebase graded as
 *     Discovery reads "no Proposal document" and is noise. So the phase is
 *     inferred from the project's own evidence, falling back to the card's
 *     Discovery default when there is no signal. The result is reported as
 *     `inferred` so the UI can say so and offer to correct it, and it is never
 *     written to the database — `projectPhase` keeps meaning "somebody decided".
 *
 *  4. **The calculation only sees what the panel can show.** An item hidden by an
 *     unmet dependency is not counted as a gap — a project must never sit below
 *     Ready on something the user cannot see or act on.
 */

import type {
	ProjectPhase,
	ProjectReadinessItemStateValue,
} from "@repo/database";
import { READINESS_RULES } from "./registry";
import type {
	NeedLevel,
	PhaseSource,
	ReadinessEvidence,
	ReadinessLevel,
	ResolvedReadinessItem,
} from "./types";

/**
 * Work out which checklist applies when nobody has said.
 *
 * Deliberately self-consistent: the signals that imply Development — a connected
 * codebase, work on the roadmap — are themselves Development items, so inferring
 * from them never invents a gap out of the evidence used to infer. A project
 * with neither signal falls back to Discovery / Planning, which is the card's
 * stated default.
 */
function inferPhase(evidence: ReadinessEvidence): ProjectPhase {
	const looksLikeDevelopment =
		evidence.code.repositoryConnected || evidence.roadmapItemCount > 0;
	return looksLikeDevelopment
		? "DEVELOPMENT_EXECUTION"
		: "DISCOVERY_PLANNING";
}

/** A persisted manual state row, reduced to what the calculation needs. */
export interface ManualStateInput {
	itemKey: string;
	state: ProjectReadinessItemStateValue;
	snoozeUntil: Date | null;
	/** Null for the project-wide rows; set for one person's snooze. */
	personalForUserId: string | null;
}

export interface ResolveInput {
	evidence: ReadinessEvidence;
	manualStates: readonly ManualStateInput[];
	/** Whose view this is — decides which snoozes apply. */
	viewerUserId: string;
	now: Date;
}

export interface ReadinessSummary {
	level: ReadinessLevel;
	/** The phase actually graded against. */
	phase: ProjectPhase;
	/** Whether that phase was chosen or worked out. */
	phaseSource: PhaseSource;
	items: ResolvedReadinessItem[];
	/** Must/Should items for the phase that are still owed. Snoozed excluded. */
	activeGaps: ResolvedReadinessItem[];
	completedCount: number;
	/** Not-applicable items are excluded from the denominator. */
	totalCount: number;
	/**
	 * Discovery / Planning has nothing left owed, so the sheet's UI Draft asks
	 * us to offer the next phase rather than leaving a project sitting at Ready
	 * against a checklist it has outgrown. Only ever a suggestion — the phase is
	 * the user's to set.
	 */
	suggestPhaseTransition: boolean;
}

/**
 * The codebase item and everything that hangs off it. Kept beside the rule that
 * uses it rather than derived from `dependsOn`, because "de-emphasise while
 * development is still ahead" is a statement about these items specifically,
 * not about dependency structure in general.
 */
const CODEBASE_DEPENDENT: ReadonlySet<string> = new Set([
	"codebase-connected",
	"release-notes",
	"atlas-explored",
	"security-scan",
]);

const NEED_ORDER: Record<NeedLevel, number> = {
	NOT_APPLICABLE: 0,
	COULD: 1,
	SHOULD: 2,
	MUST: 3,
};

/** Decision 1 — an item can never be more required than its dependency. */
function capNeedLevel(own: NeedLevel, dependency: NeedLevel): NeedLevel {
	return NEED_ORDER[dependency] < NEED_ORDER[own] ? dependency : own;
}

export function resolveReadiness(input: ResolveInput): ReadinessSummary {
	const { evidence, manualStates, viewerUserId, now } = input;

	// Decision 3 — grade every project. When no phase was chosen, infer one from
	// the project's own state rather than withholding the checklist entirely.
	const phase: ProjectPhase = evidence.phase ?? inferPhase(evidence);
	const phaseSource: PhaseSource = evidence.phase ? "set" : "inferred";

	// Decision 2 — project-wide rows apply to everyone; a snooze applies only to
	// the person who set it. An expired snooze is simply not applied.
	const projectWide = new Map<string, ManualStateInput>();
	const personalSnoozes = new Map<string, ManualStateInput>();
	for (const row of manualStates) {
		if (row.personalForUserId === null) {
			projectWide.set(row.itemKey, row);
		} else if (
			row.personalForUserId === viewerUserId &&
			row.state === "SNOOZED" &&
			(row.snoozeUntil === null || row.snoozeUntil > now)
		) {
			personalSnoozes.set(row.itemKey, row);
		}
	}

	const explicitlyNotApplicable = new Set(
		[...projectWide.entries()]
			.filter(([, row]) => row.state === "NOT_APPLICABLE")
			.map(([key]) => key),
	);

	// Decision 1, first half — not applicable CASCADES.
	//
	// Marking a prerequisite not applicable has to resolve the items that hang
	// off it, not merely reveal them. Without this, a project with no PM tool
	// could mark "PM system connected" not applicable and still be left holding
	// two Development-phase Must items it has no way to complete, permanently
	// below Ready. Four Musts sit in exactly that position.
	//
	// `dependsOn` is a disjunction, so an item only cascades when EVERY listed
	// dependency is not applicable — one live route to satisfying it is enough
	// to keep it in play. Iterated to a fixpoint because cascades chain: chat app
	// → work capture from chat, PM system → sync → terminal statuses.
	const notApplicable = new Set(explicitlyNotApplicable);
	for (;;) {
		let grew = false;
		for (const rule of READINESS_RULES) {
			if (notApplicable.has(rule.key) || !rule.dependsOn?.length) {
				continue;
			}
			if (rule.dependsOn.every((key) => notApplicable.has(key))) {
				notApplicable.add(rule.key);
				grew = true;
			}
		}
		if (!grew) {
			break;
		}
	}

	// Raw detection first — supersession and cascade both need to know which
	// items passed on their own merits.
	const detected = new Map<string, boolean>();
	for (const rule of READINESS_RULES) {
		detected.set(rule.key, rule.detect(evidence));
	}

	// An item counts as satisfied for the purposes of OTHER items when it was
	// detected complete, superseded, or explicitly marked not applicable.
	// Decision 1 is exactly this last clause: without it, marking a prerequisite
	// not applicable leaves its dependents permanently unreachable.
	const satisfied = (key: string): boolean => {
		if (notApplicable.has(key)) {
			return true;
		}
		if (detected.get(key)) {
			return true;
		}
		const rule = READINESS_RULES.find((r) => r.key === key);
		return (
			rule?.supersededBy?.some((other) => detected.get(other) === true) ??
			false
		);
	};

	const items: ResolvedReadinessItem[] = [];

	/**
	 * The sheet asks for Expected Development Start Date so that
	 * "codebase-related readiness items can be snoozed or de-emphasized until
	 * development is expected to begin" — the same thing Codebase connected's
	 * Superseded By cell means by "Expected Development Start Date in future may
	 * snooze".
	 *
	 * De-emphasised, not snoozed: a snooze is something a person did, it expires,
	 * and it shows in the UI as their decision. Writing one nobody chose would
	 * misreport who deferred what. Dropping the need to COULD keeps the items
	 * visible and honest — still there, no longer nagging — and they return to
	 * their real level the day development is due.
	 */
	const developmentNotDueYet =
		phase === "DISCOVERY_PLANNING" &&
		evidence.expectedDevelopmentStartDate !== null &&
		evidence.expectedDevelopmentStartDate > now;

	for (const rule of READINESS_RULES) {
		let needLevel = rule.needLevel[phase];

		if (developmentNotDueYet && CODEBASE_DEPENDENT.has(rule.key)) {
			needLevel = capNeedLevel(needLevel, "COULD");
		}

		// `dependsOn` is a disjunction — any one satisfied dependency is enough.
		const hasDependencies = (rule.dependsOn?.length ?? 0) > 0;
		const dependencyMet =
			!hasDependencies ||
			(rule.dependsOn ?? []).some((key) => satisfied(key));

		// Decision 1, second half — cap by the strongest need level among the
		// dependencies that could satisfy this item.
		if (hasDependencies) {
			const dependencyNeed = (rule.dependsOn ?? []).reduce<NeedLevel>(
				(strongest, key) => {
					const dep = READINESS_RULES.find((r) => r.key === key);
					const level = dep?.needLevel[phase] ?? "NOT_APPLICABLE";
					return NEED_ORDER[level] > NEED_ORDER[strongest]
						? level
						: strongest;
				},
				"NOT_APPLICABLE",
			);
			needLevel = capNeedLevel(needLevel, dependencyNeed);
		}

		const supersededByKey = rule.supersededBy?.find(
			(other) => detected.get(other) === true,
		);
		const wasDetected = detected.get(rule.key) === true;
		const isNotApplicable = notApplicable.has(rule.key);
		const isComplete = wasDetected || supersededByKey !== undefined;

		const projectWideRow = projectWide.get(rule.key);
		const personalSnooze = personalSnoozes.get(rule.key);
		const manualState: ProjectReadinessItemStateValue | null =
			personalSnooze ? "SNOOZED" : (projectWideRow?.state ?? null);

		// Decision 4 — an item whose dependency is unmet is not shown, and
		// therefore is not counted anywhere below.
		const isVisible = dependencyMet;

		// An item is In Progress only while it is still incomplete: once the
		// scan or the generation lands, "done" is the whole story.
		const isInProgress =
			!isComplete &&
			!isNotApplicable &&
			(rule.inProgress?.(evidence) ?? false);

		const counts =
			isVisible && needLevel !== "NOT_APPLICABLE" && !isNotApplicable;

		const isActiveGap =
			counts &&
			!isComplete &&
			(needLevel === "MUST" || needLevel === "SHOULD") &&
			manualState !== "SNOOZED";

		items.push({
			key: rule.key,
			category: rule.category,
			i18nKey: rule.i18nKey,
			ctaLabelKey: rule.ctaLabelKey,
			target: rule.target,
			needLevel,
			isComplete: isComplete || isNotApplicable,
			isInProgress,
			supersededBy: supersededByKey,
			manualState,
			snoozeUntil: personalSnooze?.snoozeUntil ?? null,
			isVisible,
			isActiveGap,
		});
	}

	const counted = items.filter(
		(item) =>
			item.isVisible &&
			item.needLevel !== "NOT_APPLICABLE" &&
			!notApplicable.has(item.key),
	);

	const activeGaps = items.filter((item) => item.isActiveGap);

	// A snoozed Must or Should holds the project at Partially Ready — it does not
	// let it through to Ready. Snoozing quiets a reminder; it does not resolve
	// anything, and without this a project could reach Ready with every Must
	// snoozed.
	const snoozedBlocking = counted.some(
		(item) =>
			item.manualState === "SNOOZED" &&
			!item.isComplete &&
			(item.needLevel === "MUST" || item.needLevel === "SHOULD"),
	);

	const mustGapExists = activeGaps.some((item) => item.needLevel === "MUST");
	const shouldGapExists = activeGaps.some(
		(item) => item.needLevel === "SHOULD",
	);

	let level: ReadinessLevel;
	if (mustGapExists) {
		level = "NOT_READY";
	} else if (shouldGapExists || snoozedBlocking) {
		level = "PARTIALLY_READY";
	} else {
		level = "READY";
	}

	// "All Must and Should items complete, not applicable, or superseded, and no
	// Must or Should snoozed" is precisely the test that produces READY — the
	// snooze clause is already in `snoozedBlocking`. Restricting it to Discovery
	// is the whole rule.
	const suggestPhaseTransition =
		phase === "DISCOVERY_PLANNING" && level === "READY";

	return {
		level,
		phase,
		phaseSource,
		items,
		activeGaps,
		completedCount: counted.filter((item) => item.isComplete).length,
		totalCount: counted.length,
		suggestPhaseTransition,
	};
}
