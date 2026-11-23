import { getAIModelWithMetadata } from "@repo/ai";
import { db, getBoundPromptForAgent } from "@repo/database";
import { logger } from "@repo/logs";
import {
	formatParlumeChatDeliveryEvidence,
	readParlumeChatDeliveryEvidence,
} from "@repo/utils/parlume-chat-delivery-evidence";
import { parlumeNoteItemsRecord } from "@repo/utils/parlume-notes";
import {
	PARLUME_NOTES_FALLBACK_BODY,
	PARLUME_NOTES_PROMPT_AGENT_KEY,
} from "@repo/utils/parlume-notes-prompt";
import { activityInfo } from "@temporalio/activity";
import { PARLUME_NOTES_LEGACY_MAX_ATTEMPTS } from "../lib/parlume-notes-retry";
import {
	findPlanExhausted,
	findWorkflowHandledPlanRefusal,
} from "./lib/chatgpt-plan-refusal";
import { parlumeActivityLog } from "./parlume-log";
import { renderParlumeNotes, toParlumeNoteItem } from "./parlume-notes-anchors";
import { parlumeNotesPass, writeAnchoredNotes } from "./parlume-notes-passes";

export async function writeParlumeNotes(input: {
	sessionId: string;
	/**
	 * The workflow will not try again. Until then a spent ChatGPT plan fails
	 * the activity with its own error, for the workflow to wait on, and the
	 * notes are not marked failed.
	 */
	finalAttempt?: boolean;
	/**
	 * A member asked for the notes again: written over the notes there are.
	 * The earlier notes stay if this run fails.
	 */
	regenerate?: boolean;
	/** The retry policy's attempts; absent on activities scheduled before. */
	maxAttempts?: number;
}): Promise<void> {
	const session = await db.parlumeMeetingSession.findUnique({
		where: { id: input.sessionId },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			transcriptContextId: true,
		},
	});
	if (!session?.transcriptContextId) {
		throw new Error("Parlume transcript is unavailable for notes.");
	}
	const context = await db.projectContext.findFirst({
		where: {
			id: session.transcriptContextId,
			projectId: session.projectId,
			organizationId: session.organizationId,
		},
		select: { id: true, content: true, metadata: true },
	});
	if (!context) {
		throw new Error("Parlume transcript is unavailable for notes.");
	}
	const metadata =
		context.metadata &&
		typeof context.metadata === "object" &&
		!Array.isArray(context.metadata)
			? context.metadata
			: {};
	if (
		input.regenerate !== true &&
		typeof metadata.parlumeNotes === "string"
	) {
		return;
	}
	// A failed model call is Temporal's to retry; only the last attempt
	// records the notes as failed.
	const lastAttempt =
		activityInfo().attempt >=
		(input.maxAttempts ?? PARLUME_NOTES_LEGACY_MAX_ATTEMPTS);
	try {
		if (!context.content) {
			throw new Error("Parlume transcript is empty.");
		}
		const chatDeliveryFacts = formatParlumeChatDeliveryEvidence(
			readParlumeChatDeliveryEvidence(metadata, {
				sessionId: session.id,
				projectId: session.projectId,
				organizationId: session.organizationId,
			}),
		);
		const boundPrompt = await getBoundPromptForAgent({
			agentName: PARLUME_NOTES_PROMPT_AGENT_KEY,
			documentType: "GENERAL",
			storyKind: null,
			userId: session.userId,
			organizationId: session.organizationId,
			projectId: session.projectId,
		});
		const { model, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE", complexity: "simple" },
			{
				userId: session.userId,
				organizationId: session.organizationId,
				projectId: session.projectId,
				featureKey: "parlume",
				conversationId: session.id,
				jobType: "parlume-meeting-notes",
				promptVersionId: boundPrompt?.version?.id,
			},
		);
		const instructions =
			boundPrompt?.version?.content?.trim() ||
			PARLUME_NOTES_FALLBACK_BODY;
		const { notes, stats, parts } = await writeAnchoredNotes({
			content: context.content,
			chatDeliveryFacts,
			pass: async (prompt) =>
				(await parlumeNotesPass(model, instructions, prompt)).output,
		});
		trackUsage();
		const items = notes.map(toParlumeNoteItem);
		await db.projectContext.update({
			where: { id: context.id },
			data: {
				metadata: {
					...metadata,
					parlumeNotes: renderParlumeNotes(items),
					parlumeNotesItems: parlumeNoteItemsRecord(items),
					parlumeNotesStatus: "COMPLETED",
				},
			},
		});
		// What the anchor check dropped, for the rate of unsupported notes.
		parlumeActivityLog("info", "notes.anchored", {
			sessionId: session.id,
			parts,
			regenerated: input.regenerate === true,
			...stats,
		});
	} catch (error) {
		// Every plan spent: the workflow waits for a reset and runs this once
		// more. A plan that ran out mid-reply, like any other failure, is
		// Temporal's to retry until its last attempt.
		const spent = findPlanExhausted(error);
		if (spent && input.finalAttempt !== true) {
			throw spent;
		}
		if (!spent && !lastAttempt) {
			throw findWorkflowHandledPlanRefusal(error) ?? error;
		}
		logger.error("[Parlume] Meeting notes failed", {
			sessionId: session.id,
			error: error instanceof Error ? error.message : String(error),
		});
		await db.projectContext.update({
			where: { id: context.id },
			data: {
				metadata: {
					...metadata,
					parlumeNotesStatus: "FAILED",
				},
			},
		});
	}
}
