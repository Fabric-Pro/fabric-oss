/**
 * List Teams Chats for Wizard
 *
 * Lists available Microsoft Teams group chats for the wizard context selection.
 * This is a simplified version that doesn't require a projectId (used during project creation).
 *
 * Supports cursor-based pagination for group chats — the first call returns
 * the first page of chats plus all channels; subsequent calls (with cursor)
 * return only the next page of chats.
 *
 * Prerequisites:
 * - User must have connected their Microsoft account via OAuth (MICROSOFT_GRAPH provider)
 */

import { ORPCError } from "@orpc/client";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

// Response type for a Teams chat
const TeamsChatSchema = z.object({
	id: z.string(),
	topic: z.string(),
	type: z.string(),
	lastUpdated: z.string().nullable().optional(),
	members: z.string(),
	memberCount: z.number(),
	lastMessage: z
		.object({
			from: z.string(),
			preview: z.string(),
			time: z.string().nullable().optional(),
		})
		.nullable(),
});

type TeamsChat = z.infer<typeof TeamsChatSchema>;

// Response type for a Teams channel
const TeamsChannelSchema = z.object({
	id: z.string(),
	name: z.string(),
	teamId: z.string(),
	teamName: z.string(),
	description: z.string().optional(),
	channelType: z.string(),
});

type TeamsChannel = z.infer<typeof TeamsChannelSchema>;

export const listTeamsChatsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workflows/integrations/teams/chats",
		tags: ["Workflows", "Integrations", "Teams"],
		summary: "List Teams chats",
		description:
			"List Microsoft Teams group chats for context selection (no project required)",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			cursor: z.string().optional(),
		}),
	)
	.output(
		z.object({
			chats: z.array(TeamsChatSchema),
			channels: z.array(TeamsChannelSchema),
			count: z.number(),
			isConnected: z.boolean(),
			nextChatsCursor: z.string().nullable().optional(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		try {
			// If cursor is set, we only need the next page of chats (channels already loaded)
			if (input.cursor) {
				const chatsResult = (await executeMicrosoftTeamsTool(
					"list_chats",
					{ chatType: "group", cursor: input.cursor },
					user.id,
					organizationId ?? undefined,
				)) as {
					chats: Array<{
						id: string;
						topic: string;
						type: string;
						lastUpdated: string | null;
						members: string;
						lastMessage: {
							from: string;
							preview: string;
							time: string | null;
						} | null;
					}>;
					count: number;
					nextCursor: string | null;
				};

				const chats: TeamsChat[] = chatsResult.chats.map((chat) => ({
					...chat,
					memberCount: parseMemberCount(chat.members),
				}));

				return {
					chats,
					channels: [],
					count: chatsResult.count,
					isConnected: true,
					nextChatsCursor: chatsResult.nextCursor,
				};
			}

			// First page: fetch group chats and teams+channels in parallel
			const [chatsResult, teamsResult] = await Promise.all([
				executeMicrosoftTeamsTool(
					"list_chats",
					{ chatType: "group" },
					user.id,
					organizationId ?? undefined,
				) as Promise<{
					chats: Array<{
						id: string;
						topic: string;
						type: string;
						lastUpdated: string | null;
						members: string;
						lastMessage: {
							from: string;
							preview: string;
							time: string | null;
						} | null;
					}>;
					count: number;
					nextCursor: string | null;
				}>,
				executeMicrosoftTeamsTool(
					"list_teams",
					{},
					user.id,
					organizationId ?? undefined,
				) as Promise<{
					teams: Array<{
						id: string;
						name: string;
						description: string;
					}>;
					count: number;
				}>,
			]);

			// Transform chats and add member count
			const chats: TeamsChat[] = chatsResult.chats.map((chat) => ({
				...chat,
				memberCount: parseMemberCount(chat.members),
			}));

			// Fetch channels for each team
			const teamsToFetch = teamsResult.teams.slice(0, 50);
			const channelResults = await Promise.all(
				teamsToFetch.map(async (team) => {
					try {
						const result = (await executeMicrosoftTeamsTool(
							"list_channels",
							{ teamId: team.id },
							user.id,
							organizationId ?? undefined,
						)) as {
							channels: Array<{
								id: string;
								name: string;
								description: string;
								type: string;
							}>;
							count: number;
						};
						return result.channels.map((ch) => ({
							id: ch.id,
							name: ch.name,
							teamId: team.id,
							teamName: team.name,
							description: ch.description || undefined,
							channelType: ch.type || "standard",
						}));
					} catch {
						// If fetching channels for a team fails, skip it
						return [];
					}
				}),
			);

			const channels: TeamsChannel[] = channelResults.flat();

			return {
				chats,
				channels,
				count: chatsResult.count + channels.length,
				isConnected: true,
				nextChatsCursor: chatsResult.nextCursor,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";

			// Check if the error is about Microsoft not being connected
			if (
				errorMessage.includes("Microsoft not connected") ||
				errorMessage.includes("Please connect your Microsoft account")
			) {
				return {
					chats: [],
					channels: [],
					count: 0,
					isConnected: false,
					error: "Microsoft account not connected. Please connect your Microsoft account in Settings > Integrations.",
				};
			}

			// Check if token expired and refresh failed
			if (
				errorMessage.includes("expired") ||
				errorMessage.includes("refresh failed")
			) {
				return {
					chats: [],
					channels: [],
					count: 0,
					isConnected: false,
					error: "Microsoft session expired. Please reconnect your Microsoft account in Settings > Integrations.",
				};
			}

			// Re-throw other errors
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to fetch Teams data: ${errorMessage}`,
			});
		}
	});

function parseMemberCount(members: string): number {
	if (!members) {
		return 0;
	}
	const moreMatch = members.match(/\+(\d+) more$/);
	if (moreMatch) {
		const visibleCount = members
			.replace(/\s*\+\d+ more$/, "")
			.split(",").length;
		return visibleCount + Number.parseInt(moreMatch[1], 10);
	}
	return members.split(",").length;
}
