import { ORPCError } from "@orpc/client";
import {
	createArchitectureDecision,
	dismissMeetingDecision,
	getMeetingTranscriptForDecision,
	hasProjectAccess,
	listMeetingDecisionCandidates,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	completeCapturedDecision,
	deriveCapturedDecisionTitle,
} from "../../lib/captured-decision";

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
			title: input.title?.trim() || deriveCapturedDecisionTitle(text),
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

		// AC5: embed the new draft as AI context (no participants yet), then
		// tag it best-effort.
		return {
			decision: await completeCapturedDecision(decision, {
				projectId: input.projectId,
				user,
				organizationId,
			}),
		};
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
