// Portions of this file are derived from Corsair (https://github.com/corsairdotdev/corsair)
// Original work © Corsair contributors. Licensed under Apache-2.0.
// Modifications © TechFabric LLC. Licensed under MIT (see the containing package's LICENSE).
// See THIRD_PARTY_NOTICES.md at the repository root for full attribution.

/**
 * @fabricorg/integrations-gmail
 *   import "@fabricorg/integrations-gmail";              // SDK consumers (types)
 *   import { gmailPlugin } from "@fabricorg/integrations-gmail";  // portal (runtime)
 */

import { defineIntegration, endpoint } from "@fabricorg/integrations-runtime";
// Force resolution of @fabricorg/sdk for module augmentation below.
import type {} from "@fabricorg/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Typed surface
// ─────────────────────────────────────────────────────────────────────────────

export interface GmailIntegrationClient {
	messages: {
		list(args?: {
			q?: string;
			maxResults?: number;
			pageToken?: string;
			labelIds?: string[];
		}): Promise<GmailMessageList>;
		get(args: {
			id: string;
			format?: "full" | "metadata" | "minimal" | "raw";
		}): Promise<GmailMessage>;
		send(args: { raw: string }): Promise<GmailMessage>;
		trash(args: { id: string }): Promise<GmailMessage>;
		untrash(args: { id: string }): Promise<GmailMessage>;
		delete(args: { id: string }): Promise<{ ok: boolean }>;
	};
	labels: {
		list(): Promise<{ labels?: GmailLabel[] }>;
	};
}

export interface GmailMessage {
	id: string;
	threadId?: string;
	labelIds?: string[];
	snippet?: string;
	historyId?: string;
	internalDate?: string;
	payload?: unknown;
}
export interface GmailMessageList {
	messages?: Array<{ id: string; threadId: string }>;
	nextPageToken?: string;
	resultSizeEstimate?: number;
}
export interface GmailLabel {
	id: string;
	name: string;
	type: "system" | "user";
}

declare module "@fabricorg/sdk" {
	interface FabricIntegrations {
		gmail: GmailIntegrationClient;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

function token(creds: Record<string, unknown>): string {
	const t = creds.access_token ?? creds.token;
	if (typeof t !== "string") {
		throw new Error("gmail: missing OAuth access_token in credentials");
	}
	return t;
}

async function gmailFetch<T>(
	method: "GET" | "POST" | "DELETE",
	path: string,
	tok: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`${GMAIL_API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${tok}`,
			"Content-Type": "application/json",
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (res.status === 204) {
		return { ok: true } as T;
	}
	return (await res.json()) as T;
}

function qs(params: Record<string, unknown> | undefined): string {
	if (!params) {
		return "";
	}
	const parts: string[] = [];
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined) {
			continue;
		}
		if (Array.isArray(v)) {
			for (const item of v) {
				parts.push(`${k}=${encodeURIComponent(String(item))}`);
			}
		} else {
			parts.push(`${k}=${encodeURIComponent(String(v))}`);
		}
	}
	return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export const gmailPlugin = defineIntegration({
	slug: "gmail",
	name: "Gmail",
	endpoints: {
		"messages.list": endpoint(
			(
				ctx,
				args?: {
					q?: string;
					maxResults?: number;
					pageToken?: string;
					labelIds?: string[];
				},
			) =>
				gmailFetch<GmailMessageList>(
					"GET",
					`/messages${qs(args)}`,
					token(ctx.credentials),
				),
			{
				riskLevel: "read",
				description: "List Gmail messages matching a query",
			},
		),
		"messages.get": endpoint(
			(
				ctx,
				args: {
					id: string;
					format?: "full" | "metadata" | "minimal" | "raw";
				},
			) =>
				gmailFetch<GmailMessage>(
					"GET",
					`/messages/${args.id}${qs({ format: args.format })}`,
					token(ctx.credentials),
				),
			{ riskLevel: "read", description: "Fetch a single message by id" },
		),
		"messages.send": endpoint(
			(ctx, args: { raw: string }) =>
				gmailFetch<GmailMessage>(
					"POST",
					"/messages/send",
					token(ctx.credentials),
					args,
				),
			{
				riskLevel: "write",
				description: "Send an email (raw RFC-2822 base64url body)",
			},
		),
		"messages.trash": endpoint(
			(ctx, args: { id: string }) =>
				gmailFetch<GmailMessage>(
					"POST",
					`/messages/${args.id}/trash`,
					token(ctx.credentials),
				),
			{
				riskLevel: "write",
				description: "Move a message to trash (recoverable)",
			},
		),
		"messages.untrash": endpoint(
			(ctx, args: { id: string }) =>
				gmailFetch<GmailMessage>(
					"POST",
					`/messages/${args.id}/untrash`,
					token(ctx.credentials),
				),
			{ riskLevel: "write", description: "Restore a message from trash" },
		),
		"messages.delete": endpoint(
			(ctx, args: { id: string }) =>
				gmailFetch<{ ok: boolean }>(
					"DELETE",
					`/messages/${args.id}`,
					token(ctx.credentials),
				),
			{
				riskLevel: "destructive",
				irreversible: true,
				description:
					"Permanently delete a message (cannot be recovered)",
			},
		),
		"labels.list": endpoint(
			(ctx) =>
				gmailFetch<{ labels?: GmailLabel[] }>(
					"GET",
					"/labels",
					token(ctx.credentials),
				),
			{ riskLevel: "read", description: "List labels" },
		),
	},
	permissions: { mode: "cautious" },
	oauth: {
		type: "oauth2",
		authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		scopes: [
			"https://www.googleapis.com/auth/gmail.readonly",
			"https://www.googleapis.com/auth/gmail.send",
			"https://www.googleapis.com/auth/gmail.modify",
		],
		extras: { access_type: "offline", prompt: "consent" },
	},
	// Gmail uses Pub/Sub push notifications, not direct webhook signatures.
	// Verification typically happens by validating the JWT in the
	// Authorization header — left to the portal's pub/sub handler.
});
