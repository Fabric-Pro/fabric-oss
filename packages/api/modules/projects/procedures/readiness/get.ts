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

const ItemSchema = z.object({
	key: z.string(),
	category: z.string(),
	i18nKey: z.string(),
	ctaLabelKey: z.string(),
	needLevel: z.enum(["MUST", "SHOULD", "COULD", "NOT_APPLICABLE"]),
	isComplete: z.boolean(),
	supersededBy: z.string().optional(),
	manualState: z
		.enum(["SNOOZED", "NOT_APPLICABLE", "HELP_REQUESTED"])
		.nullable(),
	snoozeUntil: z.date().nullable(),
	isVisible: z.boolean(),
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

		const recentlyCompleted = await reconcileVerdicts({
			projectId: input.projectId,
			tenant,
			computed: summary.items.map((item) => ({
				key: item.key,
				isComplete: item.isComplete,
			})),
			now,
		});

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
	computed: Array<{ key: string; isComplete: boolean }>;
	now: Date;
}): Promise<Array<{ key: string }>> {
	const { projectId, tenant, computed, now } = args;

	const stored = await db.projectReadinessVerdict.findMany({
		where: { projectId },
		select: { itemKey: true, isComplete: true, changedAt: true },
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
		return prior !== undefined && prior.isComplete !== item.isComplete;
	});
	const changed = [...seeded, ...transitioned];

	if (changed.length > 0) {
		await db.$transaction(
			changed.map((item) =>
				db.projectReadinessVerdict.upsert({
					where: {
						projectId_itemKey: { projectId, itemKey: item.key },
					},
					create: {
						projectId,
						itemKey: item.key,
						isComplete: item.isComplete,
						changedAt: now,
						userId: tenant.userId,
						organizationId: tenant.organizationId,
					},
					update: { isComplete: item.isComplete, changedAt: now },
				}),
			),
		);
	}

	const cutoff = new Date(now.getTime() - RECENTLY_COMPLETED_WINDOW_MS);
	const justTransitioned = new Set(transitioned.map((item) => item.key));
	return computed
		.filter((item) => item.isComplete && !seededKeys.has(item.key))
		.map((item) => ({
			key: item.key,
			changedAt: justTransitioned.has(item.key)
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
}
