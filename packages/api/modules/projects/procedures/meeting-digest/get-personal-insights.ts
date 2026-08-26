/**
 * Ephemeral insights for a personal calendar meeting.
 *
 * PRIVACY CONTRACT — identical to get-personal-transcript.ts, and the reason
 * this procedure exists at all rather than reusing the team pipeline:
 * the transcript and everything derived from it live only for the lifetime of
 * this request and the browser tab that receives it. Nothing is written to the
 * database, cached in Redis, embedded, or passed to a Temporal workflow (whose
 * event history would persist it).
 *
 * That constraint is why this is a direct `generateObject` call rather than the
 * team path: every existing producer of summaries / decisions / action items in
 * this repo writes its output to Postgres, and #1899's FR7 forbids that for
 * personal meetings. The trade-off is deliberate and permanent — insights are
 * recomputed on every view, and there is no ticket creation, because a ticket
 * needs a persisted row.
 *
 * `packages/ai`'s usage logging records token counts only, never prompt
 * content, so billing telemetry does not become a back door around FR7.
 */

import { ORPCError } from "@orpc/server";
import {
	generateObject,
	getAIModelWithMetadata,
	NoObjectGeneratedError,
} from "@repo/ai";
import { hasProjectAccess, isFeatureEnabled } from "@repo/database";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { zodSchema } from "ai";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { fetchPersonalTranscriptContent } from "./personal-transcript-fetch";

/** Ceiling on transcript characters fed to the model. */
export const PERSONAL_PROMPT_CHAR_CAP = 60_000;

/**
 * Floor below which there is nothing a summary could say.
 *
 * Not a quality judgement — a floor. Staging QA of #2104 found two meetings
 * whose Graph transcripts were 29 and 230 characters (two lines, and nine lines
 * totalling thirty-four words of greetings); both produced no object at all and
 * surfaced to the user as a server error. A transcript this short cannot yield
 * the 3-8 bullet summary the prompt asks for, so skipping the call spends no
 * tokens and answers instantly. The `NoObjectGeneratedError` branch below is
 * the general case; this only short-circuits the obvious one.
 */
const MIN_SUMMARISABLE_CHARS = 200;

/**
 * Only summary + action items, deliberately narrower than the team extractor.
 * Decisions and open questions are project-level artefacts that exist to be
 * tracked and acted on collectively; surfacing them for a meeting nobody else
 * can see invites the user to treat private notes as team record.
 */
const PersonalInsightsSchema = z.object({
	summary: z.string(),
	actionItems: z.array(
		z.object({
			text: z.string().min(1),
			tentativeOwnerName: z.string().optional(),
			dueHint: z.string().optional(),
		}),
	),
});

/**
 * Build the extraction prompt.
 *
 * Deliberately a local copy rather than an import of the daily-brief
 * extractor's builder: that module pulls in both Prisma and the Temporal
 * activity runtime, either of which would drag persistence back into this path
 * and trip the FR7 source guard. (Named indirectly on purpose — that guard is
 * a blunt substring match, and spelling the package here would trip it.)
 */
export function buildPersonalInsightsPrompt(input: {
	meetingSubject: string | null;
	transcriptText: string;
}): string {
	const { meetingSubject, transcriptText } = input;
	const trimmed =
		transcriptText.length > PERSONAL_PROMPT_CHAR_CAP
			? `${transcriptText.slice(0, PERSONAL_PROMPT_CHAR_CAP)}\n[truncated at ${PERSONAL_PROMPT_CHAR_CAP} chars]`
			: transcriptText;

	return `Summarise this meeting transcript for the person who attended it.

Return:
1. summary — a concise markdown summary (3-8 bullet points) of what was discussed and concluded. No heading, no participant list, no date — just the substance.
2. actionItems — commitments to do something after the meeting. Include a tentative owner only if a name is stated, and a free-text dueHint (e.g. "by Friday") only when stated. Never invent either.

Rules:
- Do not invent content. If unsure, omit.
- Each action item is one short sentence.
- If the transcript is purely small talk with no commitments, return an empty actionItems array.

Meeting: ${meetingSubject ?? "(no subject)"}

Transcript:
${trimmed}
`;
}

export const getPersonalInsightsProcedure = tenantProtectedProcedure
	// Same doubled org gate as the sibling personal procedures:
	// requireProjectPermission resolves on (projectId, userId) and never reads
	// the org, so without requireInputOrgPermission a caller could pair a
	// project they legitimately reach with an organization they do not belong
	// to (the #1899 input-org ratchet).
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/personal/insights",
		tags: ["Projects", "Meeting Digest"],
		summary: "Summarise a personal meeting on demand",
		description:
			"Summarise the authenticated user's own meeting transcript live from Microsoft Graph. Neither the transcript nor the summary is persisted.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			joinUrl: z.string(),
			startTime: z.string().optional(),
			meetingSubject: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		if (!(await isFeatureEnabled("PERSONAL_MEETINGS"))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Personal meetings are not enabled.",
			});
		}

		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const callGraph = (methodName: string, args: Record<string, unknown>) =>
			executeMicrosoftTeamsTool(
				methodName,
				args,
				user.id,
				organizationId ?? undefined,
			);

		let transcript: Awaited<
			ReturnType<typeof fetchPersonalTranscriptContent>
		>;
		try {
			transcript = await fetchPersonalTranscriptContent({
				callGraph,
				joinUrl: input.joinUrl,
				startTime: input.startTime,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to fetch personal transcript: ${message}`,
			});
		}

		// No transcript means nothing to summarise. Returning the reason rather
		// than an empty summary lets the UI say why, and spends no model call.
		if (transcript.content === null) {
			return {
				summary: null,
				actionItems: [],
				reason: transcript.reason,
			};
		}

		// A transcript exists but holds nothing to summarise. Same shape as the
		// no-transcript answer above: a reason, not an error, and no model call.
		if (transcript.content.trim().length < MIN_SUMMARISABLE_CHARS) {
			return {
				summary: null,
				actionItems: [],
				reason: "insufficient-content" as const,
			};
		}

		try {
			const { model, trackUsage } = await getAIModelWithMetadata(
				{ taskType: "SIMPLE" },
				{
					userId: user.id,
					organizationId: organizationId ?? undefined,
				},
			);

			const { object } = await generateObject({
				model,
				schema: zodSchema(PersonalInsightsSchema),
				prompt: buildPersonalInsightsPrompt({
					meetingSubject: input.meetingSubject ?? null,
					transcriptText: transcript.content,
				}),
			});
			trackUsage();

			return {
				summary: object.summary,
				actionItems: object.actionItems ?? [],
			};
		} catch (error) {
			// NOTHING derived from the error may be interpolated anywhere, here
			// or in the log lines below. A generateObject failure attaches the
			// offending prompt — the whole transcript — to its `text`, and its
			// message quotes the model's raw output. Only the error class and
			// the model's own finishReason are safe, and neither the user nor
			// the meeting is named: a log of who summarised which private
			// meeting is the same leak the audit-log exclusion exists to stop.
			if (
				NoObjectGeneratedError.isInstance(error) &&
				error.finishReason !== "length"
			) {
				// The model ran to completion and still produced nothing that
				// fits the schema. That is a statement about the transcript,
				// not a fault — a meeting that was only greetings has no
				// summary to give. Answer like the floor above does.
				logger.warn(
					"[MeetingDigest/personalInsights] model returned no object",
					{ finishReason: error.finishReason },
				);
				return {
					summary: null,
					actionItems: [],
					reason: "insufficient-content" as const,
				};
			}

			// Everything else — provider outage, a schema too big for the
			// output budget (finishReason "length") — is a real failure and
			// must stay loud. The class name is the only diagnostic that can
			// be recorded safely; before this, the failure was invisible in
			// logs and unexplained on screen.
			logger.warn(
				"[MeetingDigest/personalInsights] summarisation failed",
				{
					errorClass:
						error instanceof Error ? error.name : typeof error,
					...(NoObjectGeneratedError.isInstance(error)
						? { finishReason: error.finishReason }
						: {}),
				},
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to summarise this meeting.",
			});
		}
	});
