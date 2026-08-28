/**
 * Assembly of the markdown a crawled (`PATH_PREFIX`) `LINK` context holds.
 *
 * A LINK ingested with `urlScope === "PATH_PREFIX"` does not carry its text
 * on the parent row. The crawl scatters it across `ProjectContextUrlPage`
 * children so the in-app drawer doesn't have to stream 500 × 50 KB blobs on
 * first paint — which leaves `parent.content` empty. Any export path that
 * reads `content` and stops there sees an empty row and drops the link.
 *
 * This module is the one place that knows how to put those children back
 * together. Both the single-item download
 * (`../procedures/contexts/create-context-download-url.ts`) and the batch ZIP
 * (`../procedures/contexts/create-contexts-batch-download-url.ts`) import it,
 * so the same link exports byte-identically whichever button the user pressed.
 * It previously lived module-local in the single-item procedure, which is
 * exactly why the batch export never learned to do it.
 *
 * Spec: `docs/specs/2026-04-15-download-project-context-files/spec.md` §8.2.
 */

import { db } from "@repo/database";

/**
 * Tenant XOR filter for the child-page lookup. Always re-derived from the
 * caller — never read off the parent row — so a stale mirrored tenant column
 * on a child cannot pull content across an organization boundary.
 */
export type ContextTenantFilter =
	| { organizationId: string }
	| { organizationId: null; userId: string };

/**
 * True when this context keeps its content in child page rows rather than on
 * `content`. Structural input so callers can pass either a full Prisma row or
 * the narrower select shape the batch download uses.
 */
export function isPathPrefixLink(ctx: {
	type: string;
	urlScope?: string | null;
}): boolean {
	return ctx.type === "LINK" && ctx.urlScope === "PATH_PREFIX";
}

/**
 * Concatenate the markdown of every indexed page under a PATH_PREFIX LINK
 * context into a single string. Per-page heading + URL + body, separated by
 * a horizontal-rule line so the result reads like a small site dump rather
 * than a smashed-together blob.
 *
 * Sort order is `pageUrl ASC` — the same ordering `listUrlPages` uses for
 * the in-app drawer, so the downloaded file's reading order matches what
 * the user saw before exporting.
 *
 * Returns `""` when the crawl indexed nothing (or indexed only empty pages).
 * Callers must treat that as "crawl indexed no pages" rather than as the
 * generic empty-content case — the distinction is what tells a user their
 * crawl failed instead of leaving them to guess.
 *
 * Tenant XOR is taken from `tenantFilter` (NOT trusted from the parent row).
 * The query still scopes to `parentContextId`, which the caller has already
 * proven in-scope.
 */
export async function buildPathPrefixMarkdown(
	parentContextId: string,
	tenantFilter: ContextTenantFilter,
): Promise<string> {
	const pages = await db.projectContextUrlPage.findMany({
		where: {
			parentContextId,
			...tenantFilter,
		},
		select: {
			pageUrl: true,
			pageTitle: true,
			content: true,
		},
		orderBy: { pageUrl: "asc" },
	});

	const sections = pages
		.filter((p) => typeof p.content === "string" && p.content.length > 0)
		.map((p) => {
			const heading = p.pageTitle || p.pageUrl;
			return `## ${heading}\n${p.pageUrl}\n\n${p.content}\n`;
		});

	return sections.join("\n---\n\n");
}
