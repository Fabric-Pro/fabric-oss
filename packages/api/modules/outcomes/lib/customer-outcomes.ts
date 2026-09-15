/**
 * Customer outcomes DTO (plan Slice 8, §1.2 DELEGATED / EXPLORE surface).
 *
 * This is the ONLY shape the customer audience ever receives. It is built
 * from an explicit field allowlist and deliberately contains:
 *   - no story / run / frame / user ids
 *   - no story descriptions or acceptance criteria
 *   - no user names or e-mail addresses
 *   - no frame link unless the frame itself is public (isPublic + shareToken)
 *
 * The customer never holds STORY_READ; hiding tabs is not authorization, so
 * the restriction lives here, in the projection, not in the UI.
 */
import { db } from "@repo/database";
import { getBaseUrl } from "@repo/utils";

interface OutcomeDecision {
	storyIdentifier: string;
	storyTitle: string;
	decidedAt: Date;
	summary: string;
}

interface OutcomeDemo {
	storyIdentifier: string;
	title: string;
	/** Present only when the demo frame is itself public. */
	frameShareUrl?: string;
}

interface OutcomeShipped {
	storyIdentifier: string;
	storyTitle: string;
	mergedAt: Date;
	pullRequestUrl: string;
}

interface OutcomeMetric {
	name: string;
	direction: "UP" | "DOWN";
	target: number | null;
	lastValue: number | null;
	previousValue: number | null;
	lastObservedAt: Date | null;
}

export interface CustomerOutcomesDto {
	projectName: string;
	visionPurpose: string | null;
	visionCoreActions: string[];
	visionCycle: string | null;
	decisions: OutcomeDecision[];
	demos: OutcomeDemo[];
	shipped: OutcomeShipped[];
	metrics: OutcomeMetric[];
}

/** Exact top-level keys of the DTO; tests assert nothing else leaks. */
export const CUSTOMER_OUTCOMES_DTO_KEYS = [
	"projectName",
	"visionPurpose",
	"visionCoreActions",
	"visionCycle",
	"decisions",
	"demos",
	"shipped",
	"metrics",
] as const;

const OUTCOMES_DECISION_CAP = 50;
const OUTCOMES_SHIPPED_CAP = 100;

/**
 * FeatureVersion change descriptions that count as customer-visible
 * decisions. Case-insensitive; "track" catches delivery-track rationale
 * snapshots written by the transition service.
 */
const DECISION_CHANGE_PATTERN =
	/Spike findings applied|Spike accepted|Approved transition|track/i;

const DECISION_CONTAINS = [
	"Spike findings applied",
	"Spike accepted",
	"Approved transition",
	"track",
] as const;

function trackLabel(track: string): string {
	return track.charAt(0) + track.slice(1).toLowerCase();
}

function buildFrameShareUrl(token: string): string {
	return `${getBaseUrl()}/share/frame/${token}`;
}

export function buildOutcomesShareUrl(token: string): string {
	return `${getBaseUrl()}/share/outcomes/${token}`;
}

/**
 * Builds the restricted DTO for a project. Callers are responsible for
 * authorization (token match or PROJECT_READ) — this function only projects.
 */
export async function buildCustomerOutcomes(
	projectId: string,
): Promise<CustomerOutcomesDto | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			id: true,
			name: true,
			visionPurpose: true,
			visionCoreActions: true,
			visionCycle: true,
		},
	});
	if (!project) {
		return null;
	}

	const [versionRows, trackRows, spikeRuns, mergedRuns, metricRows] =
		await Promise.all([
			db.featureVersion.findMany({
				where: {
					story: { projectId },
					OR: DECISION_CONTAINS.map((needle) => ({
						changeDescription: {
							contains: needle,
							mode: "insensitive",
						},
					})),
				},
				orderBy: { createdAt: "desc" },
				take: OUTCOMES_DECISION_CAP,
				select: {
					createdAt: true,
					changeDescription: true,
					story: { select: { identifier: true, title: true } },
				},
			}),
			db.userStory.findMany({
				where: {
					projectId,
					trackSetBy: "HUMAN",
					trackUpdatedAt: { not: null },
				},
				orderBy: { trackUpdatedAt: "desc" },
				take: OUTCOMES_DECISION_CAP,
				select: {
					identifier: true,
					title: true,
					deliveryTrack: true,
					trackUpdatedAt: true,
				},
			}),
			db.codingRun.findMany({
				where: {
					projectId,
					kind: "SPIKE",
					status: "COMPLETED",
					demoFrameId: { not: null },
				},
				orderBy: { updatedAt: "desc" },
				select: {
					demoFrameId: true,
					story: { select: { identifier: true, title: true } },
				},
			}),
			db.codingRun.findMany({
				where: { projectId, mergedAt: { not: null } },
				orderBy: { mergedAt: "desc" },
				take: OUTCOMES_SHIPPED_CAP,
				select: {
					mergedAt: true,
					pullRequestUrl: true,
					story: { select: { identifier: true, title: true } },
				},
			}),
			db.projectSuccessMetric.findMany({
				where: { projectId },
				orderBy: { createdAt: "asc" },
				select: {
					name: true,
					direction: true,
					target: true,
					lastValue: true,
					previousValue: true,
					lastObservedAt: true,
				},
			}),
		]);

	const decisions: OutcomeDecision[] = [];
	for (const row of versionRows) {
		const summary = row.changeDescription ?? "";
		// Belt and braces: the DB filter is a substring match, the regex is
		// the documented contract.
		if (!DECISION_CHANGE_PATTERN.test(summary)) {
			continue;
		}
		decisions.push({
			storyIdentifier: row.story.identifier,
			storyTitle: row.story.title,
			decidedAt: row.createdAt,
			summary: summary.replace(/\s*\(run [^)]+\)/i, ""),
		});
	}
	for (const row of trackRows) {
		if (!row.trackUpdatedAt) {
			continue;
		}
		decisions.push({
			storyIdentifier: row.identifier,
			storyTitle: row.title,
			decidedAt: row.trackUpdatedAt,
			summary: `Delivery track set to ${trackLabel(row.deliveryTrack)}`,
		});
	}
	decisions.sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime());
	decisions.splice(OUTCOMES_DECISION_CAP);

	// Demo frames: resolve visibility separately and never expose the id.
	const frameIds = Array.from(
		new Set(
			spikeRuns
				.map((run) => run.demoFrameId)
				.filter((id): id is string => typeof id === "string"),
		),
	);
	const frames =
		frameIds.length > 0
			? await db.agentWorkspaceFile.findMany({
					where: { id: { in: frameIds } },
					select: { id: true, isPublic: true, shareToken: true },
				})
			: [];
	const frameById = new Map(frames.map((frame) => [frame.id, frame]));
	const demos: OutcomeDemo[] = spikeRuns.map((run) => {
		const frame = run.demoFrameId ? frameById.get(run.demoFrameId) : null;
		const demo: OutcomeDemo = {
			storyIdentifier: run.story.identifier,
			title: run.story.title,
		};
		if (frame?.isPublic && frame.shareToken) {
			demo.frameShareUrl = buildFrameShareUrl(frame.shareToken);
		}
		return demo;
	});

	const shipped: OutcomeShipped[] = [];
	for (const run of mergedRuns) {
		if (!run.mergedAt || !run.pullRequestUrl) {
			continue;
		}
		shipped.push({
			storyIdentifier: run.story.identifier,
			storyTitle: run.story.title,
			mergedAt: run.mergedAt,
			pullRequestUrl: run.pullRequestUrl,
		});
	}

	const metrics: OutcomeMetric[] = metricRows.map((row) => ({
		name: row.name,
		direction: row.direction,
		target: row.target,
		lastValue: row.lastValue,
		previousValue: row.previousValue,
		lastObservedAt: row.lastObservedAt,
	}));

	return {
		projectName: project.name,
		visionPurpose: project.visionPurpose,
		visionCoreActions: project.visionCoreActions,
		visionCycle: project.visionCycle,
		decisions,
		demos,
		shipped,
		metrics,
	};
}

/**
 * Token-scoped lookup for the public page. `null` for an unknown, revoked or
 * malformed token — the caller answers uniformly (NOT_FOUND / 404).
 */
export async function getCustomerOutcomesByToken(
	token: string,
): Promise<CustomerOutcomesDto | null> {
	if (typeof token !== "string" || token.length < 16 || token.length > 128) {
		return null;
	}
	const project = await db.project.findFirst({
		where: { outcomesShareToken: token },
		select: { id: true },
	});
	if (!project) {
		return null;
	}
	return buildCustomerOutcomes(project.id);
}
