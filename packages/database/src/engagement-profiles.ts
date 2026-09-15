/**
 * Engagement profiles — how an engagement is run.
 *
 * A profile is a project-level setting that decides intake mode, the default
 * delivery track when the classifier is unsure, whether drafting-stage
 * transitions require review, which hierarchy levels the UI shows, and which
 * wizard steps apply. The same engine runs under every profile; the profile
 * only decides how much of it a given customer sees and how strict the gates
 * are.
 *
 * Plan: docs/features/inverted-loop-delivery-tracks.md §1.2
 *
 * Existing projects were backfilled to GOVERNED because it is the closest
 * match to the uniform gating that existed before profiles. Review of stage
 * transitions under GOVERNED is opt-in per project: it becomes effective only
 * once at least one ProjectStageApprover is configured, so the migration does
 * not change observable behaviour on its own.
 */

import { z } from "zod";
import type {
	DeliveryTrack,
	EngagementProfile,
} from "../prisma/generated/enums";

// The Prisma enums are the source of truth; these value lists mirror them for
// Zod input schemas and UI pickers. A compile-time check below fails if they
// drift.
export const ENGAGEMENT_PROFILE_VALUES = [
	"EXPLORE",
	"PROPOSAL",
	"GOVERNED",
	"DELEGATED",
] as const satisfies readonly EngagementProfile[];

export const engagementProfileSchema = z.enum(ENGAGEMENT_PROFILE_VALUES);

export const DELIVERY_TRACK_VALUES = [
	"UNCLASSIFIED",
	"SPIKE",
	"DISCOVERY",
	"SPECIFY",
	"DEFER",
] as const satisfies readonly DeliveryTrack[];

export const deliveryTrackSchema = z.enum(DELIVERY_TRACK_VALUES);

type _AssertProfilesComplete =
	EngagementProfile extends (typeof ENGAGEMENT_PROFILE_VALUES)[number]
		? true
		: never;
type _AssertTracksComplete =
	DeliveryTrack extends (typeof DELIVERY_TRACK_VALUES)[number] ? true : never;
const _profilesComplete: _AssertProfilesComplete = true;
const _tracksComplete: _AssertTracksComplete = true;
void _profilesComplete;
void _tracksComplete;

/** Tracks a human or the classifier may assign. UNCLASSIFIED is a state, not a choice. */
export const ASSIGNABLE_DELIVERY_TRACKS = [
	"SPIKE",
	"DISCOVERY",
	"SPECIFY",
	"DEFER",
] as const satisfies readonly DeliveryTrack[];

export type HierarchyLevel = "epic" | "feature" | "story";

export type IntakeMode = "conversation" | "document" | "handoff";

export type WizardStepSet = "explore" | "standard" | "codeBased";

export interface EngagementProfileConfig {
	/** Human-readable label for pickers. */
	label: string;
	/** One-line description shown next to the label. */
	description: string;
	/**
	 * Track applied when the classifier's confidence is below threshold.
	 * "CLASSIFIER" means keep the classifier's low-confidence answer as
	 * UNCLASSIFIED and let a human decide.
	 */
	defaultTrack: DeliveryTrack | "CLASSIFIER";
	/**
	 * Whether drafting-stage transitions create a StageTransitionRequest
	 * instead of applying immediately. Effective only when the project has at
	 * least one configured approver (see engagement-profiles.ts header).
	 */
	stageTransitionsRequireReview: boolean;
	/** Whether a Spike run may start without an approved transition. */
	spikesRequireReview: boolean;
	/** Hierarchy levels the project UI shows by default. */
	visibleHierarchy: readonly HierarchyLevel[];
	intakeMode: IntakeMode;
	wizardSteps: WizardStepSet;
	/** Kanban column template applied at project creation. */
	kanbanTemplateId: "default" | "scrum" | "delivery" | "discovery";
	/** Whether a customer-facing outcomes surface is generated for this profile. */
	customerOutcomesSurface: boolean;
}

export const ENGAGEMENT_PROFILES: Readonly<
	Record<EngagementProfile, EngagementProfileConfig>
> = Object.freeze({
	EXPLORE: {
		label: "Explore",
		description:
			"A hunch and no document. Start from a conversation, learn by building spikes.",
		defaultTrack: "SPIKE",
		stageTransitionsRequireReview: false,
		spikesRequireReview: false,
		visibleHierarchy: ["feature"],
		intakeMode: "conversation",
		wizardSteps: "explore",
		kanbanTemplateId: "discovery",
		customerOutcomesSurface: true,
	},
	PROPOSAL: {
		label: "Proposal",
		description:
			"A deck, RFP or scope table with open questions. Import, triage, spike the unknowns, quote the rest.",
		defaultTrack: "CLASSIFIER",
		stageTransitionsRequireReview: false,
		spikesRequireReview: false,
		visibleHierarchy: ["epic", "feature"],
		intakeMode: "document",
		wizardSteps: "standard",
		kanbanTemplateId: "default",
		customerOutcomesSurface: false,
	},
	GOVERNED: {
		label: "Governed",
		description:
			"Formal requirements and change control. Every stage transition is reviewed by a configured approver.",
		defaultTrack: "SPECIFY",
		stageTransitionsRequireReview: true,
		spikesRequireReview: true,
		visibleHierarchy: ["epic", "feature", "story"],
		intakeMode: "document",
		wizardSteps: "standard",
		kanbanTemplateId: "default",
		customerOutcomesSurface: false,
	},
	DELEGATED: {
		label: "Delegated",
		description:
			"Requirements handed over; the team owns delivery. The customer sees outcomes, not the backlog.",
		defaultTrack: "CLASSIFIER",
		stageTransitionsRequireReview: false,
		spikesRequireReview: false,
		visibleHierarchy: ["epic", "feature"],
		intakeMode: "handoff",
		kanbanTemplateId: "default",
		wizardSteps: "standard",
		customerOutcomesSurface: true,
	},
});

export function getEngagementProfileConfig(
	profile: EngagementProfile,
): EngagementProfileConfig {
	return ENGAGEMENT_PROFILES[profile];
}

/** Default profile for projects created through the wizard. */
export const DEFAULT_NEW_PROJECT_PROFILE: EngagementProfile = "PROPOSAL";
