import { getLinkedTeamsChatGraphId } from "@repo/database";

/**
 * Teams deep link to the root message a Teams chat proposal was drafted from,
 * in Microsoft's documented
 * `https://teams.microsoft.com/l/message/<chatId>/<messageId>?context=…` form.
 *
 * A chat proposal stores no link of its own: Graph returns no `webUrl` for chat
 * messages, and the chat monitor keeps only the Fabric-side `linkedChatId`. The
 * Graph chat id therefore comes from the linked chat, scoped to the proposal's
 * project. Null for other sources, for an unlinked chat, and for ids outside the
 * shapes Graph issues (`19:…` chat ids, numeric message ids), so nothing else
 * reaches the URL.
 */
export async function resolveTeamsChatSourceLink(proposal: {
	source: string;
	projectId: string;
	sourceMetadata: unknown;
}): Promise<string | null> {
	const metadata = proposal.sourceMetadata;
	if (
		proposal.source !== "TEAMS_CHAT" ||
		typeof metadata !== "object" ||
		metadata === null ||
		!("linkedChatId" in metadata) ||
		typeof metadata.linkedChatId !== "string" ||
		!("threadRootId" in metadata) ||
		typeof metadata.threadRootId !== "string" ||
		!/^\d+$/.test(metadata.threadRootId)
	) {
		return null;
	}
	const chatId = await getLinkedTeamsChatGraphId(
		proposal.projectId,
		metadata.linkedChatId,
	);
	if (!chatId || !/^19:[^/?#\s]+$/.test(chatId)) {
		return null;
	}
	const context = encodeURIComponent(JSON.stringify({ contextType: "chat" }));
	return `https://teams.microsoft.com/l/message/${chatId}/${metadata.threadRootId}?context=${context}`;
}
