/**
 * One-time backfill: for every monitored Teams channel/chat
 * (`ProjectLinkedTeamsChannel` / `ProjectLinkedTeamsChat`) that lacks a matching
 * `ProjectContext` INTEGRATION row, create one so it shows up in the on-demand
 * AI Update source picker and is fetchable by backlog analysis.
 *
 * Channels/chats linked via the Add-Context dialog already have a context; only
 * ones linked via the Project Settings monitor path (which historically wrote
 * only the monitor row) are missing it. Idempotent — rows that already have a
 * context are skipped. Dry-run by default; pass --apply to write.
 */
import { db } from "../prisma/client";
import {
	ensureTeamsChannelIntegrationContext,
	ensureTeamsChatIntegrationContext,
	teamsChannelContextMatches,
	teamsChatContextMatches,
} from "../prisma/queries/projects/teams-integration-context";

const apply = process.argv.includes("--apply");

async function projectHasContext(
	projectId: string,
	matches: (metadata: unknown) => boolean,
): Promise<boolean> {
	const contexts = await db.projectContext.findMany({
		where: { projectId, type: "INTEGRATION" },
		select: { metadata: true },
	});
	return contexts.some((ctx) => matches(ctx.metadata));
}

async function main() {
	let channelsCreated = 0;
	let chatsCreated = 0;
	let skipped = 0;

	const channels = await db.projectLinkedTeamsChannel.findMany({
		select: {
			projectId: true,
			teamId: true,
			channelId: true,
			teamName: true,
			channelName: true,
			userId: true,
			organizationId: true,
			// Fallback owner when the monitor row carries no userId (createContext
			// requires one for tenant isolation).
			project: { select: { userId: true } },
		},
	});
	for (const c of channels) {
		if (apply) {
			const result = await ensureTeamsChannelIntegrationContext({
				projectId: c.projectId,
				teamId: c.teamId,
				channelId: c.channelId,
				teamName: c.teamName,
				channelName: c.channelName,
				userId: c.userId ?? c.project.userId,
				organizationId: c.organizationId ?? undefined,
			});
			if (result.created) {
				channelsCreated += 1;
				console.log(
					`channel ${c.channelId} (project ${c.projectId}) -> context ${result.contextId}`,
				);
			} else {
				skipped += 1;
			}
		} else {
			const has = await projectHasContext(c.projectId, (m) =>
				teamsChannelContextMatches(m, {
					teamId: c.teamId,
					channelId: c.channelId,
				}),
			);
			if (has) {
				skipped += 1;
			} else {
				channelsCreated += 1;
				console.log(
					`WOULD create channel context for ${c.channelId} (project ${c.projectId}) (dry-run)`,
				);
			}
		}
	}

	const chats = await db.projectLinkedTeamsChat.findMany({
		select: {
			projectId: true,
			chatId: true,
			chatTopic: true,
			userId: true,
			organizationId: true,
			project: { select: { userId: true } },
		},
	});
	for (const chat of chats) {
		if (apply) {
			const result = await ensureTeamsChatIntegrationContext({
				projectId: chat.projectId,
				chatId: chat.chatId,
				chatTopic: chat.chatTopic,
				userId: chat.userId ?? chat.project.userId,
				organizationId: chat.organizationId ?? undefined,
			});
			if (result.created) {
				chatsCreated += 1;
				console.log(
					`chat ${chat.chatId} (project ${chat.projectId}) -> context ${result.contextId}`,
				);
			} else {
				skipped += 1;
			}
		} else {
			const has = await projectHasContext(chat.projectId, (m) =>
				teamsChatContextMatches(m, { chatId: chat.chatId }),
			);
			if (has) {
				skipped += 1;
			} else {
				chatsCreated += 1;
				console.log(
					`WOULD create chat context for ${chat.chatId} (project ${chat.projectId}) (dry-run)`,
				);
			}
		}
	}

	console.log(
		`done. channelsCreated=${channelsCreated} chatsCreated=${chatsCreated} skipped=${skipped} mode=${apply ? "APPLY" : "DRY-RUN"}`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Backfill failed:", err);
		process.exit(1);
	});
