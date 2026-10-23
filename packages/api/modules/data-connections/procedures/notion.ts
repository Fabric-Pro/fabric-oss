/**
 * Notion-specific Data Connection Procedures
 *
 * Browse Notion pages directly via the Notion API without requiring a sync first.
 */

import { ORPCError } from "@orpc/client";
import { getDataConnectionById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { fetchNotionBlocksAsText } from "../lib/notion-content";

interface NotionSearchResult {
	object: string;
	id: string;
	url: string;
	last_edited_time: string;
	icon?: { type: string; emoji?: string } | null;
	properties: Record<
		string,
		{
			type: string;
			title?: Array<{ plain_text: string }>;
			[key: string]: unknown;
		}
	>;
}

interface NotionSearchResponse {
	results: NotionSearchResult[];
	has_more: boolean;
	next_cursor: string | null;
}

function extractNotionPageTitle(page: NotionSearchResult): string {
	for (const prop of Object.values(page.properties)) {
		if (prop.type === "title" && Array.isArray(prop.title)) {
			const text = prop.title.map((t) => t.plain_text).join("");
			if (text.trim()) {
				return text.trim();
			}
		}
	}
	return "Untitled";
}

async function fetchNotionPages(
	accessToken: string,
	query: string,
	initialCursor?: string,
): Promise<{ results: NotionSearchResult[]; nextCursor: string | null }> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"Notion-Version": "2022-06-28",
	};

	const allResults: NotionSearchResult[] = [];
	let cursor: string | undefined = initialCursor;
	let hasMore = false;
	let lastCursor: string | null = null;

	for (let i = 0; i < 2; i++) {
		const body: Record<string, unknown> = {
			filter: { value: "page", property: "object" },
			page_size: 50,
			query: query ?? "",
		};

		if (cursor) {
			body.start_cursor = cursor;
		}

		const response = await fetch("https://api.notion.com/v1/search", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			if (response.status === 401) {
				throw new ORPCError("UNAUTHORIZED", {
					message: "Notion connection expired. Reconnect Notion.",
				});
			}
			const errorText = await response
				.text()
				.catch(() => "unknown error");
			throw new ORPCError("BAD_REQUEST", {
				message: `Notion API error: ${response.status} ${errorText}`,
			});
		}

		const data = (await response.json()) as NotionSearchResponse;
		allResults.push(...data.results);
		hasMore = data.has_more;
		lastCursor = data.next_cursor;

		if (!data.has_more || !data.next_cursor) {
			break;
		}

		cursor = data.next_cursor;
	}

	return {
		results: allResults,
		nextCursor: hasMore ? lastCursor : null,
	};
}

/**
 * List Notion pages directly from the Notion API.
 * AUTHORIZATION: Verifies connection belongs to the tenant.
 */
const listNotionPagesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_READ))
	.route({
		method: "GET",
		path: "/data-connections/:id/notion/pages",
		tags: ["DataConnections", "Notion"],
		summary: "List Notion pages",
		description:
			"Browse Notion pages directly via the Notion API without requiring a sync.",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			query: z.string().optional(),
			cursor: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

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

		const connection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}

		if (connection.provider !== "NOTION") {
			throw new ORPCError("BAD_REQUEST", {
				message: "This connection is not a Notion connection",
			});
		}

		if (!connection.accessToken) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Notion connection is missing an access token",
			});
		}

		const { results: rawPages, nextCursor } = await fetchNotionPages(
			connection.accessToken,
			input.query ?? "",
			input.cursor,
		);

		const pages = rawPages.map((page) => ({
			id: page.id,
			title: extractNotionPageTitle(page),
			url: page.url,
			lastEdited: page.last_edited_time,
			icon:
				page.icon?.type === "emoji" && page.icon.emoji
					? page.icon.emoji
					: null,
		}));

		return { pages, nextCursor };
	});

/**
 * Get Notion page content directly from the Notion API.
 * AUTHORIZATION: Verifies connection belongs to the tenant.
 */
const getNotionPageContentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_READ))
	.route({
		method: "GET",
		path: "/data-connections/:id/notion/pages/:pageId/content",
		tags: ["DataConnections", "Notion"],
		summary: "Get Notion page content",
		description:
			"Fetch Notion page blocks and return them as plain text/markdown.",
	})
	.input(
		z.object({
			id: z.string(),
			pageId: z.string().regex(/^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

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

		const connection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}

		if (connection.provider !== "NOTION") {
			throw new ORPCError("BAD_REQUEST", {
				message: "This connection is not a Notion connection",
			});
		}

		if (!connection.accessToken) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Notion connection is missing an access token",
			});
		}

		const content = await fetchNotionBlocksAsText(
			input.pageId,
			connection.accessToken,
		);

		return { content };
	});

export const notionProcedures = {
	pages: listNotionPagesProcedure,
	pageContent: getNotionPageContentProcedure,
};
