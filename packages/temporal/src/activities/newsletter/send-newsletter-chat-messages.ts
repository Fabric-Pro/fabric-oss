import {
	buildReleaseNotesUrl,
	isProjectReadOnly,
	type NewsletterChatChannel,
	type NewsletterContent,
} from "@repo/database";
import { logger } from "@repo/logs";
import { renderNewsletterChatMessage } from "@repo/utils";
import { heartbeat } from "@temporalio/activity";
import { deliverChatMessages } from "./chat-delivery-engine";

export interface SendNewsletterChatMessagesInput {
	sendId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	projectName: string;
	content: NewsletterContent;
	chatChannels: NewsletterChatChannel[];
}
export interface SendNewsletterChatMessagesOutput {
	targetCount: number;
	sentCount: number;
	failedCount: number;
	skippedCount: number;
}

export async function sendNewsletterChatMessagesActivity(
	input: SendNewsletterChatMessagesInput,
): Promise<SendNewsletterChatMessagesOutput> {
	heartbeat("sendNewsletterChatMessages:start");

	// Read-only mode: posting a newsletter to linked Slack/Teams
	// is an outbound write to connected sources. This activity dispatches via
	// raw provider fetch / the Teams executor (outside the MCP funnel), so it
	// gates here directly — projectId is on the input, so the whole send is
	// skipped while the project is read-only. Background skip → no toast (AC5).
	if (await isProjectReadOnly(input.projectId)) {
		logger.info(
			"[Newsletter] Skipped chat send — project is in Read-only mode",
			{ projectId: input.projectId, sendId: input.sendId },
		);
		return {
			targetCount: input.chatChannels.length,
			sentCount: 0,
			failedCount: 0,
			skippedCount: input.chatChannels.length,
		};
	}

	// Org projects live under /app/{slug}/projects/{id}; resolve the correct
	// tenant-scoped URL (the personal route would 404 for org sends) via the
	// canonical helper, which also uses the worker-safe base-URL chain.
	const link = await buildReleaseNotesUrl({
		projectId: input.projectId,
		organizationId: input.organizationId,
	});

	return deliverChatMessages({
		sendId: input.sendId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		kind: "CONTENT",
		channels: input.chatChannels,
		// Two positional arguments and a `{ text }` result — this is
		// `renderNewsletterChatMessage`'s existing signature, not an object
		// spread. Preserved exactly so the extraction stays a pure move.
		renderText: (platform) =>
			renderNewsletterChatMessage(
				{
					headline: input.content.headline,
					intro: input.content.intro,
					highlights: input.content.highlights,
				},
				{ platform, link },
			).text,
	});
}
