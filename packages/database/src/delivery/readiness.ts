/**
 * Readiness policy — pure, no I/O.
 *
 * Decides whether a work item (UserStory) may reach `PUBLISHED` ("Ready for
 * Dev") or start an implementation run, given its delivery track, the
 * project's engagement profile, which gates the project has switched on, and
 * the evidence gathered so far.
 *
 * Every gap is computed twice: `missing` holds gaps whose enforcement flag is
 * ON (these block), `advisory` holds gaps whose flag is OFF (shown, never
 * block). This is what makes gates "advisory first, enforced per track by
 * flag" (plan §1.1).
 *
 * Fail closed: callers that cannot load evidence must pass
 * `evidenceUnavailable: true`, which marks the item not ready with a
 * dedicated gap instead of guessing.
 */

import type {
	DeliveryTrack,
	EngagementProfile,
} from "../../prisma/generated/enums";

export type ReadinessGap =
	| "UNCLASSIFIED"
	| "DEFERRED"
	| "SPIKE_NOT_ACCEPTED"
	| "INTEGRATION_CONTRACT_MISSING"
	| "DESCRIPTION_MISSING"
	| "ACCEPTANCE_CRITERIA_MISSING"
	| "EVIDENCE_UNAVAILABLE";

export interface ReadinessEnforcement {
	/** Description + acceptance criteria required for SPECIFY (and after SPIKE / DISCOVERY). */
	specify: boolean;
	/** An accepted Spike run required for SPIKE items. */
	spike: boolean;
	/** A COMPLETE integration contract required for DISCOVERY items. */
	discovery: boolean;
}

export interface ReadinessEvidence {
	/** Count of Spike runs on this story whose findings were accepted. */
	acceptedSpikeRuns: number;
	/** Whether an INTEGRATION_CONTRACT document for this story is COMPLETE. */
	integrationContractComplete: boolean;
	/** Set when evidence could not be loaded; forces not-ready. */
	evidenceUnavailable?: boolean;
}

export interface ReadinessStory {
	deliveryTrack: DeliveryTrack;
	description: string | null | undefined;
	acceptanceCriteria: string | null | undefined;
}

export interface ReadinessInput {
	story: ReadinessStory;
	profile: EngagementProfile;
	enforcement: ReadinessEnforcement;
	evidence: ReadinessEvidence;
}

export interface ReadinessResult {
	/** True when nothing in `missing` blocks. */
	ready: boolean;
	/** Gaps that block because their enforcement flag is on. */
	missing: ReadinessGap[];
	/** Gaps that are shown but do not block because their flag is off. */
	advisory: ReadinessGap[];
	/** The track the policy evaluated against (UNCLASSIFIED resolves to SPECIFY under GOVERNED). */
	effectiveTrack: DeliveryTrack;
}

const GAP_ORDER: readonly ReadinessGap[] = [
	"EVIDENCE_UNAVAILABLE",
	"DEFERRED",
	"UNCLASSIFIED",
	"SPIKE_NOT_ACCEPTED",
	"INTEGRATION_CONTRACT_MISSING",
	"DESCRIPTION_MISSING",
	"ACCEPTANCE_CRITERIA_MISSING",
];

function isBlank(value: string | null | undefined): boolean {
	if (value === null || value === undefined) return true;
	// TipTap JSON documents with no text still count as blank.
	const trimmed = value.trim();
	if (trimmed.length === 0) return true;
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			return !containsText(parsed);
		} catch {
			return false;
		}
	}
	return false;
}

function containsText(node: unknown): boolean {
	if (node === null || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (typeof record.text === "string" && record.text.trim().length > 0) {
		return true;
	}
	const content = record.content;
	if (Array.isArray(content)) {
		return content.some((child) => containsText(child));
	}
	return false;
}

/**
 * Resolve the track the policy should evaluate against.
 * UNCLASSIFIED under GOVERNED resolves to SPECIFY (plan §1.1).
 */
export function resolveEffectiveTrack(
	track: DeliveryTrack,
	profile: EngagementProfile,
): DeliveryTrack {
	if (track === "UNCLASSIFIED" && profile === "GOVERNED") {
		return "SPECIFY";
	}
	return track;
}

/**
 * Evaluate readiness. Pure: no I/O, no clock.
 */
export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
	const { story, profile, enforcement, evidence } = input;
	const effectiveTrack = resolveEffectiveTrack(story.deliveryTrack, profile);

	const blocking = new Set<ReadinessGap>();
	const advisory = new Set<ReadinessGap>();

	// Any enforcement flag on means "gates are on" for this project.
	const gatesOn =
		enforcement.specify || enforcement.spike || enforcement.discovery;

	const add = (gap: ReadinessGap, enforced: boolean) => {
		if (enforced) {
			blocking.add(gap);
		} else {
			advisory.add(gap);
		}
	};

	if (evidence.evidenceUnavailable) {
		// Fail closed regardless of flags: we cannot prove anything.
		blocking.add("EVIDENCE_UNAVAILABLE");
	}

	// DEFER never proceeds. This is enforced regardless of flags because a
	// deferred item has, by definition, been decided against for now.
	if (effectiveTrack === "DEFER") {
		blocking.add("DEFERRED");
	}

	if (effectiveTrack === "UNCLASSIFIED") {
		add("UNCLASSIFIED", gatesOn);
	}

	if (effectiveTrack === "SPIKE") {
		if (evidence.acceptedSpikeRuns < 1) {
			add("SPIKE_NOT_ACCEPTED", enforcement.spike);
		}
	}

	if (effectiveTrack === "DISCOVERY") {
		if (!evidence.integrationContractComplete) {
			add("INTEGRATION_CONTRACT_MISSING", enforcement.discovery);
		}
	}

	// Description + acceptance criteria are required on every non-deferred,
	// classified track once the track-specific evidence exists. For SPECIFY
	// this is the whole gate. For SPIKE / DISCOVERY the spec is written after
	// the run, so the content requirement is still governed by the SPECIFY
	// flag (plan §1.1 "then description + acceptance criteria").
	if (
		effectiveTrack === "SPECIFY" ||
		effectiveTrack === "SPIKE" ||
		effectiveTrack === "DISCOVERY"
	) {
		if (isBlank(story.description)) {
			add("DESCRIPTION_MISSING", enforcement.specify);
		}
		if (isBlank(story.acceptanceCriteria)) {
			add("ACCEPTANCE_CRITERIA_MISSING", enforcement.specify);
		}
	}

	const order = (gaps: Set<ReadinessGap>) =>
		GAP_ORDER.filter((g) => gaps.has(g));

	return {
		ready: blocking.size === 0,
		missing: order(blocking),
		advisory: order(advisory),
		effectiveTrack,
	};
}

/**
 * Stages a DEFER item may still move to. Everything else is blocked.
 */
export const DEFER_ALLOWED_TARGET_STAGES = new Set<string>([
	"DECLINED",
	"CLOSED",
	"PLACEHOLDER",
]);

/** Terminal / non-active stages that never require readiness. */
export const NON_GATED_TARGET_STAGES = new Set<string>([
	"PLACEHOLDER",
	"PASSIVE_ANALYSIS",
	"ACTIVE_ANALYSIS",
	"SANITY_CHECK",
	"DRAFT",
	"DECLINED",
	"CLOSED",
]);
