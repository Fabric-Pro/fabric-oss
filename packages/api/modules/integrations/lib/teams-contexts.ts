/**
 * Shared Teams-context parsing for `integrations.teams.getRecentMessages`
 * and `integrations.teams.contextAccess`.
 *
 * A linked Teams chat/channel is persisted as a ProjectContext row of type
 * INTEGRATION with `metadata.provider === "MICROSOFT_TEAMS"`. This extracts
 * the routing info a Graph call needs (chat vs. channel + the relevant
 * Graph ids) plus the ProjectContext row `id` — the per-viewer access probe
 * (Fizzy #2450) keys its response by that row id so the UI can match it back
 * to the exact row being rendered.
 */
export interface ParsedTeamsContext {
	/** ProjectContext row id. */
	id: string;
	type: "chat" | "channel";
	chatId?: string;
	teamId?: string;
	channelId?: string;
	displayName: string;
}

export interface ParseTeamsContextsOptions {
	/** Included in the missing-chatType warning payload, as callers logged it before this was extracted. */
	projectId: string;
	/**
	 * Log-line prefix, e.g. `[getRecentTeamsMessages]` /
	 * `[getTeamsContextAccess]` — kept per-caller (rather than a single
	 * `[parseTeamsContexts]` tag) so the two callers stay individually
	 * greppable in prod logs, matching what each logged before this loop was
	 * shared between them.
	 */
	logTag: string;
}

export function parseTeamsContexts(
	integrationContexts: Array<{ id: string; metadata: unknown }>,
	{ projectId, logTag }: ParseTeamsContextsOptions,
): ParsedTeamsContext[] {
	const contexts: ParsedTeamsContext[] = [];

	for (const ctx of integrationContexts) {
		const metadata = ctx.metadata as Record<string, unknown> | null;
		if (metadata?.provider !== "MICROSOFT_TEAMS") {
			continue;
		}

		const chatType = metadata?.chatType as string | undefined;

		if (!chatType) {
			console.warn(`[${logTag}] Context missing chatType, skipping`, {
				contextId: ctx.id,
				projectId,
			});
			continue;
		}

		if (chatType === "channel" && metadata?.teamId && metadata?.channelId) {
			contexts.push({
				id: ctx.id,
				type: "channel",
				teamId: metadata.teamId as string,
				channelId: metadata.channelId as string,
				displayName: (metadata.chatTopic as string) || "Teams Channel",
			});
		} else if (metadata?.chatId) {
			contexts.push({
				id: ctx.id,
				type: "chat",
				chatId: metadata.chatId as string,
				displayName: (metadata.chatTopic as string) || "Teams Chat",
			});
		}
	}

	return contexts;
}
