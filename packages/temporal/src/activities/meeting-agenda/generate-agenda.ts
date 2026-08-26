import {
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { db, getBoundPromptForAgent } from "@repo/database";
import { logger } from "@repo/logs";
import type { TemplateFormat } from "@repo/utils";
import { heartbeat } from "@temporalio/activity";
import {
	AgendaSchema,
	composeAgendaPrompt,
	MEETING_AGENDA_AGENT_KEY,
	MEETING_AGENDA_PROMPT_FALLBACK_BODY,
	renderAgendaMarkdown,
} from "./build-agenda-prompt";
import {
	collectAgendaContextActivity,
	PRIOR_MEETING_CAP,
	PRIOR_MEETING_WINDOW_DAYS,
} from "./collect-agenda-context";

export interface GenerateAgendaInput {
	agendaId: string;
	projectId: string;
	organizationId: string | null;
	userId: string;
	linkedMeetingId: string;
}

export async function generateAgendaActivity(
	input: GenerateAgendaInput,
): Promise<{ status: "READY" }> {
	const { agendaId, projectId, organizationId, userId, linkedMeetingId } =
		input;

	heartbeat(`generateAgenda: ${agendaId}`);

	const [agenda, linkedMeeting, boundPrompt] = await Promise.all([
		db.projectMeetingAgenda.findUniqueOrThrow({
			where: { id: agendaId },
			select: { id: true, occurrenceStart: true },
		}),
		db.projectLinkedMeeting.findUniqueOrThrow({
			where: { id: linkedMeetingId },
			select: { subject: true },
		}),
		// #2178 — the editable prompt. Resolved HERE, in the activity, never in
		// the workflow: activity bodies are not replayed, so this adds no
		// command to the workflow's sequence and cannot cause TMPRL1100.
		//
		// organizationId ?? undefined is load-bearing for tenancy: falsy takes
		// the personal USER -> SYSTEM path, truthy takes ORG -> SYSTEM. The two
		// never cross (getBoundPromptVersion, prompts.ts:885-924).
		getBoundPromptForAgent({
			agentName: MEETING_AGENDA_AGENT_KEY,
			documentType: "GENERAL",
			storyKind: null,
			userId,
			organizationId: organizationId ?? undefined,
		}),
	]);

	const context = await collectAgendaContextActivity({
		projectId,
		organizationId,
		userId,
		linkedMeetingId,
		// #2105: bounds the series history read to [occurrenceStart - window,
		// occurrenceStart), which is also what keeps this occurrence's own
		// transcript out of its own agenda during the post-start grace window.
		occurrenceStart: agenda.occurrenceStart,
	});

	heartbeat(`generateAgenda: context assembled for ${agendaId}`);

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{ userId, organizationId: organizationId ?? undefined },
	);

	const composed = await composeAgendaPrompt({
		templateBody:
			boundPrompt?.version?.content ??
			MEETING_AGENDA_PROMPT_FALLBACK_BODY,
		format:
			(boundPrompt?.format as TemplateFormat | undefined) ?? "HANDLEBARS",
		meetingSubject: linkedMeeting.subject,
		occurrenceStart: agenda.occurrenceStart,
		context,
	});
	const prompt = composed.prompt;

	// Which prompt actually shaped this agenda. Persisted rather than only
	// logged: an agenda built from the default body because a bound prompt
	// would not render reads exactly like one built from the bound prompt, so
	// it is the one thing about a run a reader cannot recover from the output.
	const promptProvenance = {
		source: !boundPrompt
			? ("DEFAULT_UNBOUND" as const)
			: composed.bodyRecovered
				? ("DEFAULT_RENDER_FAILED" as const)
				: ("BOUND" as const),
		promptId: boundPrompt?.id ?? null,
		promptKey: boundPrompt?.key ?? null,
		promptName: boundPrompt?.name ?? null,
		promptScope: boundPrompt?.scope ?? null,
		promptVersion: boundPrompt?.version?.version ?? null,
		formatOverridden: composed.formatOverridden,
	};

	const start = Date.now();
	const result = await generateObject({
		model,
		schema: AgendaSchema,
		prompt,
		// AgendaSchema has optional fields, which make Azure/OpenAI reject a
		// strict JSON schema (bug #1681). The AI SDK still validates the object
		// against the zod schema.
		providerOptions: { openai: { strictJsonSchema: false } },
	});

	trackUsage();
	logModelUsageAsync({
		context: { userId, organizationId: organizationId ?? undefined },
		metadata,
		taskType: "COMPLEX",
		usage: result.usage,
		latencyMs: Date.now() - start,
	});

	await db.projectMeetingAgenda.update({
		where: { id: agendaId },
		data: {
			status: "READY",
			content: renderAgendaMarkdown(result.object),
			generatedStructure: result.object,
			// Also the data behind the sheet's "How this agenda was built"
			// expander (#2105 / UC1 step 4) — the window and caps are persisted
			// alongside the counts so a reader can tell "nothing carried over"
			// from "we only looked back 90 days".
			contextStats: {
				hadPriorTranscripts: context.hadPriorTranscripts,
				priorTranscriptCount: context.priorMeetings.length,
				carriedActionItemCount: context.carriedActionItems.length,
				priorMeetingWindowDays: PRIOR_MEETING_WINDOW_DAYS,
				priorMeetingCap: PRIOR_MEETING_CAP,
				openActionItemCount: context.openActionItems.length,
				openDecisionCount: context.openDecisions.length,
				blockedStoryCount: context.blockedStories.length,
				truncated: context.truncated,
			},
			promptProvenance,
			generatedAt: new Date(),
			generationError: null,
			// version was written in exactly one other place (saveAgenda's
			// updateMany), so a regenerate left it unchanged — an editor who had
			// the pre-regenerate row open at v1 could save with
			// expectedVersion: 1 and silently overwrite the regenerated content,
			// with the version-conflict UI never firing. Bumping it here makes a
			// regeneration a version-changing event like any other write.
			// Clearing editedAt/editedById alongside it also fixes a second bug:
			// without this, "this agenda has been edited" (D7) would keep firing
			// on every future regenerate after just one hand-edit, forever,
			// since nothing ever cleared the marker a fresh generation leaves
			// behind (#1901 final review, FIX 3).
			version: { increment: 1 },
			editedAt: null,
			editedById: null,
		},
	});

	logger.info("[meeting-agenda] generated", {
		agendaId,
		projectId,
		itemCount: result.object.items.length,
		hadPriorTranscripts: context.hadPriorTranscripts,
		promptSource: promptProvenance.source,
	});

	return { status: "READY" };
}

/**
 * The workflow's degradation boundary calls this so a failed run leaves a row
 * the UI can render an error and a retry against — never a row stuck on
 * GENERATING that the client polls until its budget runs out.
 */
export async function markAgendaFailedActivity(input: {
	agendaId: string;
	message: string;
}): Promise<void> {
	await db.projectMeetingAgenda.update({
		where: { id: input.agendaId },
		data: { status: "FAILED", generationError: input.message },
	});
}
