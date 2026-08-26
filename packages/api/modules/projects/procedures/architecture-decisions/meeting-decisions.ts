import { ORPCError } from "@orpc/client";
import {
	createArchitectureDecision,
	dismissMeetingDecision,
	ensureDecisionType,
	getMeetingTranscriptForDecision,
	hasProjectAccess,
	listMeetingDecisionCandidates,
	updateArchitectureDecision,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { emitActivity } from "../../../../lib/realtime";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	buildArchitectureDecisionContextContent,
	syncArchitectureDecisionContext,
} from "../../lib/architecture-decision-context";
import {
	isActiveProjectMember,
	notifyDecisionOwner,
} from "../../lib/decision-owner";
import {
	loadSuggestionContext,
	suggestDecisionMetadata,
} from "../../lib/suggest-decision-metadata";

/** Derive a concise ADL title from a free-text meeting decision statement. */
function deriveTitle(text: string): string {
	const firstSentence = text.split(/[.!?\n]/)[0]?.trim() ?? "";
	const base = firstSentence || text.trim();
	if (!base) {
		return "Untitled decision";
	}
	return base.length > 120 ? `${base.slice(0, 117)}…` : base;
}

export const listMeetingDecisionCandidatesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-decision-candidates",
		tags: ["Projects", "Architecture Decisions"],
		summary: "List extracted meeting decisions as candidate ADL entries",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
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

		const candidates = await listMeetingDecisionCandidates({
			projectId: input.projectId,
			organizationId,
		});
		return { candidates };
	});

export const createDecisionFromMeetingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/architecture-decisions/from-meeting",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Create a draft ADL entry from an extracted meeting decision",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			transcriptId: z.string(),
			decisionIndex: z.number().int().min(0),
			title: z.string().max(255).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const transcript = await getMeetingTranscriptForDecision({
			projectId: input.projectId,
			transcriptId: input.transcriptId,
			organizationId,
		});
		if (!transcript) {
			throw new ORPCError("NOT_FOUND", { message: "Meeting not found" });
		}

		const decisions = Array.isArray(transcript.extractedDecisions)
			? (transcript.extractedDecisions as Array<{ text?: unknown }>)
			: [];
		const raw = decisions[input.decisionIndex];
		const text = raw && typeof raw.text === "string" ? raw.text.trim() : "";
		if (!text) {
			throw new ORPCError("BAD_REQUEST", {
				message: "That meeting decision could not be found",
			});
		}

		const meetingName = transcript.meetingSubject ?? "a meeting";
		const decision = await createArchitectureDecision({
			projectId: input.projectId,
			createdById: user.id,
			editedByName: user.name || user.email || "Unknown",
			title: input.title?.trim() || deriveTitle(text),
			decision: text,
			contextProblem: `Captured from the meeting "${meetingName}". Review and complete the context, rationale, and participants.`,
			rationale: "",
			status: "PROPOSED",
			decisionDate: transcript.meetingDate ?? new Date(),
			sourceKind: "meeting_decision",
			sourceMetadata: {
				transcriptId: transcript.id,
				decisionIndex: input.decisionIndex,
				meetingId: transcript.meetingId,
				meetingSubject: transcript.meetingSubject,
				meetingDate: transcript.meetingDate
					? transcript.meetingDate.toISOString()
					: null,
				originalText: text,
			},
			userId: user.id,
			organizationId,
		});

		// AC5: embed the new draft as AI context (no participants yet).
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
			projectId: input.projectId,
			contextId: decision.contextId,
			content,
			sourceTitle: `${decision.identifier} ${decision.title}`,
			userId: user.id,
			organizationId,
		});

		await emitActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || user.email || "Anonymous",
			activityType: "architecture_decision_created",
			resourceType: "architecture_decision",
			resourceId: decision.id,
			resourceName: decision.title,
			timestamp: new Date().toISOString(),
		});

		// Best-effort tagging at capture time (Fizzy #2029): suggest type,
		// duration, priority flag and owner, then apply them to the draft.
		// A failure leaves the draft untagged — the conversion still succeeds
		// and a human completes the metadata in the form.
		const tagged = await applyMeetingDecisionTagging(
			input.projectId,
			decision,
			user.id,
			organizationId,
		);

		return { decision: tagged ?? decision };
	});

export const dismissMeetingDecisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-decision-candidates/dismiss",
		tags: ["Projects", "Architecture Decisions"],
		summary:
			"Dismiss an extracted meeting decision so it isn't re-suggested",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			transcriptId: z.string(),
			decisionIndex: z.number().int().min(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const ok = await dismissMeetingDecision({
			projectId: input.projectId,
			transcriptId: input.transcriptId,
			decisionIndex: input.decisionIndex,
			organizationId,
		});
		if (!ok) {
			throw new ORPCError("NOT_FOUND", { message: "Meeting not found" });
		}
		return { success: true };
	});

/**
 * Suggest and apply tagging metadata to a freshly converted meeting draft.
 * Best-effort end to end: returns null when the suggestion or the write
 * fails, and the caller falls back to the untagged decision.
 */
async function applyMeetingDecisionTagging(
	projectId: string,
	decision: {
		id: string;
		projectId: string;
		title: string;
		decision: string;
		contextProblem: string;
		currentVersion: number;
	},
	actorUserId: string,
	organizationId: string | undefined,
) {
	try {
		const { existingTypes, ownerCandidates } =
			await loadSuggestionContext(projectId);

		const suggestion = await suggestDecisionMetadata({
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
			`[ADL] Meeting-decision tagging failed for ${decision.id}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}
