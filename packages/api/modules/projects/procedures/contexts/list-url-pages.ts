/**
 * listUrlPages — URL Context Sources.
 *
 * Cursor-paginated list of indexed pages under a PATH_PREFIX crawl.
 * Per `fabric/standards/backend/api.md` Pattern 4 we take `limit + 1` and
 * derive `nextCursor` from the tail. Default sort is `pageUrl ASC` for
 * stable, deterministic ordering.
 *
 * CRITICAL: `select` deliberately excludes the `content` column. Each
 * page can be a 50 KB+ chunk of markdown — shipping it in the list
 * payload would blow up the drawer when a crawl saturates 500 pages.
 * Callers fetch full content lazily via `getUrlPageContent`.
 */
import { ORPCError } from "@orpc/server";
import {
	db,
	type ExtractionStatus,
	getContextById,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export const listUrlPagesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/:parentContextId/url-pages",
		tags: ["Projects", "Contexts"],
		summary: "List URL pages",
		description:
			"Cursor-paginated list of crawled pages under a URL context. Excludes the heavy `content` field — callers must call getUrlPageContent for full markdown.",
	})
	.input(
		z.object({
			parentContextId: z.string(),
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			cursor: z.string().optional(),
			limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_LIMIT)
				.default(DEFAULT_LIMIT),
			/**
			 * Filter rows by lifecycle bucket. "all" returns everything;
			 * "indexed" → COMPLETED; "processing" → PENDING + EXTRACTING;
			 * "failed" → FAILED. We bucket PENDING with EXTRACTING because
			 * users think of them together ("rows the worker still owns").
			 */
			statusFilter: z
				.enum(["all", "indexed", "processing", "failed"])
				.optional()
				.default("all"),
			/**
			 * Free-text search across `pageTitle` AND `pageUrl`.
			 * Case-insensitive substring match (Prisma `contains`). Empty /
			 * undefined string → no search filter.
			 */
			search: z.string().trim().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Confirm parent context exists under the same XOR filter — this
		// is the cross-tenant guard for the child rows (RLS will also
		// enforce, but we want a typed NOT_FOUND for the UI).
		const parent = await getContextById(
			input.parentContextId,
			input.projectId,
			{
				userId: user.id,
				organizationId: organizationId ?? null,
			},
		);
		if (!parent) {
			throw new ORPCError("NOT_FOUND", {
				message: "URL context not found",
			});
		}

		// Tenant XOR filter mirrored from parent. We re-derive instead of
		// trusting the parent row so a row with a stale mirrored tenant
		// (e.g. parent moved orgs in the past) can't leak children.
		const tenantFilter = organizationId
			? { organizationId, userId: user.id }
			: { organizationId: null, userId: user.id };

		// Status-bucket filter expands to the underlying enum set. Kept
		// here (not at the schema layer) because the bucketing is a UX
		// concept — PENDING + EXTRACTING are functionally indistinguishable
		// to the user but distinct in the workflow.
		// Map values typed as ExtractionStatus[] (Prisma enum) so the
		// `extractionStatus: { in: ... }` filter compiles strictly.
		const statusBucket: Record<
			"all" | "indexed" | "processing" | "failed",
			ExtractionStatus[] | null
		> = {
			all: null,
			indexed: ["COMPLETED"],
			processing: ["PENDING", "EXTRACTING"],
			failed: ["FAILED"],
		};
		const statusValues = statusBucket[input.statusFilter];

		// Case-insensitive substring match against both `pageTitle` and
		// `pageUrl`. The free-text search OR-merges the two columns so
		// users can paste a URL fragment OR an article title and both work.
		const trimmedSearch = input.search?.trim();
		const searchFilter =
			trimmedSearch && trimmedSearch.length > 0
				? {
						OR: [
							{
								pageTitle: {
									contains: trimmedSearch,
									mode: "insensitive" as const,
								},
							},
							{
								pageUrl: {
									contains: trimmedSearch,
									mode: "insensitive" as const,
								},
							},
						],
					}
				: null;

		const whereBase = {
			parentContextId: input.parentContextId,
			...tenantFilter,
			...(statusValues ? { extractionStatus: { in: statusValues } } : {}),
			...(searchFilter ?? {}),
		};

		// Fetch limit + 1 to know whether there is a next page. Sort
		// `pageUrl ASC` for stable ordering across cursor jumps.
		const rows = await db.projectContextUrlPage.findMany({
			where: whereBase,
			select: {
				id: true,
				pageUrl: true,
				pageTitle: true,
				lastFetchedAt: true,
				chunkCount: true,
				extractionStatus: true,
				extractionError: true,
				// EXPLICITLY NOT selected: content (large), contentHash,
				// embeddedAt, etag, lastModifiedHeader. Drawer renders those
				// only on row expand via getUrlPageContent.
			},
			take: input.limit + 1,
			cursor: input.cursor ? { id: input.cursor } : undefined,
			skip: input.cursor ? 1 : 0,
			orderBy: { pageUrl: "asc" },
		});

		const hasNext = rows.length > input.limit;
		const items = hasNext ? rows.slice(0, -1) : rows;
		const nextCursor =
			hasNext && items.length > 0 ? items[items.length - 1].id : null;

		// Total is cheap (indexed on parentContextId) and the drawer header
		// surfaces it as "X pages indexed". This reflects the FILTERED
		// total — i.e. matches what's actually in `items` across pages.
		const total = await db.projectContextUrlPage.count({
			where: whereBase,
		});

		return {
			items,
			nextCursor,
			total,
		};
	});
