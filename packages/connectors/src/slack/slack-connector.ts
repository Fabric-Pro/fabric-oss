/**
 * Slack Connector
 *
 * Syncs Slack workspace data including messages, threads, and files.
 * Implements the three-phase sync pattern:
 * 1. Full Sync - Initial fetch of all messages
 * 2. Incremental Sync - Fetch new messages since last sync
 * 3. Garbage Collection - Remove deleted messages
 */

import { WebClient } from "@slack/web-api";
import { BaseConnector, registerConnector } from "../base-connector";
import type {
	ConnectorConfig,
	ConnectorCredentials,
	ConnectorDocument,
	ConnectorDocumentMetadata,
	ConnectorProvider,
	SlackConfig,
	SlackMessage,
	SyncCursor,
	SyncProgress,
	SyncResult,
} from "../types";

// =============================================================================
// Constants
// =============================================================================

const BATCH_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 1000; // Slack rate limit: ~1 req/sec for conversations.history

// =============================================================================
// Slack Connector Implementation
// =============================================================================

export class SlackConnector extends BaseConnector {
	provider: ConnectorProvider = "SLACK";

	private getClient(credentials: ConnectorCredentials): WebClient {
		if (!credentials.accessToken) {
			throw new Error("Slack access token is required");
		}
		return new WebClient(credentials.accessToken);
	}

	// =========================================================================
	// Connection
	// =========================================================================

	async testConnection(config: ConnectorConfig): Promise<boolean> {
		try {
			const client = this.getClient(config.credentials);
			const result = await client.auth.test();
			return result.ok === true;
		} catch {
			return false;
		}
	}

	getOAuthUrl(redirectUri: string, state: string): string {
		const clientId = process.env.SLACK_CLIENT_ID;
		if (!clientId) {
			throw new Error("SLACK_CLIENT_ID environment variable is required");
		}

		const scopes = [
			"channels:history",
			"channels:read",
			"files:read",
			"groups:history",
			"groups:read",
			"users:read",
		].join(",");

		return `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
	}

	async exchangeOAuthCode(
		code: string,
		redirectUri: string,
	): Promise<ConnectorCredentials> {
		const clientId = process.env.SLACK_CLIENT_ID;
		const clientSecret = process.env.SLACK_CLIENT_SECRET;

		if (!clientId || !clientSecret) {
			throw new Error(
				"SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required",
			);
		}

		const client = new WebClient();
		const result = await client.oauth.v2.access({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: redirectUri,
		});

		if (!result.ok || !result.access_token) {
			throw new Error("Failed to exchange OAuth code");
		}

		return {
			accessToken: result.access_token,
			// Slack v2 OAuth: user token for search:read scope
			userAccessToken: result.authed_user?.access_token,
			// Slack tokens don't expire unless revoked
		};
	}

	// =========================================================================
	// Full Sync
	// =========================================================================

	async fullSync(
		config: ConnectorConfig,
		onProgress: (progress: SyncProgress) => void,
	): Promise<SyncResult> {
		const startTime = Date.now();
		const client = this.getClient(config.credentials);
		const slackConfig = config.providerConfig as unknown as SlackConfig;

		let itemsProcessed = 0;
		let itemsAdded = 0;
		const documents: ConnectorDocument[] = [];

		try {
			// Phase 1: Get channels
			onProgress(
				this.createProgress(config.id, "Fetching channels", 0, 0, 0),
			);

			const channels = await this.getChannels(client, slackConfig);

			// Phase 2: Fetch messages from each channel
			const totalChannels = channels.length;

			for (let i = 0; i < channels.length; i++) {
				const channel = channels[i];

				onProgress(
					this.createProgress(
						config.id,
						`Syncing channel: ${channel.name}`,
						Math.round((i / totalChannels) * 100),
						itemsProcessed,
						0,
					),
				);

				const messages = await this.fetchChannelMessages(
					client,
					channel.id,
					slackConfig,
				);

				for (const msg of messages) {
					const doc = this.transformToDocument(config.id, {
						message: msg,
						channel,
					});
					documents.push(doc);
					itemsAdded++;
				}

				itemsProcessed += messages.length;

				// Rate limiting
				await this.sleep(RATE_LIMIT_DELAY_MS);
			}

			// Phase 3: Store documents
			onProgress(
				this.createProgress(
					config.id,
					"Storing documents",
					90,
					itemsProcessed,
					itemsProcessed,
				),
			);

			// TODO: Store documents in database and Qdrant
			// await this.storeDocuments(config, documents);

			return this.createSuccessResult(config.id, "full", {
				itemsProcessed,
				itemsAdded,
				itemsUpdated: 0,
				itemsDeleted: 0,
				durationMs: Date.now() - startTime,
			});
		} catch (error) {
			return this.createErrorResult(
				config.id,
				"full",
				error instanceof Error ? error.message : "Unknown error",
				Date.now() - startTime,
			);
		}
	}

	// =========================================================================
	// Incremental Sync
	// =========================================================================

	async incrementalSync(
		config: ConnectorConfig,
		cursor: SyncCursor | null,
		onProgress: (progress: SyncProgress) => void,
	): Promise<{ result: SyncResult; newCursor: SyncCursor }> {
		const startTime = Date.now();
		const client = this.getClient(config.credentials);
		const slackConfig = config.providerConfig as unknown as SlackConfig;

		let itemsProcessed = 0;
		let itemsAdded = 0;
		let itemsUpdated = 0;

		// Parse cursor - contains last sync timestamp per channel
		const lastSyncTimestamps: Record<string, string> =
			(cursor?.metadata?.channelTimestamps as Record<string, string>) ||
			{};

		const newTimestamps: Record<string, string> = { ...lastSyncTimestamps };

		try {
			const channels = await this.getChannels(client, slackConfig);

			for (const channel of channels) {
				onProgress(
					this.createProgress(
						config.id,
						`Incremental sync: ${channel.name}`,
						0,
						itemsProcessed,
						0,
					),
				);

				const oldestTs = lastSyncTimestamps[channel.id];
				const messages = await this.fetchChannelMessages(
					client,
					channel.id,
					slackConfig,
					oldestTs,
				);

				for (const msg of messages) {
					const _doc = this.transformToDocument(config.id, {
						message: msg,
						channel,
					});

					// Check if document exists (would be update vs add)
					// TODO: Check database for existing document
					const isUpdate = false; // Placeholder

					if (isUpdate) {
						itemsUpdated++;
					} else {
						itemsAdded++;
					}

					// Track latest timestamp for this channel
					if (
						!newTimestamps[channel.id] ||
						msg.ts > newTimestamps[channel.id]
					) {
						newTimestamps[channel.id] = msg.ts;
					}
				}

				itemsProcessed += messages.length;
				await this.sleep(RATE_LIMIT_DELAY_MS);
			}

			const newCursor = this.createCursor(
				config.id,
				new Date().toISOString(),
				"incremental",
				{ channelTimestamps: newTimestamps },
			);

			return {
				result: this.createSuccessResult(config.id, "incremental", {
					itemsProcessed,
					itemsAdded,
					itemsUpdated,
					itemsDeleted: 0,
					durationMs: Date.now() - startTime,
				}),
				newCursor,
			};
		} catch (error) {
			return {
				result: this.createErrorResult(
					config.id,
					"incremental",
					error instanceof Error ? error.message : "Unknown error",
					Date.now() - startTime,
				),
				newCursor: cursor || this.createCursor(config.id, ""),
			};
		}
	}

	// =========================================================================
	// Garbage Collection
	// =========================================================================

	async garbageCollect(
		config: ConnectorConfig,
		onProgress: (progress: SyncProgress) => void,
	): Promise<SyncResult> {
		const startTime = Date.now();
		const itemsDeleted = 0;

		try {
			onProgress(
				this.createProgress(
					config.id,
					"Checking for deleted messages",
					0,
					0,
					0,
				),
			);

			// TODO: Implement GC logic
			// 1. Get all document IDs from database for this connector
			// 2. Check each message still exists in Slack
			// 3. Delete documents that no longer exist

			return this.createSuccessResult(config.id, "gc", {
				itemsProcessed: 0,
				itemsAdded: 0,
				itemsUpdated: 0,
				itemsDeleted,
				durationMs: Date.now() - startTime,
			});
		} catch (error) {
			return this.createErrorResult(
				config.id,
				"gc",
				error instanceof Error ? error.message : "Unknown error",
				Date.now() - startTime,
			);
		}
	}

	// =========================================================================
	// Webhook Handler
	// =========================================================================

	async handleWebhook(
		config: ConnectorConfig,
		payload: unknown,
	): Promise<ConnectorDocument[]> {
		const event = payload as {
			type: string;
			event?: {
				type: string;
				channel: string;
				ts: string;
				user: string;
				text: string;
				thread_ts?: string;
			};
		};

		if (event.type !== "event_callback" || !event.event) {
			return [];
		}

		const { event: slackEvent } = event;

		if (slackEvent.type === "message" && slackEvent.text) {
			const doc = this.transformToDocument(config.id, {
				message: {
					ts: slackEvent.ts,
					channel: slackEvent.channel,
					user: slackEvent.user,
					text: slackEvent.text,
					threadTs: slackEvent.thread_ts,
				} as SlackMessage,
				channel: { id: slackEvent.channel, name: "unknown" },
			});

			return [doc];
		}

		return [];
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private async getChannels(
		client: WebClient,
		config: SlackConfig,
	): Promise<Array<{ id: string; name: string }>> {
		const result = await client.conversations.list({
			types: "public_channel,private_channel",
			limit: 1000,
		});

		if (!result.ok || !result.channels) {
			throw new Error("Failed to fetch channels");
		}

		let channels = result.channels.flatMap((channel) => {
			if (!channel.id || !channel.name) {
				return [];
			}

			return [{ id: channel.id, name: channel.name }];
		});

		// Apply filters
		if (config.channels?.length) {
			channels = channels.filter((c) => config.channels?.includes(c.id));
		}

		if (config.excludeChannels?.length) {
			channels = channels.filter(
				(c) => !config.excludeChannels?.includes(c.id),
			);
		}

		return channels;
	}

	private async fetchChannelMessages(
		client: WebClient,
		channelId: string,
		config: SlackConfig,
		oldestTs?: string,
	): Promise<SlackMessage[]> {
		const messages: SlackMessage[] = [];
		let cursor: string | undefined;

		do {
			const result = await this.retryWithBackoff(() =>
				client.conversations.history({
					channel: channelId,
					limit: BATCH_SIZE,
					cursor,
					oldest: oldestTs,
				}),
			);

			if (!result.ok || !result.messages) {
				break;
			}

			for (const msg of result.messages) {
				if (msg.type === "message" && msg.ts && msg.text) {
					const slackMsg: SlackMessage = {
						ts: msg.ts,
						channel: channelId,
						user: msg.user || "unknown",
						text: msg.text,
						threadTs: msg.thread_ts,
					};

					messages.push(slackMsg);

					// Fetch thread replies if enabled
					if (config.includeThreads && msg.thread_ts === msg.ts) {
						const replies = await this.fetchThreadReplies(
							client,
							channelId,
							msg.ts,
						);
						messages.push(...replies);
					}
				}
			}

			cursor = result.response_metadata?.next_cursor;
			await this.sleep(RATE_LIMIT_DELAY_MS);
		} while (cursor);

		return messages;
	}

	private async fetchThreadReplies(
		client: WebClient,
		channelId: string,
		threadTs: string,
	): Promise<SlackMessage[]> {
		const result = await this.retryWithBackoff(() =>
			client.conversations.replies({
				channel: channelId,
				ts: threadTs,
				limit: 100,
			}),
		);

		if (!result.ok || !result.messages) {
			return [];
		}

		return result.messages.flatMap((message) => {
			if (message.ts === threadTs || !message.ts || !message.text) {
				return [];
			}

			return [
				{
					ts: message.ts,
					channel: channelId,
					user: message.user || "unknown",
					text: message.text,
					threadTs,
				},
			];
		});
	}

	protected transformToDocument(
		connectorId: string,
		rawItem: unknown,
	): ConnectorDocument {
		const { message, channel } = rawItem as {
			message: SlackMessage;
			channel: { id: string; name: string };
		};

		const metadata: ConnectorDocumentMetadata = {
			provider: "SLACK",
			source: `#${channel.name}`,
			author: message.user,
			channelId: channel.id,
			threadTs: message.threadTs,
		};

		return {
			id: `slack_${message.channel}_${message.ts}`,
			connectorId,
			externalId: message.ts,
			externalUrl: `slack://channel?team=&id=${message.channel}&message=${message.ts}`,
			title: `Message in #${channel.name}`,
			content: message.text,
			contentType: "text/plain",
			metadata,
			syncedAt: new Date(),
			embeddingStatus: "pending",
		};
	}
}

// Register the connector
registerConnector("SLACK", () => new SlackConnector());
