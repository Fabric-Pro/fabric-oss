import { ORPCError } from "@orpc/client";
import {
	createDecisionLogEntry,
	type DecisionLogEntry,
	findDecisionByQuestionId,
	getFeatureMaturationState,
	hasProjectAccess,
	listQuestionAssignees,
	type MaturationTenantFilter,
	optInFeatureToMaturationV2,
	resolveQuestionThread,
	StoryVersionConflictError,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { fanOut } from "../../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { recordAnswerInSpec } from "../../../lib/record-answer-in-spec";
import { filterAuthorizedMentionRecipients } from "../../../lib/user-mention";
import { AnswerSourceSchema, DecisionStatusSchema } from "./schemas";

/** Output-level status for the deterministic spec write. */
type AnswerPropagationStatus = "applied" | "error";

/**
 * `maturation.answerQuestion` (§12, AC-2.4/AC-2.6) — record a PO's answer to an
 * open question/gap, mint/resolve the resulting Decision Log thread root, and
 * record the decision into the Clean Spec.
 *
 * NOTEBOOK MODEL (slice 3): the answer is written into the Clean Spec
 * DETERMINISTICALLY — appended to a transient `## Resolved Decisions (pending
 * integration)` appendix (`recordAnswerInSpec`), with NO per-answer LLM patch.
 * The next maturation run dissolves the appendix into the body/Constraints and
 * prunes it (the AI sees only the spec). The old scoped-patch propagation
 * (`propagate-decision-to-spec.ts`) and its MANUAL accept flow are now dormant.
 *
 * OPEN-QUESTION MODEL: an open question/gap surfaced by `getEditorState` is an
 * OPEN-status Decision Log thread root carrying this `questionId`. Answering it
 * resolves THAT thread in place — the answer is appended as a reply (AC-2.6,
 * non-destructive) and the root flips to RESOLVED, so it drops off the open list.
 *
 * DEDUPE (AC-2.4): the same underlying question must not resurface as a second
 * decision. We look up the existing root for `(userStoryId, questionId)` and
 * branch on its status:
 *   - already RESOLVED (or otherwise settled) → idempotent, return it unchanged
 *     (mirrors `findRecentDuplicateStoryComment` in comments.ts); NO re-propagate;
 *   - still OPEN → resolve it in place (reply + flip), then propagate;
 *   - no root yet (a gap addressed by id only) → mint a RESOLVED root, then
 *     propagate.
 *
 * PM-SYNC ISOLATION (§7.7): minting/resolving a decision writes a maturation
 * surface, not the dev-facing Clean Spec — that step never syncs. The ONLY write
 * that touches `description`/`acceptanceCriteria` (and so may push to PM) is the
 * AUTO_ACCEPT branch of the propagation, and it is gated on the feature's
 * `pmAutoSyncEnabled` cloud toggle inside `propagateDecisionToCleanSpec`.
 */
export const answerQuestionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/answer-question",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Answer a question/gap and mint a Decision",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			questionId: z.string().min(1).max(500),
			answer: z.string().min(1).max(10_000),
			summary: z.string().max(2_000).nullable().optional(),
			impactedSection: z.string().max(500).nullable().optional(),
			// How the answer was produced relative to the AI recommendation (#7).
			// Defaults to MANUAL when the client doesn't classify it.
			answerSource: AnswerSourceSchema.optional(),
			/**
			 * Project members the answer CITES ("as per @Sam, ninety days"),
			 * resolved by the client from the display names it rendered (#1751,
			 * AC-10). Nothing is asked of them, so this is not an assignment —
			 * see `setQuestionAssignees` for the half that is.
			 *
			 * Client-supplied ids are narrowed to people actually on the project
			 * before anything is written; matching on the rendered name is what
			 * keeps the stored answer plain text, so the server cannot re-derive
			 * them without duplicating the panel's matcher.
			 */
			mentionedUserIds: z.array(z.string()).max(50).optional(),
		}),
	)
	.output(
		z.object({
			decision: z.object({
				id: z.string(),
				status: DecisionStatusSchema,
				summary: z.string().nullable(),
				content: z.string().nullable(),
				questionId: z.string().nullable(),
				impactedSection: z.string().nullable(),
				createdAt: z.date(),
				authorName: z.string().nullable().optional(),
				sourceProvenance: z.string().nullable().optional(),
			}),
			deduped: z.boolean(),
			// Clean-Spec write outcome for this answer. `null` when nothing was
			// written (a deduped/idempotent answer). `applied` = the Q+A was
			// recorded into the spec's pending-decisions appendix; `error` = the
			// write failed (the decision still stands). A lost concurrency race
			// never reaches here — it throws CONFLICT, see `recordAnswer`.
			propagation: z
				.object({
					status: z.enum(["applied", "error"]),
					appliedCount: z.number().int(),
					pendingCount: z.number().int(),
					failedCount: z.number().int(),
				})
				.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const feature = await getFeatureMaturationState({
			userStoryId: input.storyId,
			projectId: input.projectId,
		});
		if (!feature) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		const tenantFilter: MaturationTenantFilter = {
			organizationId: organizationId ?? null,
			userId: context.user.id,
		};

		// Look up any existing root for this question. MUST happen before any
		// write so dedupe is honored (AC-2.4).
		const existing = await findDecisionByQuestionId({
			tenantFilter,
			userStoryId: input.storyId,
			questionId: input.questionId,
		});

		// Already settled → idempotent dedupe; return the existing decision. No
		// propagation: the Clean Spec was already patched when this decision was
		// first resolved (re-answering must not re-mutate the spec).
		if (existing && existing.status !== "OPEN") {
			return {
				decision: serializeDecision(existing),
				deduped: true,
				propagation: null,
			};
		}

		// Resolve the decision: flip an existing OPEN question thread in place
		// (reply + flip), or mint a fresh RESOLVED root for a gap.
		const answerSource = input.answerSource ?? "MANUAL";
		let decision: DecisionLogEntry;
		if (existing) {
			const resolved = await resolveQuestionThread({
				tenantFilter,
				rootId: existing.id,
				answer: input.answer,
				summary: input.summary ?? undefined,
				impactedSection: input.impactedSection ?? undefined,
				authorUserId: context.user.id,
				decidedBy: context.user.id,
				answerSource,
				authorName: context.user.name,
				sourceProvenance: `Feature Response — ${feature.title}`,
			});
			if (!resolved) {
				// Lost a race / wrong tenant — surface as not found rather than
				// silently minting a parallel decision.
				throw new ORPCError("NOT_FOUND", {
					message: "Question thread not found",
				});
			}
			decision = resolved;
		} else {
			decision = await createDecisionLogEntry({
				tenantFilter,
				userStoryId: input.storyId,
				authorType: "USER",
				authorUserId: context.user.id,
				status: "RESOLVED",
				source: "HUMAN",
				content: input.answer,
				summary: input.summary ?? null,
				questionId: input.questionId,
				impactedSection: input.impactedSection ?? null,
				decidedBy: context.user.id,
				answerSource,
				authorName: context.user.name,
				sourceProvenance: `Feature Response — ${feature.title}`,
			});
		}

		// Lazy opt-in (§5.1): the PO's first answer commits this feature to v2
		// maturation, which also arms Decision→Spec propagation below. Idempotent —
		// only write when not already opted in. Touches no Clean-Spec content, so it
		// does not sync. Best-effort: a failed opt-in must not lose the decision.
		if (!feature.maturationV2OptedIn) {
			try {
				await optInFeatureToMaturationV2({
					userStoryId: input.storyId,
					projectId: input.projectId,
				});
			} catch (err) {
				logger.warn("[maturation] opt-in write failed", {
					storyId: input.storyId,
					err: err instanceof Error ? err.message : String(err),
				});
			}
			feature.maturationV2OptedIn = true;
		}

		// Record the decision into the Clean Spec deterministically (no LLM patch).
		// The question text comes from the resolved root's content; the next
		// maturation run integrates the appendix. Runs AFTER the decision is durably
		// recorded, so an infrastructure failure here leaves the decision standing.
		//
		// The base text is NOT passed in: `recordAnswerInSpec` re-reads the
		// description inside its own write transaction, under the story row's
		// `FOR UPDATE` lock. `feature.description` was read before the decision
		// writes above, so appending onto it is exactly the stale-base race that
		// dropped a concurrent answer's bullet.
		const questionText =
			existing?.content?.trim() ||
			input.summary?.trim() ||
			decision.summary?.trim() ||
			"Resolved decision";
		const propagation = await recordAnswer({
			storyId: input.storyId,
			projectId: input.projectId,
			tenantFilter,
			lastEditedByName: context.user.name ?? null,
			question: questionText,
			answer: input.answer,
			decision,
		});

		// AFTER `recordAnswer`: a lost concurrency race throws CONFLICT there, and
		// an answer that did not land must not tell anybody it did.
		await dispatchAnswerNotifications({
			// The thread this answer settled. On the mint branch there is no
			// prior root, so there are no assignees and nobody asked.
			questionRootId: existing?.id ?? decision.id,
			questionSummary: questionText,
			mentionedUserIds: input.mentionedUserIds ?? [],
			storyId: input.storyId,
			storyTitle: feature.title,
			projectId: input.projectId,
			organizationId: organizationId ?? null,
			tenantFilter,
			actorUserId: context.user.id,
			actorName: context.user.name,
		});

		return {
			decision: serializeDecision(decision),
			deduped: false,
			propagation,
		};
	});

interface AnswerNotificationParams {
	questionRootId: string;
	questionSummary: string;
	/** Ids the client resolved from the `@` names in the answer text. */
	mentionedUserIds: string[];
	storyId: string;
	storyTitle: string;
	projectId: string;
	organizationId: string | null;
	tenantFilter: MaturationTenantFilter;
	actorUserId: string;
	actorName: string;
}

/**
 * The two informational notices an answer raises (Fizzy #1751, AC-10 / AC-14).
 *
 * Neither asks for anything, which is what separates both from
 * `QUESTION_ASSIGNED`: one says a question you handed out is settled, the other
 * says an answer named you. A recipient who cannot tell those apart has to open
 * all three, which defeats the routing.
 *
 * Runs only on a real answer — never on the deduped/idempotent path, where
 * re-submitting the same answer would re-ping the asker.
 *
 * BEST-EFFORT, like every other notification dispatch: the decision is already
 * durably recorded by the time this runs, so a lookup failure is logged and
 * swallowed rather than failing a request whose write succeeded.
 */
async function dispatchAnswerNotifications(
	params: AnswerNotificationParams,
): Promise<void> {
	const common = {
		questionRootId: params.questionRootId,
		questionSummary: params.questionSummary,
		storyId: params.storyId,
		storyTitle: params.storyTitle,
		projectId: params.projectId,
		organizationId: params.organizationId,
		actorUserId: params.actorUserId,
		actorName: params.actorName,
		// Context-relative on purpose: `resolveNotificationLink` resolves it
		// against the NOTIFICATION's own workspace, so the destination cannot
		// depend on whichever organization the recipient happens to be viewing.
		link: `projects/${params.projectId}/stories/${params.storyId}`,
	};

	try {
		// AC-14 — whoever ASKED hears that their question is settled. The
		// recipients are the `assignedByUserId` values on the assignment rows, so
		// after a re-assignment it is the person who handed the question on, not
		// whoever asked first.
		const byEntry = await listQuestionAssignees({
			tenantFilter: params.tenantFilter,
			entryIds: [params.questionRootId],
		});
		const askers = [
			...new Set(
				(byEntry.get(params.questionRootId) ?? []).map(
					(row) => row.assignedByUserId,
				),
			),
		];
		if (askers.length > 0) {
			await fanOut.questionAnswered({
				...common,
				recipientUserIds: askers,
			});
		}

		// AC-10 — anyone the answer CITED. Narrowed to people actually on the
		// project first, so a stale or crafted id cannot mint a notification for
		// a stranger.
		if (params.mentionedUserIds.length > 0) {
			const recipients = await filterAuthorizedMentionRecipients(
				params.mentionedUserIds,
				params.projectId,
				params.organizationId,
			);
			if (recipients.length > 0) {
				await fanOut.questionMentioned({
					...common,
					recipientUserIds: recipients,
				});
			}
		}
	} catch (err) {
		logger.warn("[maturation] answer notification dispatch failed", {
			storyId: params.storyId,
			questionRootId: params.questionRootId,
			err: err instanceof Error ? err.message : String(err),
		});
	}
}

interface RecordAnswerParams {
	storyId: string;
	projectId: string;
	tenantFilter: MaturationTenantFilter;
	lastEditedByName: string | null;
	question: string;
	answer: string;
	/** The already-committed Decision Log row, carried on a CONFLICT throw. */
	decision: DecisionLogEntry;
}

interface PropagationSummary {
	status: AnswerPropagationStatus;
	appliedCount: number;
	pendingCount: number;
	failedCount: number;
}

/**
 * Record the confirmed decision into the Clean Spec's pending-decisions appendix
 * (deterministic — no model call).
 *
 * Two failure modes, deliberately NOT the same severity:
 *
 *  - An INFRASTRUCTURE failure (the write blew up) is non-fatal: the decision is
 *    already committed, so this returns `status: "error"` and the client shows a
 *    warning. Answering must not fail because the appendix write did.
 *  - A LOST CONCURRENCY RACE throws CONFLICT. `recordAnswerInSpec` re-reads the
 *    description under the story row's `FOR UPDATE` lock, so a concurrent answer
 *    can no longer make the compare-and-set miss — this is now a genuine
 *    anomaly, and degrading it into a warning is exactly how the reported bug
 *    looked: "Resolved" in the Decision Log, absent from the spec. The committed
 *    decision rides along on the error's `data` so the caller does not lose it.
 */
async function recordAnswer({
	storyId,
	projectId,
	tenantFilter,
	lastEditedByName,
	question,
	answer,
	decision,
}: RecordAnswerParams): Promise<PropagationSummary> {
	try {
		await recordAnswerInSpec({
			storyId,
			projectId,
			tenantFilter,
			lastEditedByName,
			question,
			answer,
		});
		return {
			status: "applied",
			appliedCount: 1,
			pendingCount: 0,
			failedCount: 0,
		};
	} catch (err) {
		if (err instanceof StoryVersionConflictError) {
			logger.error(
				"[maturation] answer lost a race for the Clean Spec write",
				{ storyId, err: err.message },
			);
			// Raised here rather than left to `domainErrorMapper` (orpc/procedures.ts),
			// which maps this same error to CONFLICT with `data: { storyId }`. The
			// shape is a superset of that one: the decision IS durably recorded and
			// only its integration into the spec failed, so it rides along and the
			// client keeps the answer the user just made.
			throw new ORPCError("CONFLICT", {
				message: err.message,
				data: { storyId, decision: serializeDecision(decision) },
			});
		}
		logger.error("[maturation] recording answer into Clean Spec failed", {
			storyId,
			err: err instanceof Error ? err.message : String(err),
		});
		return {
			status: "error",
			appliedCount: 0,
			pendingCount: 0,
			failedCount: 0,
		};
	}
}

/** Map a Decision Log row to the answer DTO (shared by all answer outcomes).
 * Typed with the Prisma `DecisionLogEntry` so `status` keeps its enum type and
 * matches the enum-typed `.output()` schema — do NOT widen it to `string`. */
function serializeDecision(row: DecisionLogEntry) {
	return {
		id: row.id,
		status: row.status,
		summary: row.summary,
		content: row.content,
		questionId: row.questionId,
		impactedSection: row.impactedSection,
		createdAt: row.createdAt,
		authorName: row.authorName,
		sourceProvenance: row.sourceProvenance,
	};
}
