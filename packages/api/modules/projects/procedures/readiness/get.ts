import { db, getProjectRole, isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { gatherReadinessEvidence } from "../../lib/readiness/evidence";
import {
	type ManualStateInput,
	resolveReadiness,
} from "../../lib/readiness/level";

/**
 * Project readiness for one project, from the caller's point of view (Fizzy #2165).
 *
 * Everything about completion is computed here and now — nothing about it is
 * read from storage — so the level can never disagree with the project it
 * describes. The only persisted inputs are the states a person deliberately
 * chose, and they are scoped: a snooze belongs to the person who set it, while
 * not applicable and help requested speak for the whole project. That is why
 * this is "from the caller's point of view" rather than a project-wide constant.
 *
 * AUTHORIZATION + tenancy: `requireProjectPermission(PROJECT_READ)` is the tenant
 * guard. Deliberately no second `db.project.findFirst({ organizationId, userId })`
 * — that pattern 404s for org-shared projects the caller did not personally
 * create, since `project.userId` is the creator rather than every member.
 */

const RECENTLY_COMPLETED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENTLY_COMPLETED_LIMIT = 2;

/** Not Ready is worse than Partially Ready is worse than Ready. */
const LEVEL_SEVERITY = {
	READY: 0,
	PARTIALLY_READY: 1,
	NOT_READY: 2,
} as const;

const ItemSchema = z.object({
	key: z.string(),
	category: z.string(),
	i18nKey: z.string(),
	ctaLabelKey: z.string(),
	needLevel: z.enum(["MUST", "SHOULD", "COULD", "NOT_APPLICABLE"]),
	isComplete: z.boolean(),
	isInProgress: z.boolean(),
	supersededBy: z.string().optional(),
	/** Copy variant naming the condition still in the way; see the registry. */
	unmetReason: z.string().optional(),
	manualState: z
		.enum(["SNOOZED", "NOT_APPLICABLE", "HELP_REQUESTED"])
		.nullable(),
	snoozeUntil: z.date().nullable(),
	isVisible: z.boolean(),
	/** The prerequisite hiding this item, when one is. */
	blockedBy: z.string().optional(),
	isActiveGap: z.boolean(),
	target: z.union([
		z.object({ kind: z.literal("tab"), tab: z.string() }),
		z.object({ kind: z.literal("settings"), subTab: z.string() }),
	]),
});

export const getReadinessProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/readiness",
		tags: ["Projects", "Readiness"],
		summary: "Get project readiness",
		description:
			"Readiness level, gap list and per-item state for a project, computed from live project state.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			/** False when the feature flag is off — the panel renders nothing. */
			enabled: z.boolean(),
			level: z.enum(["NOT_READY", "PARTIALLY_READY", "READY"]),
			/** The phase graded against, and whether anyone chose it. */
			phase: z.enum(["DISCOVERY_PLANNING", "DEVELOPMENT_EXECUTION"]),
			phaseSource: z.enum(["set", "inferred"]),
			completedCount: z.number(),
			totalCount: z.number(),
			suggestPhaseTransition: z.boolean(),
			/**
			 * Whether this viewer may act on an item. Every action the panel
			 * offers — snooze, not applicable, setting the phase — needs
			 * PROJECT_UPDATE, so a reader was previously shown controls that
			 * could only fail. Resolved once here rather than guessed per
			 * button.
			 */
			canAct: z.boolean(),
			items: z.array(ItemSchema),
			activeGaps: z.array(ItemSchema),
			recentlyCompleted: z.array(z.object({ key: z.string() })),
			/**
			 * What has changed since THIS viewer last opened the panel, and how
			 * hard the panel is allowed to push about it.
			 */
			attention: z.object({
				changes: z.array(
					z.object({
						key: z.string(),
						kind: z.enum(["COMPLETED", "REGRESSED", "APPEARED"]),
					}),
				),
				levelDropped: z.boolean(),
				seenAt: z.date().nullable(),
				autoExpandedAt: z.date().nullable(),
			}),
		}),
	)
	.handler(async ({ input, context }) => {
		const disabled = {
			enabled: false as const,
			level: "NOT_READY" as const,
			phase: "DISCOVERY_PLANNING" as const,
			phaseSource: "inferred" as const,
			completedCount: 0,
			totalCount: 0,
			suggestPhaseTransition: false,
			canAct: false,
			items: [],
			activeGaps: [],
			recentlyCompleted: [],
			attention: {
				changes: [],
				levelDropped: false,
				seenAt: null,
				autoExpandedAt: null,
			},
		};

		if (!(await isFeatureEnabled("PROJECT_READINESS"))) {
			return disabled;
		}

		const gathered = await gatherReadinessEvidence(input.projectId);
		if (!gathered) {
			return disabled;
		}
		const { evidence, tenant } = gathered;

		const stateRows = await db.projectReadinessItemState.findMany({
			where: { projectId: input.projectId },
			select: {
				itemKey: true,
				state: true,
				snoozeUntil: true,
				personalForUserId: true,
			},
		});

		const now = new Date();
		// Same test the project page uses to decide whether anything is editable.
		const viewerRole = await getProjectRole(
			input.projectId,
			context.user.id,
		);

		const summary = resolveReadiness({
			evidence,
			manualStates: stateRows as ManualStateInput[],
			viewerUserId: context.user.id,
			now,
		});

		const { recentlyCompleted, transitions } = await reconcileVerdicts({
			projectId: input.projectId,
			tenant,
			computed: summary.items.map((item) => ({
				key: item.key,
				isComplete: item.isComplete,
				isVisible: item.isVisible,
			})),
			now,
		});

		// Verdicts are project-wide but attention is personal: `changedAt` is
		// when a verdict FLIPPED, not when it was recomputed, so comparing it
		// against one viewer's marker is correct even while teammates are
		// opening the same panel.
		const seen = await db.projectUserPreference.findUnique({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			select: {
				readinessSeenAt: true,
				readinessSeenLevel: true,
				readinessAutoExpandedAt: true,
			},
		});

		const seenAt = seen?.readinessSeenAt ?? null;
		const changes = seenAt
			? transitions.filter((t) => t.changedAt > seenAt)
			: [];

		// A level DROP is news; climbing back up is not — that is the project
		// getting better, which the pulse already covers through the item that
		// caused it.
		const levelDropped =
			seen?.readinessSeenLevel != null &&
			LEVEL_SEVERITY[summary.level] >
				(LEVEL_SEVERITY[
					seen.readinessSeenLevel as keyof typeof LEVEL_SEVERITY
				] ?? 0);

		return {
			enabled: true,
			level: summary.level,
			phase: summary.phase,
			phaseSource: summary.phaseSource,
			completedCount: summary.completedCount,
			totalCount: summary.totalCount,
			suggestPhaseTransition: summary.suggestPhaseTransition,
			canAct: viewerRole === "owner" || viewerRole === "editor",
			items: summary.items,
			activeGaps: summary.activeGaps,
			recentlyCompleted,
			attention: {
				changes: changes.map((c) => ({ key: c.key, kind: c.kind })),
				levelDropped,
				/** Null until this viewer has opened the panel at least once. */
				seenAt,
				autoExpandedAt: seen?.readinessAutoExpandedAt ?? null,
			},
		};
	});

/**
 * Keeps the stored verdict in step with what was just computed, and reports the
 * handful of items that turned complete recently.
 *
 * This is the one place readiness writes on a read, and it exists for a single
 * requirement: the panel shows one or two RECENTLY completed items, which pure
 * derivation cannot answer because it only ever sees the present. Nothing reads
 * this table for correctness — losing it would cost the "recently completed"
 * affordance and nothing else.
 */
async function reconcileVerdicts(args: {
	projectId: string;
	tenant: { userId: string | null; organizationId: string | null };
	computed: Array<{ key: string; isComplete: boolean; isVisible: boolean }>;
	now: Date;
}): Promise<{
	recentlyCompleted: Array<{ key: string }>;
	/**
	 * Every verdict flip, with the instant it happened. The caller filters this
	 * against one viewer's last-seen marker — the flip time is shared, "have I
	 * seen it" is not.
	 */
	transitions: Array<{
		key: string;
		kind: "COMPLETED" | "REGRESSED" | "APPEARED";
		changedAt: Date;
	}>;
}> {
	const { projectId, tenant, computed, now } = args;

	const stored = await db.projectReadinessVerdict.findMany({
		where: { projectId },
		select: {
			itemKey: true,
			isComplete: true,
			isVisible: true,
			changedAt: true,
			visibleChangedAt: true,
		},
	});
	const storedByKey = new Map(stored.map((row) => [row.itemKey, row]));

	// Two different things look alike here and must not be conflated.
	//
	// SEEDING — no verdict row exists yet, either because this is the project's
	// first read or because a rule was added to the registry after the last one.
	// Nothing was observed to change; Fabric simply had not looked before.
	//
	// TRANSITION — a row exists and its value flipped. That is a real event.
	//
	// Both must be WRITTEN, or the next read has nothing to compare against. Only
	// a transition may be REPORTED: treating a seed as a transition announces
	// every long-standing achievement as fresh news the first time anyone opens
	// the panel, which is exactly what it did before this distinction existed.
	const seeded = computed.filter((item) => !storedByKey.has(item.key));
	const seededKeys = new Set(seeded.map((item) => item.key));
	const transitioned = computed.filter((item) => {
		const prior = storedByKey.get(item.key);
		return (
			prior !== undefined &&
			(prior.isComplete !== item.isComplete ||
				prior.isVisible !== item.isVisible)
		);
	});

	// The same seed-vs-transition rule, applied to visibility. A row seeded on
	// this pass has not "appeared" — Fabric simply had not looked before, and
	// treating a seed as news lights up all 26 rows on a project's first read.
	const classified = transitioned.flatMap((item) => {
		const prior = storedByKey.get(item.key);
		if (!prior) {
			return [];
		}
		const kinds: Array<"COMPLETED" | "REGRESSED" | "APPEARED"> = [];
		if (prior.isComplete !== item.isComplete) {
			kinds.push(item.isComplete ? "COMPLETED" : "REGRESSED");
		}
		if (!prior.isVisible && item.isVisible) {
			kinds.push("APPEARED");
		}
		return kinds.map((kind) => ({ key: item.key, kind, changedAt: now }));
	});

	// Completion and visibility are written independently, because only the
	// former may move `changedAt`. Every row on this project carried
	// `isVisible = false` the moment the column was added, so the first read
	// after that flips visibility on most of them — bumping `changedAt` there
	// would report every long-complete item as recently completed.
	interface VerdictWrite {
		key: string;
		/** Set only for a row that does not exist yet. */
		create: {
			isComplete: boolean;
			isVisible: boolean;
			changedAt: Date;
			visibleChangedAt: Date;
		} | null;
		update: Record<string, unknown>;
	}
	const writes = computed.flatMap<VerdictWrite>((item) => {
		const prior = storedByKey.get(item.key);
		if (!prior) {
			return [
				{
					key: item.key,
					create: {
						isComplete: item.isComplete,
						isVisible: item.isVisible,
						changedAt: now,
						visibleChangedAt: now,
					},
					update: {},
				},
			];
		}
		const update: Record<string, unknown> = {};
		if (prior.isComplete !== item.isComplete) {
			update.isComplete = item.isComplete;
			update.changedAt = now;
		}
		if (prior.isVisible !== item.isVisible) {
			update.isVisible = item.isVisible;
			update.visibleChangedAt = now;
		}
		return Object.keys(update).length > 0
			? [{ key: item.key, create: null, update }]
			: [];
	});
	const changed = [...seeded, ...transitioned];

	if (writes.length > 0) {
		await db.$transaction(
			writes.map((write) =>
				db.projectReadinessVerdict.upsert({
					where: {
						projectId_itemKey: { projectId, itemKey: write.key },
					},
					create: {
						projectId,
						itemKey: write.key,
						userId: tenant.userId,
						organizationId: tenant.organizationId,
						...(write.create ?? {
							isComplete: false,
							isVisible: false,
							changedAt: now,
							visibleChangedAt: now,
						}),
					},
					update: write.update,
				}),
			),
		);
	}

	const cutoff = new Date(now.getTime() - RECENTLY_COMPLETED_WINDOW_MS);
	// Completion flips only. A visibility flip moves `visibleChangedAt`, never
	// `changedAt`, so an item revealed today has not "just completed" and must
	// not be dated as though it had — that is what would have resurfaced every
	// long-finished item the first time this ran after the column was added.
	const justCompleted = new Set(
		classified
			.filter((change) => change.kind !== "APPEARED")
			.map((change) => change.key),
	);
	const recentlyCompleted = computed
		.filter((item) => item.isComplete && !seededKeys.has(item.key))
		.map((item) => ({
			key: item.key,
			changedAt: justCompleted.has(item.key)
				? now
				: (storedByKey.get(item.key)?.changedAt ?? null),
		}))
		.filter((item) => item.changedAt !== null && item.changedAt > cutoff)
		.sort(
			(a, b) =>
				(b.changedAt as Date).getTime() -
				(a.changedAt as Date).getTime(),
		)
		.slice(0, RECENTLY_COMPLETED_LIMIT)
		.map((item) => ({ key: item.key }));

	return { recentlyCompleted, transitions: classified };
}
