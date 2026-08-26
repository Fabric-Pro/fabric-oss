// Portions of this file are derived from Corsair (https://github.com/corsairdotdev/corsair)
// Original work © Corsair contributors. Licensed under Apache-2.0.
// Modifications © TechFabric LLC. Licensed under MIT (see the containing package's LICENSE).
// See THIRD_PARTY_NOTICES.md at the repository root for full attribution.

/**
 * @fabricorg/integrations-slack
 *
 * Importing this package has two effects:
 *   1. Type augmentation — adds `slack` to `FabricIntegrations` so the SDK
 *      offers typed `fabric.integrations.slack.<endpoint>(args)` autocomplete.
 *   2. Runtime export — `slackPlugin` is the `IntegrationPlugin` the portal
 *      registers with `IntegrationsRuntime` to make calls executable.
 *
 *   import "@fabricorg/integrations-slack";              // SDK consumers (types)
 *   import { slackPlugin } from "@fabricorg/integrations-slack";  // portal (runtime)
 *
 * Endpoint surface is intentionally slim (the most-used operations); fill in
 * the long tail on demand. Risk levels mirror Corsair's classification.
 */

import { defineIntegration, endpoint } from "@fabricorg/integrations-runtime";
// Force resolution of @fabricorg/sdk for module augmentation below.
import type {} from "@fabricorg/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Typed surface — augmentation onto @fabricorg/sdk
// ─────────────────────────────────────────────────────────────────────────────

export interface SlackIntegrationClient {
	messages: {
		send(args: {
			channel: string;
			text: string;
			thread_ts?: string;
		}): Promise<SlackMessageResponse>;
		delete(args: { channel: string; ts: string }): Promise<{ ok: boolean }>;
	};
	channels: {
		list(args?: {
			cursor?: string;
			limit?: number;
		}): Promise<SlackChannelsListResponse>;
		create(args: {
			name: string;
			is_private?: boolean;
		}): Promise<SlackChannelResponse>;
		archive(args: { channel: string }): Promise<{ ok: boolean }>;
		invite(args: {
			channel: string;
			users: string;
		}): Promise<SlackChannelResponse>;
	};
	users: {
		list(args?: {
			cursor?: string;
			limit?: number;
		}): Promise<SlackUsersListResponse>;
		get(args: { user: string }): Promise<{ ok: boolean; user: SlackUser }>;
	};
}

export interface SlackUser {
	id: string;
	name: string;
	real_name?: string;
	is_bot?: boolean;
	deleted?: boolean;
}
export interface SlackChannel {
	id: string;
	name: string;
	is_private?: boolean;
	is_archived?: boolean;
}
export interface SlackMessageResponse {
	ok: boolean;
	channel?: string;
	ts?: string;
	message?: { text?: string; user?: string; ts?: string };
}
export interface SlackChannelResponse {
	ok: boolean;
	channel?: SlackChannel;
}
export interface SlackChannelsListResponse {
	ok: boolean;
	channels?: SlackChannel[];
	response_metadata?: { next_cursor?: string };
}
export interface SlackUsersListResponse {
	ok: boolean;
	members?: SlackUser[];
	response_metadata?: { next_cursor?: string };
}

declare module "@fabricorg/sdk" {
	interface FabricIntegrations {
		slack: SlackIntegrationClient;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime — server-side plugin definition
// ─────────────────────────────────────────────────────────────────────────────

const SLACK_API = "https://slack.com/api";

async function slackCall<T>(
	method: string,
	token: string,
	body: unknown,
): Promise<T> {
	const res = await fetch(`${SLACK_API}/${method}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify(body),
	});
	return (await res.json()) as T;
}

function token(creds: Record<string, unknown>): string {
	const t = creds.token ?? creds.access_token ?? creds.bot_token;
	if (typeof t !== "string") {
		throw new Error("slack: missing OAuth bearer token in credentials");
	}
	return t;
}

export const slackPlugin = defineIntegration({
	slug: "slack",
	name: "Slack",
	endpoints: {
		"messages.send": endpoint(
			(
				ctx,
				args: { channel: string; text: string; thread_ts?: string },
			) =>
				slackCall<SlackMessageResponse>(
					"chat.postMessage",
					token(ctx.credentials),
					args,
				),
			{
				riskLevel: "write",
				description: "Send a message to a channel or DM",
			},
		),
		"messages.delete": endpoint(
			(ctx, args: { channel: string; ts: string }) =>
				slackCall<{ ok: boolean }>(
					"chat.delete",
					token(ctx.credentials),
					args,
				),
			{
				riskLevel: "destructive",
				irreversible: true,
				description: "Delete a previously sent message",
			},
		),
		"channels.list": endpoint(
			(ctx, args?: { cursor?: string; limit?: number }) =>
				slackCall<SlackChannelsListResponse>(
					"conversations.list",
					token(ctx.credentials),
					args ?? {},
				),
			{
				riskLevel: "read",
				description: "List channels in the workspace",
			},
		),
		"channels.create": endpoint(
			(ctx, args: { name: string; is_private?: boolean }) =>
				slackCall<SlackChannelResponse>(
					"conversations.create",
					token(ctx.credentials),
					args,
				),
			{ riskLevel: "write", description: "Create a channel" },
		),
		"channels.archive": endpoint(
			(ctx, args: { channel: string }) =>
				slackCall<{ ok: boolean }>(
					"conversations.archive",
					token(ctx.credentials),
					args,
				),
			{
				riskLevel: "destructive",
				description: "Archive a channel (recoverable)",
			},
		),
		"channels.invite": endpoint(
			(ctx, args: { channel: string; users: string }) =>
				slackCall<SlackChannelResponse>(
					"conversations.invite",
					token(ctx.credentials),
					args,
				),
			{ riskLevel: "write", description: "Invite users to a channel" },
		),
		"users.list": endpoint(
			(ctx, args?: { cursor?: string; limit?: number }) =>
				slackCall<SlackUsersListResponse>(
					"users.list",
					token(ctx.credentials),
					args ?? {},
				),
			{ riskLevel: "read", description: "List workspace users" },
		),
		"users.get": endpoint(
			(ctx, args: { user: string }) =>
				slackCall<{ ok: boolean; user: SlackUser }>(
					"users.info",
					token(ctx.credentials),
					args,
				),
			{ riskLevel: "read", description: "Get info about a single user" },
		),
	},
	permissions: { mode: "cautious" },
	oauth: {
		type: "oauth2",
		authorizationUrl: "https://slack.com/oauth/v2/authorize",
		tokenUrl: "https://slack.com/api/oauth.v2.access",
		scopes: [
			"channels:read",
			"channels:write",
			"chat:write",
			"groups:read",
			"users:read",
		],
	},
	verifyWebhookSignature: ({ headers }) => {
		// Real verifier would HMAC-SHA256 the raw body with the signing secret
		// from credentials and compare against `x-slack-signature`. Stub returns
		// `unknown` so the WebhookProcessor falls back to its `onUnverified`
		// policy (rejects by default).
		const hasSig = "x-slack-signature" in headers;
		const hasTs = "x-slack-request-timestamp" in headers;
		return hasSig && hasTs ? "unknown" : "invalid";
	},
});
