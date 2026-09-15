import {
	DELIVERY_TRACK_META,
	DELIVERY_TRACK_ORDER,
	DELIVERY_TRACK_TONE_CLASSES,
	type DeliveryTrack,
	type UserStory,
} from "./stories/types";

export const PRIORITY_SECTIONS = [
	{ priority: "P0_CRITICAL" as const, label: "Critical", color: "#EF4444" },
	{ priority: "P1_HIGH" as const, label: "High", color: "#F97316" },
	{ priority: "P2_MEDIUM" as const, label: "Medium", color: "#EAB308" },
	{ priority: "P3_LOW" as const, label: "Low", color: "#22C55E" },
] as const;

export type PriorityKey = (typeof PRIORITY_SECTIONS)[number]["priority"];

// Deterministic comparator: roadmapOrder, then id. CUIDs are time-ordered,
// so the id fallback also approximates "oldest first" when two stories
// collide via the Read Committed max+1 race in updateStory.
function compareRoadmap(a: UserStory, b: UserStory): number {
	const d = a.roadmapOrder - b.roadmapOrder;
	if (d !== 0) {
		return d;
	}
	// Locale-free string comparison: deterministic across environments and runtimes.
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function groupStoriesByPriority(
	stories: UserStory[],
	showClosed = false,
): Record<PriorityKey, UserStory[]> {
	const filtered = stories.filter(
		(s) =>
			s.draftingStage !== "DECLINED" &&
			(showClosed || s.draftingStage !== "CLOSED"),
	);
	return {
		P0_CRITICAL: filtered
			.filter((s) => s.priority === "P0_CRITICAL")
			.sort(compareRoadmap),
		P1_HIGH: filtered
			.filter((s) => s.priority === "P1_HIGH")
			.sort(compareRoadmap),
		P2_MEDIUM: filtered
			.filter((s) => s.priority === "P2_MEDIUM")
			.sort(compareRoadmap),
		P3_LOW: filtered
			.filter((s) => s.priority === "P3_LOW")
			.sort(compareRoadmap),
	};
}

export type RoadmapGroupBy = "priority" | "track" | "phase";

export const TRACK_SECTIONS = DELIVERY_TRACK_ORDER.map((track) => ({
	track,
	label: DELIVERY_TRACK_META[track].label,
	tone: DELIVERY_TRACK_META[track].tone,
	dotClass: DELIVERY_TRACK_TONE_CLASSES[DELIVERY_TRACK_META[track].tone].dot,
}));

/**
 * Group stories by delivery track, mirroring `groupStoriesByPriority`.
 * Lane order: SPIKE, DISCOVERY, SPECIFY, UNCLASSIFIED, DEFER; stories inside
 * a lane are sorted by `roadmapOrder`.
 */
export function groupStoriesByTrack(
	stories: UserStory[],
	showClosed = false,
): Record<DeliveryTrack, UserStory[]> {
	const filtered = stories.filter(
		(s) =>
			s.draftingStage !== "DECLINED" &&
			(showClosed || s.draftingStage !== "CLOSED"),
	);
	const grouped = {} as Record<DeliveryTrack, UserStory[]>;
	for (const track of DELIVERY_TRACK_ORDER) {
		grouped[track] = filtered
			.filter((s) => (s.deliveryTrack ?? "UNCLASSIFIED") === track)
			.sort((a, b) => a.roadmapOrder - b.roadmapOrder);
	}
	return grouped;
}

// ---- Phase × track grouping (inverted-loop Slice 7) ----

const PHASE_LABEL_PREFIX = "phase:";
const UNASSIGNED_PHASE = "unassigned";

/** Read the phase from a `phase:N` label; `null` when the story has none. */
export function phaseFromLabels(
	labels: readonly string[] | null | undefined,
): string | null {
	for (const label of labels ?? []) {
		if (label.startsWith(PHASE_LABEL_PREFIX)) {
			const phase = label.slice(PHASE_LABEL_PREFIX.length).trim();
			if (phase.length > 0) {
				return phase;
			}
		}
	}
	return null;
}

/**
 * The phase a story belongs to, read from its `phase:N` tag. fabric-dev strips
 * sync-owned `labels` before they reach the client, so the phase rides on
 * the user-facing StoryTag rows instead (scope intake writes them there).
 */
export function storyPhase(story: Pick<UserStory, "tags">): string {
	return phaseFromLabels(story.tags.map((t) => t.value)) ?? UNASSIGNED_PHASE;
}

function phaseLabel(phase: string): string {
	return phase === UNASSIGNED_PHASE ? "Unassigned" : `Phase ${phase}`;
}

function comparePhaseKeys(a: string, b: string): number {
	const na = Number(a);
	const nb = Number(b);
	const aNum = Number.isFinite(na);
	const bNum = Number.isFinite(nb);
	if (aNum && bNum) {
		return na - nb;
	}
	if (aNum) {
		return -1;
	}
	if (bNum) {
		return 1;
	}
	return a.localeCompare(b);
}

/**
 * Phase order: the project's quoted phases first (their configured order),
 * then any other phase numerically / lexically, `unassigned` last.
 */
export function orderPhases(
	phases: Iterable<string>,
	quotedPhases: readonly string[] = [],
): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const phase of quotedPhases) {
		if (!seen.has(phase)) {
			seen.add(phase);
			ordered.push(phase);
		}
	}
	const rest: string[] = [];
	let hasUnassigned = false;
	for (const phase of phases) {
		if (phase === UNASSIGNED_PHASE) {
			hasUnassigned = true;
			continue;
		}
		if (!seen.has(phase)) {
			seen.add(phase);
			rest.push(phase);
		}
	}
	rest.sort(comparePhaseKeys);
	ordered.push(...rest);
	if (hasUnassigned) {
		ordered.push(UNASSIGNED_PHASE);
	}
	return ordered;
}

export interface PhasePointTotals {
	/** Sum of every story's points. */
	points: number;
	/** Sum of the non-LOW stories' points (floor of the range). */
	confidentPoints: number;
	hasLowConfidence: boolean;
	storyCount: number;
}

export function sumPhasePoints(
	stories: readonly Pick<UserStory, "storyPoints" | "estimateConfidence">[],
): PhasePointTotals {
	const totals: PhasePointTotals = {
		points: 0,
		confidentPoints: 0,
		hasLowConfidence: false,
		storyCount: stories.length,
	};
	for (const story of stories) {
		if (story.estimateConfidence === "LOW") {
			totals.hasLowConfidence = true;
		}
		if (story.storyPoints == null) {
			continue;
		}
		totals.points += story.storyPoints;
		if (story.estimateConfidence !== "LOW") {
			totals.confidentPoints += story.storyPoints;
		}
	}
	return totals;
}

/** `12 pt`, or `8–12 pt` when any LOW-confidence story is in the group. */
export function formatPhasePoints(totals: PhasePointTotals): string {
	if (totals.hasLowConfidence) {
		return `${totals.confidentPoints}–${totals.points} pt`;
	}
	return `${totals.points} pt`;
}

interface PhaseTrackSection {
	track: DeliveryTrack;
	label: string;
	dotClass: string;
	stories: UserStory[];
}

export interface PhaseSection {
	phase: string;
	label: string;
	totals: PhasePointTotals;
	tracks: PhaseTrackSection[];
}

/**
 * Group stories by phase (`phase:N` label, else "unassigned"), each phase
 * split by delivery track in `DELIVERY_TRACK_ORDER`. Phases follow
 * `orderPhases(…, quotedPhases)`; empty tracks and empty phases are omitted
 * (a quoted phase with nothing in it still decides the order of the rest).
 * Stories inside a track are sorted by `roadmapOrder`.
 */
export function groupStoriesByPhaseAndTrack(
	stories: UserStory[],
	quotedPhases: readonly string[] = [],
	showClosed = false,
): PhaseSection[] {
	const filtered = stories.filter(
		(s) =>
			s.draftingStage !== "DECLINED" &&
			(showClosed || s.draftingStage !== "CLOSED"),
	);
	const byPhase = new Map<string, UserStory[]>();
	for (const story of filtered) {
		const phase = storyPhase(story);
		const bucket = byPhase.get(phase);
		if (bucket) {
			bucket.push(story);
		} else {
			byPhase.set(phase, [story]);
		}
	}
	const phases = orderPhases(byPhase.keys(), quotedPhases).filter((phase) =>
		byPhase.has(phase),
	);
	return phases.map((phase) => {
		const phaseStories = byPhase.get(phase) ?? [];
		const tracks: PhaseTrackSection[] = [];
		for (const section of TRACK_SECTIONS) {
			const trackStories = phaseStories
				.filter(
					(s) =>
						(s.deliveryTrack ?? "UNCLASSIFIED") === section.track,
				)
				.sort((a, b) => a.roadmapOrder - b.roadmapOrder);
			if (trackStories.length > 0) {
				tracks.push({
					track: section.track,
					label: section.label,
					dotClass: section.dotClass,
					stories: trackStories,
				});
			}
		}
		return {
			phase,
			label: phaseLabel(phase),
			totals: sumPhasePoints(phaseStories),
			tracks,
		};
	});
}

/** Sort index of a story's phase under `groupBy: "phase"`. */
export function phaseSortIndex(
	story: Pick<UserStory, "tags">,
	phaseOrder: readonly string[],
): number {
	const index = phaseOrder.indexOf(storyPhase(story));
	return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** The bucket a story lives in under the current grouping. */
export function getRoadmapBucketKey(
	story: Pick<UserStory, "priority" | "deliveryTrack" | "tags">,
	groupBy: RoadmapGroupBy,
): string {
	if (groupBy === "phase") {
		return `${storyPhase(story)}:${story.deliveryTrack ?? "UNCLASSIFIED"}`;
	}
	return groupBy === "track"
		? (story.deliveryTrack ?? "UNCLASSIFIED")
		: story.priority;
}

/**
 * Drag-and-drop is constrained to a single bucket: a story may be reordered
 * within its priority lane (or track lane) but never moved across lanes.
 */
export function isSameBucket(
	sourceBucket: string,
	targetBucket: string,
): boolean {
	return sourceBucket === targetBucket;
}

export function computeCrossBucketReorder(
	sortedStories: UserStory[],
	movedStoryId: string,
	targetPriority: PriorityKey,
	overStoryId: string,
): { id: string; roadmapOrder: number }[] {
	const targetBucket = sortedStories.filter(
		(s) => s.priority === targetPriority,
	);
	const insertIndex = targetBucket.findIndex((s) => s.id === overStoryId);
	const moved = sortedStories.find((s) => s.id === movedStoryId);
	if (!moved || insertIndex === -1) {
		return [];
	}
	const withoutMoved = targetBucket.filter((s) => s.id !== movedStoryId);
	const inserted = [
		...withoutMoved.slice(0, insertIndex),
		moved,
		...withoutMoved.slice(insertIndex),
	];
	return inserted.map((s, i) => ({ id: s.id, roadmapOrder: i + 1 }));
}
