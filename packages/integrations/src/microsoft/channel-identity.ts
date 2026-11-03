import { z } from "zod";
import type { GraphFetch } from "./stream-transcript";

const idsSchema = z.object({
	value: z.array(z.object({ id: z.string() })),
});

/** Resolve membership without requiring access to the channel's files. */
export async function resolveChannelIdentity(
	graphFetch: GraphFetch,
	graphBaseUrl: string,
	channelId: string,
): Promise<{ teamId: string; channelId: string } | null> {
	const response = await graphFetch(
		`${graphBaseUrl}/me/joinedTeams?$select=id,displayName`,
	);
	if (!response.ok) {
		throw new Error(
			`Microsoft channel membership unavailable (HTTP ${response.status}). Reconnect Microsoft and check channel access.`,
		);
	}
	const teams = idsSchema.parse(await response.json());
	for (const team of teams.value.slice(0, 200)) {
		const response = await graphFetch(
			`${graphBaseUrl}/teams/${encodeURIComponent(team.id)}/channels?$select=id,displayName`,
		);
		if (!response.ok) {
			continue;
		}
		const channels = idsSchema.parse(await response.json());
		if (channels.value.some((channel) => channel.id === channelId)) {
			return { teamId: team.id, channelId };
		}
	}
	return null;
}
