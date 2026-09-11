import { db, getProjectRole, isFeatureEnabled } from "@repo/database";
import { hasPermission, resolveOrgPermissions } from "@repo/permissions";
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
import { READINESS_RULES_BY_KEY } from "../../lib/readiness/registry";
import { CLI_ITEM_KEY } from "../../lib/readiness/thresholds";
import type { ReadinessEvidence } from "../../lib/readiness/types";

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

/**
 * The eight "Context & Connections" items whose satisfied count decides whether
 * the CLI prompt is worth showing at all (Fizzy #2457, R1, R7).
 *
 * Written out by key, never derived from `category === "CONTEXT_AND_CONNECTIONS"`,
 * and that is the entire point of the list: the "API Key for CLI" row is itself
 * in that category, so a category count would silently have become two-of-nine
 * the moment the row was added — and the row could then have been its own
 * second satisfied item. A later rule added to the category must not move this
 * threshold; only editing this list may (R14).
 */
export const CONTEXT_AND_CONNECTIONS_THRESHOLD_KEYS = [
	"context-source",
	"additional-context-sources",
	"chat-app-connected",
	"meeting-transcripts",
	"pm-system-connected",
	"codebase-connected",
	"wiki-connected",
	"knowledge-base",
] as const;

/** How many of those eight a project needs before the prompt has anything to say. */
const CONTEXT_AND_CONNECTIONS_THRESHOLD = 2;

/**
 * How the rollout gate keeps the new row out of an organization it is off for
 * (Fizzy #2457, R16, R17).
 *
 * A rule receives evidence and nothing else, so the registry cannot read a flag
 * — the filtering has to happen here. It also has to happen BEFORE the level
 * rolls up: dropping the row from `items` afterwards would leave it in the
 * denominator and, in Development, leave its Should gap dragging a Ready
 * project down to Partially Ready. Merging this would then move readiness on
 * every project in every readiness-enabled deployment on day one, which is the
 * opposite of what a rollout gate is for.
 *
 * So the row is withheld from the resolver itself. `excludeKeys` leaves it out
 * of `items`, out of `activeGaps` and out of both counts in one move, which is
 * the whole gate — there is no second filter here, and no synthetic state that
 * a future dependency could read as satisfied.
 */
const CLI_ITEM_WITHHELD: ReadonlySet<string> = new Set([CLI_ITEM_KEY]);

/**
 * How many of the eight are satisfied, by R1's definition: the rule's own
 * detection passed, or a supersession made it unnecessary.
 *
 * Read from the evidence rather than from the resolved items deliberately. A
 * resolved item reads complete when it was marked not applicable — directly, or
 * through the cascade — and R1 is explicit that a not-applicable mark never
 * counts towards this threshold.
 */
function countSatisfiedContextItems(evidence: ReadinessEvidence): number {
	const detects = (key: string): boolean =>
		READINESS_RULES_BY_KEY.get(key)?.detect(evidence) === true;

	return CONTEXT_AND_CONNECTIONS_THRESHOLD_KEYS.filter(
		(key) =>
			detects(key) ||
			(READINESS_RULES_BY_KEY.get(key)?.supersededBy?.some(detects) ??
				false),
	).length;
}

/**
 * May this viewer mint an organization API key (Fizzy #2457, R4, R29)?
 *
 * The viewer's ORGANIZATION role on the project's host organization, put to the
 * permission matrix, and nothing else:
 *
 *  - **Not the project role.** No project role carries `ORG_API_KEYS_CREATE` at
 *    all, so a project-permission check would deny everyone. Worse, project
 *    membership takes precedence over organization role wherever a membership
 *    row exists, so an organization admin holding a project-viewer row would be
 *    hidden from a prompt they can plainly act on.
 *  - **Not a list of rank names.** The ranks carrying this permission moved
 *    once already (Fizzy #2380); a hard-coded list would have quietly kept the
 *    old answer.
 *
 * A guest — someone reaching the project through a `ProjectMember` row without
 * membership of its host organization — has no `member` row here, so the empty
 * permission set answers them without a separate guest test.
 *
 * Exported so the settle write in `set-state.ts` asks literally this question
 * rather than a second one that could drift from it.
 */
export async function viewerMayCreateOrganizationKey(
	organizationId: string | null,
	userId: string,
): Promise<boolean> {
	if (!organizationId) {
		return false;
	}

	const orgMember = await db.member.findFirst({
		where: { organizationId, userId },
		select: { role: true },
	});

	return hasPermission(
		resolveOrgPermissions(orgMember?.role),
		Permissions.ORG_API_KEYS_CREATE,
	);
}

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
			/**
			 * What this project is called.
			 *
			 * Carried here because the panel needs it and this read already has
			 * it: the key-issuing view names the project it is minting for, and
			 * the panel was opening a second lazy `projects.get` purely to
			 * learn one string. Empty only on the disabled payload, where there
			 * is no project to name.
			 */
			projectName: z.string(),
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
			/**
			 * Everything either CLI-connection surface needs, resolved here
			 * (Fizzy #2457, R3, R4, R5).
			 *
			 * Server-resolved in full because there is no client-side
			 * permission hook in this codebase — every client site hand-rolls
			 * a role comparison — and because the prompt and the checklist row
			 * must not be able to disagree. `canAct` above is the same
			 * pattern: one viewer permission, answered once, server-side.
			 *
			 * No telemetry is emitted for any of this. Eligibility resolves on
			 * every readiness read, and an eligible prompt may still yield to
			 * another onboarding surface and never render, so counting
			 * impressions here would overcount them badly. The render event
			 * belongs to the surface that actually decides to render.
			 */
			cliConnection: z.object({
				/**
				 * Whether the project's ORGANIZATION has a CLI reaching
				 * Fabric. The organization, not the project — every project
				 * of a connected organization reads true.
				 *
				 * Context, not an answer. With the rollout gate off this and
				 * `viewerCanCreateKey` below are reported false without being
				 * asked, because nothing may act on them there: the row is
				 * absent from `items` and `promptEligible` requires the row.
				 */
				organizationConnected: z.boolean(),
				/**
				 * Whether this viewer's organization role carries key
				 * creation, evaluated independently of their project role.
				 * False, unasked, while the rollout gate is off.
				 */
				viewerCanCreateKey: z.boolean(),
				/**
				 * Whether this viewer has already declined the prompt in this
				 * organization. One decline answers the question for the whole
				 * organization, not once per project.
				 *
				 * False, unasked, while the rollout gate is off — same as
				 * `organizationConnected` and `viewerCanCreateKey` above, but the
				 * DIRECTION is the opposite of theirs, and that is the important
				 * part. Those two read false-while-unasked as "cannot act," which
				 * fails the prompt closed. This field reads false as "has NOT
				 * declined," which is the value that would PERMIT the prompt — a
				 * fail-OPEN substitution. No future consumer may treat this
				 * literal as a real answer without first checking the gate;
				 * today `promptEligible` is the only reader, and it already
				 * requires the row to exist at all.
				 */
				viewerDismissed: z.boolean(),
				/**
				 * Whether the prompt may be shown to this viewer on this
				 * project at all. Every other field is context; this is the
				 * answer.
				 */
				promptEligible: z.boolean(),
			}),
		}),
	)
	.handler(async ({ input, context }) => {
		const disabled = {
			enabled: false as const,
			/** Nothing to name: this shape is returned before a project is read. */
			projectName: "",
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
			/**
			 * Carried on the disabled literal so the payload stays well-formed
			 * when readiness is off. This is what makes the CLI surfaces'
			 * dependency on readiness STRUCTURAL rather than a conjunction of
			 * two flags (R17): both surfaces read this block, and with
			 * readiness off it is inert whatever the rollout gate says.
			 */
			cliConnection: {
				organizationConnected: false,
				viewerCanCreateKey: false,
				viewerDismissed: false,
				promptEligible: false,
			},
		};

		if (!(await isFeatureEnabled("PROJECT_READINESS"))) {
			return disabled;
		}

		const gathered = await gatherReadinessEvidence(input.projectId);
		if (!gathered) {
			return disabled;
		}
		const { evidence, tenant, project, cliNudgeEnabled } = gathered;

		const now = new Date();

		const [stateRows, viewerRole, viewerCanCreateKey, dismissal] =
			await Promise.all([
				db.projectReadinessItemState.findMany({
					where: { projectId: input.projectId },
					select: {
						itemKey: true,
						state: true,
						snoozeUntil: true,
						personalForUserId: true,
					},
				}),
				// Same test the project page uses to decide whether anything is
				// editable.
				getProjectRole(input.projectId, context.user.id),
				// Both CLI lookups below are gated on the rollout flag, not
				// merely discarded when it is off (R16). The gate is off for
				// essentially every organization while the rollout runs one at
				// a time, and with the row withheld from the checklist nothing
				// in the payload can consult either answer — so a literal is
				// the whole of the work the common path has to do.
				cliNudgeEnabled
					? viewerMayCreateOrganizationKey(
							tenant.organizationId,
							context.user.id,
						)
					: false,
				// One decline answers the question for the whole organization,
				// so this is read per organization and not per project — which
				// is why a viewer who dismissed on one project gets no prompt
				// on a project they have never opened (R5). A row with a null
				// timestamp reads as NOT dismissed: the timestamp carries the
				// answer, not the row.
				cliNudgeEnabled && tenant.organizationId
					? db.cliConnectionPromptDismissal.findUnique({
							where: {
								organizationId_userId: {
									organizationId: tenant.organizationId,
									userId: context.user.id,
								},
							},
							select: { dismissedAt: true },
						})
					: null,
			]);

		const summary = resolveReadiness({
			evidence,
			manualStates: stateRows as ManualStateInput[],
			// The whole of the rollout gate's effect on the checklist: the row
			// never becomes an item, so it reaches neither list, neither count
			// nor the level.
			excludeKeys: cliNudgeEnabled ? undefined : CLI_ITEM_WITHHELD,
			viewerUserId: context.user.id,
			now,
		});

		const { items, activeGaps } = summary;

		const { recentlyCompleted, transitions, cliItemFirstVisibleAt } =
			await reconcileVerdicts({
				projectId: input.projectId,
				tenant,
				// A gated-off organization must not accumulate verdict rows for
				// a row nobody can see, so enabling the gate later seeds them
				// for the first time — a seed, which is never reported as news,
				// and whose `createdAt` then dates the row's arrival for that
				// organization. Withholding the item above is what achieves
				// that: it is simply not in `items`.
				computed: items.map((item) => ({
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
		const levelHasDropped =
			seen?.readinessSeenLevel != null &&
			LEVEL_SEVERITY[summary.level] >
				(LEVEL_SEVERITY[
					seen.readinessSeenLevel as keyof typeof LEVEL_SEVERITY
				] ?? 0);

		const cliItem = items.find((item) => item.key === CLI_ITEM_KEY);

		/**
		 * The introduction blast, suppressed per viewer (R22).
		 *
		 * Adding a Should-level row moves projects that were Ready to Partially
		 * Ready with nothing having gone wrong, and the panel treats a level
		 * drop as grounds to expand itself in the reader's face — bypassing even
		 * its own once-a-day auto-expand cap. So a viewer whose last-seen
		 * readiness predates the row is told about no drop on their first read
		 * after it, and only that viewer, because the marker is theirs. Keyed on
		 * the VIEWER rather than on the project's verdict rows deliberately:
		 * seeding fires once per project, so a project-shaped suppression would
		 * be spent by whoever opened the panel first and every colleague after
		 * them would still get the false drop.
		 *
		 * What it is compared AGAINST is the row's arrival on this project, not
		 * a global ship date. `CLI_CONNECTION_NUDGE` is org-scopable and off by
		 * default — enabling it one organization at a time is the design, not an
		 * edge case — so a constant would protect nobody in an organization
		 * flagged in after it: every viewer there whose marker had already moved
		 * past that instant would be told their project had got worse the first
		 * time the row appeared, which is nothing they did and nothing that
		 * changed.
		 *
		 * No stored row at all means this read is the row's first appearance
		 * here, so no marker can postdate it and the suppression applies. That
		 * is the safe way to be wrong: at worst one real drop goes unannounced
		 * for one viewer, where the other direction is an unsolicited panel
		 * announcing a regression that never happened.
		 *
		 * Narrowed to the case where the row is actually an unmet gap, rather
		 * than blanket-suppressing every drop for a viewer who has been away.
		 * That keeps a genuine regression audible for someone returning after a
		 * long absence, and — the reason it matters more — keeps the rollout
		 * gate honest: an organization the gate is off for has no row here, so
		 * nothing about its readiness reporting changes at all.
		 */
		const suppressIntroductionDrop =
			cliItem?.isActiveGap === true &&
			seenAt !== null &&
			(cliItemFirstVisibleAt === null || seenAt < cliItemFirstVisibleAt);

		/**
		 * Whether the prompt may be shown to this viewer, on this project, now
		 * (R3, R4, R7, R12).
		 *
		 * Every clause is a reason someone would resent being interrupted:
		 *
		 *  - the RESOLVED item is open — not complete, not marked not
		 *    applicable (both of which read as `isComplete`), and not under an
		 *    in-force personal snooze. Reading the resolved item rather than
		 *    the raw connected fact is what makes the prompt and the checklist
		 *    row agree by construction, and gives a team that does not use CLI
		 *    tools one project-wide way to answer instead of every member
		 *    dismissing separately. A missing item means the rollout gate is
		 *    off, which answers this on its own;
		 *  - the project is live, not archived, drafted or finished;
		 *  - the project has enough context set up for the offer to mean
		 *    anything — two of the eight, counted from the enumerated list;
		 *  - the viewer can actually act on it;
		 *  - and they have not already said no in this organization.
		 */
		const viewerDismissed = dismissal?.dismissedAt != null;
		const promptEligible =
			cliItem !== undefined &&
			!cliItem.isComplete &&
			cliItem.manualState !== "SNOOZED" &&
			project.status === "ACTIVE" &&
			viewerCanCreateKey &&
			!viewerDismissed &&
			countSatisfiedContextItems(evidence) >=
				CONTEXT_AND_CONNECTIONS_THRESHOLD;

		return {
			enabled: true,
			projectName: project.name,
			level: summary.level,
			phase: summary.phase,
			phaseSource: summary.phaseSource,
			completedCount: summary.completedCount,
			totalCount: summary.totalCount,
			suggestPhaseTransition: summary.suggestPhaseTransition,
			canAct: viewerRole === "owner" || viewerRole === "editor",
			items,
			activeGaps,
			recentlyCompleted,
			attention: {
				changes: changes.map((c) => ({ key: c.key, kind: c.kind })),
				levelDropped: levelHasDropped && !suppressIntroductionDrop,
				/** Null until this viewer has opened the panel at least once. */
				seenAt,
				autoExpandedAt: seen?.readinessAutoExpandedAt ?? null,
			},
			cliConnection: {
				organizationConnected: evidence.organizationCliConnected,
				viewerCanCreateKey,
				viewerDismissed,
				promptEligible,
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
	/**
	 * When the CLI row's verdict was first written for THIS project, which is
	 * when the row first became visible here: an organization the rollout gate
	 * is off for is deliberately never seeded one (see the `computed` filter at
	 * the call site), so the row's age is that organization's rollout moment.
	 *
	 * Null when nothing is stored yet — this very read is the row's first
	 * appearance on the project.
	 */
	cliItemFirstVisibleAt: Date | null;
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
			// Not used by the reconciliation itself. It is how the caller dates
			// the CLI row's arrival on this project (Fizzy #2457, R22).
			createdAt: true,
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

	return {
		recentlyCompleted,
		transitions: classified,
		// The row is never seeded for an organization the gate is off for, so its
		// `createdAt` is when the item first became visible on THIS project.
		cliItemFirstVisibleAt: storedByKey.get(CLI_ITEM_KEY)?.createdAt ?? null,
	};
}
