/**
 * Slack Federated Search
 *
 * Real-time search across Slack messages using the Slack search.messages API.
 * Supplements indexed Slack data with live results for freshness-sensitive queries.
 *
 * Respects live permissions — only returns messages the authenticated user can see.
 */

import {
	FederatedConnector,
	registerFederatedConnector,
} from "../federated-connector";
import type { FederatedSearchOptions, FederatedSearchResult } from "../types";

export class SlackFederatedConnector extends FederatedConnector {
	readonly provider = "SLACK" as const;

	async federatedSearch(
		options: FederatedSearchOptions,
	): Promise<FederatedSearchResult[]> {
		const { query, config, maxResults = 10 } = options;
		// Prefer user token for search.messages (requires user-scoped search:read)
		const token =
			config.credentials.userAccessToken ||
			config.credentials.accessToken;

		if (!token) {
			throw new Error("Slack access token required for federated search");
		}

		// Use Slack's search.messages API for real-time search
		const response = await fetch(
			`https://slack.com/api/search.messages?${new URLSearchParams({
				query,
				count: String(maxResults),
				sort: "timestamp",
				sort_dir: "desc",
			})}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
			},
		);

		if (!response.ok) {
			throw new Error(
				`Slack search failed: ${response.status} ${response.statusText}`,
			);
		}

		const data = (await response.json()) as {
			ok: boolean;
			error?: string;
			messages?: {
				matches?: Array<{
					iid: string;
					text: string;
					username?: string;
					channel?: { name?: string; id?: string };
					permalink?: string;
					ts?: string;
				}>;
			};
		};

		if (!data.ok) {
			throw new Error(`Slack API error: ${data.error}`);
		}

		const matches = data.messages?.matches ?? [];

		return matches.map((msg) => {
			const channelName = msg.channel?.name || "unknown-channel";
			const timestamp = msg.ts
				? new Date(Number.parseFloat(msg.ts) * 1000)
				: undefined;

			return this.buildResult({
				id: msg.iid || `slack-${msg.ts}`,
				title: `Message in #${channelName}`,
				content: this.truncateContent(msg.text || ""),
				url: msg.permalink,
				sourceName: `#${channelName}`,
				externalTimestamp: timestamp,
				author: msg.username,
				metadata: {
					channelId: msg.channel?.id,
					channelName,
					freshness: "live",
				},
			});
		});
	}
}

// Auto-register on import
registerFederatedConnector("SLACK", () => new SlackFederatedConnector());
