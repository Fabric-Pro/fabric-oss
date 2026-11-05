/**
 * What happens after a decision is created from a captured candidate — a
 * meeting transcript's or a Living Memory file's: mirror it into AI context,
 * record the activity, and suggest its tagging metadata.
 *
 * Shared by both candidate flows so the two cannot drift.
 */
import {
	type ArchitectureDecisionDetail,
	ensureDecisionType,
	updateArchitectureDecision,
} from "@repo/database";
import { logger } from "@repo/logs";
import { emitActivity } from "../../../lib/realtime";
import {
	buildArchitectureDecisionContextContent,
	syncArchitectureDecisionContext,
} from "./architecture-decision-context";
import { isActiveProjectMember, notifyDecisionOwner } from "./decision-owner";
import {
	loadSuggestionContext,
	suggestDecisionMetadata,
} from "./suggest-decision-metadata";

/** Derive a concise ADL title from a free-text captured decision statement. */
export function deriveCapturedDecisionTitle(text: string): string {
	const firstSentence = text.split(/[.!?\n]/)[0]?.trim() ?? "";
	const base = firstSentence || text.trim();
	if (!base) {
		return "Untitled decision";
	}
	return base.length > 120 ? `${base.slice(0, 117)}…` : base;
}

/**
 * Embed the new draft as AI context, emit the "created" activity, then apply
 * best-effort tagging. Returns the tagged decision, or the untagged one when
 * tagging produced nothing.
 */
export async function completeCapturedDecision(
	decision: ArchitectureDecisionDetail,
	input: {
		projectId: string;
		user: { id: string; name?: string | null; email?: string | null };
		organizationId: string | undefined;
	},
): Promise<ArchitectureDecisionDetail> {
	const { projectId, user, organizationId } = input;
	const content = buildArchitectureDecisionContextContent({
		identifier: decision.identifier,
		title: decision.title,
		status: decision.status,
		contextProblem: decision.contextProblem,
		decision: decision.decision,
		rationale: decision.rationale,
		alternativesConsidered: decision.alternativesConsidered,
		participantsText: decision.participantsText,
		participantNames: [],
		decisionDate: decision.decisionDate,
		sourceKind: decision.sourceKind,
	});
	await syncArchitectureDecisionContext({
		decisionId: decision.id,
		projectId,
		contextId: decision.contextId,
		content,
		sourceTitle: `${decision.identifier} ${decision.title}`,
		userId: user.id,
		organizationId,
	});

	await emitActivity({
		projectId,
		userId: user.id,
		userName: user.name || user.email || "Anonymous",
		activityType: "architecture_decision_created",
		resourceType: "architecture_decision",
		resourceId: decision.id,
		resourceName: decision.title,
		timestamp: new Date().toISOString(),
	});

	// Best-effort tagging at capture time: suggest type,
	// duration, priority flag and owner, then apply them to the draft.
	//
	// Capture deliberately does NOT depend on the model succeeding — a
	// conversion that failed because the AI was down would be a worse product
	// than an untagged draft. The manual form enforces AC1's type+duration at
	// the schema; this path cannot, because there is no honest value to fall
	// back on when the model returns nothing, and inventing a type would
	// pollute the project's taxonomy.
	//
	// So the guarantee here is visibility rather than enforcement: a decision
	// missing a type or duration carries a "Needs classification" badge in the
	// log (DecisionTagPills), which is what stops a failed tagging from reading
	// as a decision nobody needed to classify.
	const tagged = await applyCapturedDecisionTagging(
		projectId,
		decision,
		user.id,
		organizationId,
	);
	return tagged ?? decision;
}

/**
 * Suggest and apply tagging metadata to a freshly captured draft.
 * Best-effort end to end: returns null when the suggestion or the write
 * fails, and the caller falls back to the untagged decision.
 */
async function applyCapturedDecisionTagging(
	projectId: string,
	decision: ArchitectureDecisionDetail,
	actorUserId: string,
	organizationId: string | undefined,
) {
	try {
		const { existingTypes, ownerCandidates } =
			await loadSuggestionContext(projectId);

		const suggestion = await suggestDecisionMetadata({
			projectId,
			title: decision.title,
			decision: decision.decision,
			contextProblem: decision.contextProblem,
			participantsText: null,
			existingTypes,
			ownerCandidates,
			tenantFilter: { userId: actorUserId, organizationId },
		});
		if (!suggestion) {
			return null;
		}

		const type = await ensureDecisionType({
			projectId,
			name: suggestion.decisionType.slice(0, 60),
			origin: "AI",
			userId: actorUserId,
			organizationId: organizationId ?? null,
		});
		// The roster was read before the model call; a member can leave while it
		// runs. Re-check right before the write so a departed member is never
		// made owner (and never notified about a project they cannot open).
		const ownerStillActive =
			suggestion.ownerUserId !== null &&
			(await isActiveProjectMember(projectId, suggestion.ownerUserId));

		const updated = await updateArchitectureDecision({
			id: decision.id,
			projectId,
			editedById: actorUserId,
			editedByName: "AI suggestion",
			data: {
				decisionTypeId: type.id,
				duration: suggestion.duration,
				priorityFlagged: suggestion.priorityFlagged,
				...(ownerStillActive
					? { ownerUserId: suggestion.ownerUserId }
					: {}),
			},
		});
		if (updated && ownerStillActive) {
			await notifyDecisionOwner(
				updated,
				{ id: actorUserId },
				organizationId,
				true,
			);
		}
		return updated;
	} catch (error) {
		logger.warn(
			`[ADL] Captured-decision tagging failed for ${decision.id}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}
