import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	URL_PAGES_DEFAULT_LIMIT,
	URL_PAGES_MAX_LIMIT,
	urlPageListFilter,
	urlPageListPage,
} from "../../../projects/procedures/contexts/lib/url-page-listing";
import {
	assertCompanyContextReader,
	loadCompanyContextSourceMeta,
} from "./lib/access";

/**
 * The crawled pages of a company website source (Fizzy #2719) — the
 * company twin of `projects.contexts.listUrlPages`, with the same cursor
 * pagination, status buckets and title/URL search, and likewise without page
 * content.
 *
 * AUTHORIZATION: `ORG_READ` against the requested organization, membership of
 * it, then the company context gate. The parent source is loaded by
 * `(id, organizationId)`, and the pages are read under that organization too.
 */
export const listCompanyContextUrlPagesProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/company-context/{sourceId}/url-pages",
		tags: ["Organizations", "Company context"],
		summary: "List a company context website's pages",
		description:
			"Cursor-paginated list of the pages crawled under a company context website source, without their content.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1),
			sourceId: z.string().min(1),
			cursor: z.string().optional(),
			limit: z
				.number()
				.int()
				.min(1)
				.max(URL_PAGES_MAX_LIMIT)
				.default(URL_PAGES_DEFAULT_LIMIT),
			statusFilter: z
				.enum(["all", "indexed", "processing", "failed"])
				.default("all"),
			search: z.string().trim().max(500).optional(),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const { organizationId, sourceId } = input;
		await assertCompanyContextReader(organizationId, user.id);

		const source = await loadCompanyContextSourceMeta(
			sourceId,
			organizationId,
		);
		if (source.type !== "LINK") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Only a website source has crawled pages",
			});
		}

		const where = {
			parentSourceId: sourceId,
			organizationId,
			...urlPageListFilter(input),
		};

		const [rows, total] = await Promise.all([
			db.companyContextUrlPage.findMany({
				where,
				select: {
					id: true,
					pageUrl: true,
					pageTitle: true,
					lastFetchedAt: true,
					chunkCount: true,
					extractionStatus: true,
					extractionError: true,
				},
				take: input.limit + 1,
				cursor: input.cursor ? { id: input.cursor } : undefined,
				skip: input.cursor ? 1 : 0,
				orderBy: { pageUrl: "asc" },
			}),
			db.companyContextUrlPage.count({ where }),
		]);

		const { items, nextCursor } = urlPageListPage(rows, input.limit);

		return { items, nextCursor, total };
	});
