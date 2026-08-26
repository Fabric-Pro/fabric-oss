// Portions of this file are derived from Corsair (https://github.com/corsairdotdev/corsair)
// Original work © Corsair contributors. Licensed under Apache-2.0.
// Modifications © TechFabric LLC. Licensed under MIT (see the containing package's LICENSE).
// See THIRD_PARTY_NOTICES.md at the repository root for full attribution.

/**
 * @fabricorg/integrations-notion
 *   import "@fabricorg/integrations-notion";              // SDK consumers (types)
 *   import { notionPlugin } from "@fabricorg/integrations-notion";  // portal (runtime)
 */

import { defineIntegration, endpoint } from "@fabricorg/integrations-runtime";
// Force resolution of @fabricorg/sdk for module augmentation below.
import type {} from "@fabricorg/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Typed surface
// ─────────────────────────────────────────────────────────────────────────────

export interface NotionIntegrationClient {
	pages: {
		get(args: { page_id: string }): Promise<NotionPage>;
		create(args: {
			parent: { database_id?: string; page_id?: string };
			properties: Record<string, unknown>;
			children?: unknown[];
		}): Promise<NotionPage>;
		update(args: {
			page_id: string;
			properties?: Record<string, unknown>;
			archived?: boolean;
		}): Promise<NotionPage>;
	};
	databases: {
		get(args: { database_id: string }): Promise<NotionDatabase>;
		query(args: {
			database_id: string;
			filter?: unknown;
			sorts?: unknown[];
			page_size?: number;
			start_cursor?: string;
		}): Promise<{
			results: NotionPage[];
			next_cursor: string | null;
			has_more: boolean;
		}>;
	};
	blocks: {
		children: {
			list(args: {
				block_id: string;
				start_cursor?: string;
				page_size?: number;
			}): Promise<{
				results: NotionBlock[];
				next_cursor: string | null;
				has_more: boolean;
			}>;
			append(args: {
				block_id: string;
				children: unknown[];
			}): Promise<{ results: NotionBlock[] }>;
		};
		delete(args: { block_id: string }): Promise<NotionBlock>;
	};
	search(args: {
		query?: string;
		page_size?: number;
		start_cursor?: string;
		filter?: { value: "page" | "database"; property: "object" };
	}): Promise<{
		results: Array<NotionPage | NotionDatabase>;
		next_cursor: string | null;
		has_more: boolean;
	}>;
}

export interface NotionPage {
	object: "page";
	id: string;
	created_time: string;
	last_edited_time: string;
	archived: boolean;
	url: string;
	properties: Record<string, unknown>;
	parent?: { type: string; database_id?: string; page_id?: string };
}
export interface NotionDatabase {
	object: "database";
	id: string;
	created_time: string;
	last_edited_time: string;
	url: string;
	title: unknown[];
	properties: Record<string, unknown>;
}
export interface NotionBlock {
	object: "block";
	id: string;
	type: string;
	created_time: string;
	last_edited_time: string;
	archived: boolean;
	has_children: boolean;
}

declare module "@fabricorg/sdk" {
	interface FabricIntegrations {
		notion: NotionIntegrationClient;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function token(creds: Record<string, unknown>): string {
	const t = creds.access_token ?? creds.token ?? creds.api_key;
	if (typeof t !== "string") {
		throw new Error("notion: missing access_token in credentials");
	}
	return t;
}

async function notion<T>(
	method: "GET" | "POST" | "PATCH" | "DELETE",
	path: string,
	tok: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`${NOTION_API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${tok}`,
			"Notion-Version": NOTION_VERSION,
			"Content-Type": "application/json",
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	return (await res.json()) as T;
}

function qs(params: Record<string, unknown> | undefined): string {
	if (!params) {
		return "";
	}
	const entries = Object.entries(params).filter(([, v]) => v !== undefined);
	if (entries.length === 0) {
		return "";
	}
	return `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}`;
}

export const notionPlugin = defineIntegration({
	slug: "notion",
	name: "Notion",
	endpoints: {
		"pages.get": endpoint(
			(ctx, args: { page_id: string }) =>
				notion<NotionPage>(
					"GET",
					`/pages/${args.page_id}`,
					token(ctx.credentials),
				),
			{ riskLevel: "read", description: "Retrieve a page" },
		),
		"pages.create": endpoint(
			(
				ctx,
				args: {
					parent: { database_id?: string; page_id?: string };
					properties: Record<string, unknown>;
					children?: unknown[];
				},
			) =>
				notion<NotionPage>(
					"POST",
					"/pages",
					token(ctx.credentials),
					args,
				),
			{ riskLevel: "write", description: "Create a page" },
		),
		"pages.update": endpoint(
			(
				ctx,
				args: {
					page_id: string;
					properties?: Record<string, unknown>;
					archived?: boolean;
				},
			) => {
				const { page_id, ...body } = args;
				return notion<NotionPage>(
					"PATCH",
					`/pages/${page_id}`,
					token(ctx.credentials),
					body,
				);
			},
			{
				riskLevel: "write",
				description:
					"Update a page (set `archived: true` to soft-delete)",
			},
		),
		"databases.get": endpoint(
			(ctx, args: { database_id: string }) =>
				notion<NotionDatabase>(
					"GET",
					`/databases/${args.database_id}`,
					token(ctx.credentials),
				),
			{ riskLevel: "read", description: "Retrieve a database" },
		),
		"databases.query": endpoint(
			(
				ctx,
				args: {
					database_id: string;
					filter?: unknown;
					sorts?: unknown[];
					page_size?: number;
					start_cursor?: string;
				},
			) => {
				const { database_id, ...body } = args;
				return notion<{
					results: NotionPage[];
					next_cursor: string | null;
					has_more: boolean;
				}>(
					"POST",
					`/databases/${database_id}/query`,
					token(ctx.credentials),
					body,
				);
			},
			{ riskLevel: "read", description: "Query a database" },
		),
		"blocks.children.list": endpoint(
			(
				ctx,
				args: {
					block_id: string;
					start_cursor?: string;
					page_size?: number;
				},
			) =>
				notion<{
					results: NotionBlock[];
					next_cursor: string | null;
					has_more: boolean;
				}>(
					"GET",
					`/blocks/${args.block_id}/children${qs({ start_cursor: args.start_cursor, page_size: args.page_size })}`,
					token(ctx.credentials),
				),
			{ riskLevel: "read", description: "List children of a block" },
		),
		"blocks.children.append": endpoint(
			(ctx, args: { block_id: string; children: unknown[] }) =>
				notion<{ results: NotionBlock[] }>(
					"PATCH",
					`/blocks/${args.block_id}/children`,
					token(ctx.credentials),
					{ children: args.children },
				),
			{ riskLevel: "write", description: "Append children to a block" },
		),
		"blocks.delete": endpoint(
			(ctx, args: { block_id: string }) =>
				notion<NotionBlock>(
					"DELETE",
					`/blocks/${args.block_id}`,
					token(ctx.credentials),
				),
			{
				riskLevel: "destructive",
				description: "Delete a block (recoverable from trash)",
			},
		),
		search: endpoint(
			(
				ctx,
				args: {
					query?: string;
					page_size?: number;
					start_cursor?: string;
					filter?: { value: "page" | "database"; property: "object" };
				},
			) =>
				notion<{
					results: Array<NotionPage | NotionDatabase>;
					next_cursor: string | null;
					has_more: boolean;
				}>("POST", "/search", token(ctx.credentials), args),
			{
				riskLevel: "read",
				description: "Search across pages and databases",
			},
		),
	},
	permissions: { mode: "cautious" },
	oauth: {
		type: "oauth2",
		authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
		tokenUrl: "https://api.notion.com/v1/oauth/token",
	},
	verifyWebhookSignature: ({ headers }) =>
		// Notion webhook signing uses `x-notion-signature`; verifier stub.
		"x-notion-signature" in headers ? "unknown" : "invalid",
});
