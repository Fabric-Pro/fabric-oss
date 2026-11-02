/**
 * Confluence Pages Procedures
 *
 * Procedures to list and fetch Confluence pages via the Confluence Integration connection.
 */

import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	fetchConfluencePageContent,
	getConfluenceCredentials,
	searchConfluencePages,
} from "../lib/confluence-content";

export const confluencePagesProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.INTEGRATION_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/integrations/confluence/pages",
		tags: ["Integrations", "Confluence"],
		summary: "List Confluence pages",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			query: z.string().max(200).optional(),
			cursor: z
				.string()
				.regex(/^\d{1,6}$/)
				.optional(),
		}),
	)
	.output(
		z.object({
			pages: z.array(
				z.object({
					id: z.string(),
					title: z.string(),
					url: z.string(),
					spaceKey: z.string(),
					spaceName: z.string().nullable(),
					lastEdited: z.string().nullable(),
				}),
			),
			nextCursor: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const creds = await getConfluenceCredentials(user.id, organizationId);
		const { pages, nextCursor } = await searchConfluencePages(
			creds,
			input.query,
			input.cursor,
		);

		return { pages, nextCursor };
	});

export const confluencePageContentProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.INTEGRATION_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/integrations/confluence/pages/:pageId/content",
		tags: ["Integrations", "Confluence"],
		summary: "Get Confluence page content",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			pageId: z
				.string()
				.regex(/^\d+$/, "Page ID must contain digits only"),
		}),
	)
	.output(
		z.object({
			content: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const creds = await getConfluenceCredentials(user.id, organizationId);
		const content = await fetchConfluencePageContent(creds, input.pageId);

		return { content };
	});
