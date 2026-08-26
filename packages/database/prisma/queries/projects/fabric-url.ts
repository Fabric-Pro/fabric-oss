/**
 * Builds the absolute Fabric URL for a story / project. Used to embed a
 * "View in Fabric" back-link in story descriptions, which then ride along
 * to external PM tools (Jira / ADO / Fizzy / etc.) on push.
 *
 * Lives in @repo/database (rather than @repo/temporal) so the createStory
 * query helper can call it without introducing a database → temporal
 * circular import. Both the temporal worker and the web/api context
 * import it from here.
 *
 * The base-URL fallback chain mirrors the codebase convention used by
 * OAuth callbacks (packages/api/modules/integrations/*) and by the frame
 * share-URL builder (packages/temporal/src/activities/shared/frame-service.ts):
 *
 *   1. NEXT_PUBLIC_APP_URL — set on the Vercel-hosted web project
 *   2. APP_URL              — set on the temporal-worker Container App via Key Vault
 *   3. getBaseUrl()         — dev-time fallback (NEXT_PUBLIC_SITE_URL → localhost)
 */

import { getBaseUrl } from "@repo/utils";
import { db } from "../../client";

export async function buildFabricStoryUrl(args: {
	projectId: string;
	storyId: string;
	organizationId?: string | null;
}): Promise<string> {
	let slug: string | null = null;
	if (args.organizationId) {
		const org = await db.organization.findUnique({
			where: { id: args.organizationId },
			select: { slug: true },
		});
		slug = org?.slug ?? null;
	}
	const base =
		process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || getBaseUrl();
	return slug
		? `${base}/app/${slug}/projects/${args.projectId}/stories/${args.storyId}`
		: `${base}/app/projects/${args.projectId}/stories/${args.storyId}`;
}

/**
 * Absolute URL to a project's in-app Release Notes tab. Mirrors
 * `buildFabricStoryUrl`'s tenant handling: org projects live under
 * `/app/{slug}/projects/{id}` (ProjectDetails derives tenant context from the
 * URL path), so an org send MUST resolve the org slug — otherwise the link
 * lands users in the personal route and fails to load the org-scoped page. Also
 * uses the same NEXT_PUBLIC_APP_URL → APP_URL → getBaseUrl() base chain, which
 * matters in the temporal-worker where getBaseUrl() alone would resolve to
 * localhost. Used by the newsletter chat-delivery teaser link.
 */
export async function buildReleaseNotesUrl(args: {
	projectId: string;
	organizationId?: string | null;
}): Promise<string> {
	let slug: string | null = null;
	if (args.organizationId) {
		const org = await db.organization.findUnique({
			where: { id: args.organizationId },
			select: { slug: true },
		});
		slug = org?.slug ?? null;
	}
	const base =
		process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || getBaseUrl();
	return slug
		? `${base}/app/${slug}/projects/${args.projectId}?tab=release-notes`
		: `${base}/app/projects/${args.projectId}?tab=release-notes`;
}

/**
 * Append a "View in Fabric" link to a description, idempotent — if the
 * description already contains "View in Fabric" anywhere, the input is
 * returned unchanged.
 *
 * The back-link is ALWAYS emitted as an HTML anchor (`<p><a href="url">
 * View in Fabric</a></p>`), regardless of what format the surrounding
 * description is in. Rationale:
 *
 *   - Fabric Tiptap reads description as HTML and renders the anchor as
 *     a clickable hyperlink.
 *   - Every PM tool we push to (Azure DevOps System.Description, Jira,
 *     GitHub, GitLab, Fizzy, Trello, …) accepts / renders HTML anchors.
 *   - Markdown-link form (`[View in Fabric](url)`) does NOT render in
 *     ADO's HTML-stored System.Description and shows up as literal
 *     `[View in Fabric](url)` text to end users.
 *
 * The user-authored portion of the description is NEVER transformed.
 * This helper only adds bytes at the end — it never modifies what's
 * already there.
 *
 * Used by createStory and bulkCreateStories to persist the back-link in
 * the Fabric DB at story-creation time.
 */
export function appendFabricBackLink(
	description: string | null | undefined,
	fabricUrl: string,
): string {
	const current = description ?? "";
	if (current.includes("View in Fabric")) {
		return current;
	}
	const safeUrl = fabricUrl.replace(/"/g, "&quot;");
	const anchor = `<p><a href="${safeUrl}">View in Fabric</a></p>`;
	if (current.length === 0) {
		return anchor;
	}
	// Single `\n` between user content and the anchor — enough of a
	// boundary for Tiptap and HTML renderers to treat the anchor as a
	// separate block, while keeping plain-text content from being
	// awkwardly split with a blank line.
	return `${current}\n${anchor}`;
}

/**
 * Strip every "View in Fabric" reference (HTML anchor + markdown link form)
 * from a string, collapsing the blank lines left behind. Used by
 * `placeFabricBackLink` before the canonical anchor is re-positioned.
 *
 * Idempotent. The exact-label invariant mirrors `HTML_BACK_LINK_RE` /
 * `MARKDOWN_BACK_LINK_RE` — user-authored "view in fabric" text in any other
 * casing or context is untouched.
 */
function stripFabricBackLinkFromText(text: string): string {
	return text
		.replace(
			/<p>\s*<a\s+[^>]*href=["'][^"']+["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/gi,
			"",
		)
		.replace(/\[View in Fabric\]\(([^)]+)\)/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Position the canonical "View in Fabric" back-link at the visual end of the
 * UserStory card.
 *
 * Fabric UI renders `description` and `acceptanceCriteria` as two separate
 * Tiptap editors, in that order. To make the back-link land at the very
 * bottom of the rendered ticket (after the AC block), we put it at the end
 * of `acceptanceCriteria` when AC is populated; otherwise we fall back to
 * `description`. Idempotent: any prior back-link in either column is
 * stripped before a single canonical anchor is appended.
 *
 * Returns the pair of updated columns. Callers store both — even when only
 * one changed — so the helper can safely be the single source of truth for
 * back-link placement across createStory, bulkCreateStories, the AI flows,
 * and any future caller that mutates `description` / `acceptanceCriteria`.
 *
 * Push pipelines (hierarchy-sync, story-sync-workflow) still extract the
 * back-link before joining parts; they look in `acceptanceCriteria` first,
 * then `description`, so legacy stories with the anchor in `description`
 * are forward-compatible with no migration required.
 */
export function placeFabricBackLink(args: {
	description: string | null | undefined;
	acceptanceCriteria: string | null | undefined;
	fabricUrl: string;
}): { description: string; acceptanceCriteria: string | null } {
	const safeUrl = args.fabricUrl.replace(/"/g, "&quot;");
	const anchor = `<p><a href="${safeUrl}">View in Fabric</a></p>`;

	const cleanedDescription = stripFabricBackLinkFromText(
		args.description ?? "",
	);
	const cleanedAcceptanceCriteria = stripFabricBackLinkFromText(
		args.acceptanceCriteria ?? "",
	);

	if (cleanedAcceptanceCriteria.length > 0) {
		return {
			description: cleanedDescription,
			acceptanceCriteria: `${cleanedAcceptanceCriteria}\n${anchor}`,
		};
	}

	const descriptionWithLink =
		cleanedDescription.length > 0
			? `${cleanedDescription}\n${anchor}`
			: anchor;
	return {
		description: descriptionWithLink,
		// Preserve null when the caller passed null/undefined so we don't
		// flip an unset column to an empty string and trigger spurious
		// version diffs in updateStory.
		acceptanceCriteria:
			args.acceptanceCriteria === null ||
			args.acceptanceCriteria === undefined
				? null
				: cleanedAcceptanceCriteria,
	};
}

// =============================================================================
// Per-provider back-link format split (F-1219)
//
// `appendFabricBackLink` writes the canonical HTML anchor into Fabric's DB.
// Most PM tools render that HTML fine — Azure DevOps does, Jira does, GitHub
// does, GitLab does, Linear does. Fizzy is the exception: despite its MCP
// tool schema for the `description` field stating "supports HTML", it stores
// our `<p><a href="…">View in Fabric</a></p>` verbatim and renders it as
// literal text to the end user.
//
// Fix: at the Fizzy push site only, rewrite the HTML anchor as a markdown
// link `[View in Fabric](url)`; at the Fizzy pull site, rewrite it back into
// the canonical HTML anchor so Fabric's Tiptap renders it. Round-trip is
// byte-stable for any description that already conforms.
//
// **Invariant we will never violate**: user-authored content is never
// transformed. The helpers below match only the EXACT `View in Fabric`
// label inside an anchor / markdown-link wrapper. Anything else in the
// description — including the user's own `<a>` tags or markdown links —
// is passed through unchanged.
// =============================================================================

/**
 * Match the canonical HTML anchor we emit (and any tolerant variants:
 * single/double-quoted href, extra attributes on the `<a>` tag, internal
 * whitespace). The literal `View in Fabric` label is case-sensitive — a
 * user's lowercase phrase "view in fabric" must NOT be treated as a
 * back-link. The `i` flag covers only the wrapping tags / whitespace.
 */
export const HTML_BACK_LINK_RE =
	/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i;

/**
 * Match the markdown form we emit for Fizzy. Same exact-label invariant —
 * user's own markdown links elsewhere in the description (e.g. `[Spec](…)`)
 * never match.
 */
const MARKDOWN_BACK_LINK_RE = /\[View in Fabric\]\(([^)]+)\)/;

function isFizzy(providerDetectedType: string | null | undefined): boolean {
	return (providerDetectedType ?? "").toLowerCase() === "fizzy";
}

/**
 * Outgoing transform — Fabric DB form → push-target form.
 *
 * For Fizzy, swap our HTML back-link anchor for a markdown link. For every
 * other provider (and for descriptions with no back-link), return the input
 * byte-for-byte. Idempotent: running this twice on a Fizzy-bound description
 * is a no-op once the HTML anchor has been swapped.
 *
 * The user-authored portion of the description is NEVER transformed — only
 * the literal `View in Fabric` anchor span is rewritten.
 */
export function formatBackLinkForProvider(
	description: string | null | undefined,
	providerDetectedType: string | null | undefined,
): string {
	const current = description ?? "";
	if (!isFizzy(providerDetectedType)) {
		return current;
	}
	const m = current.match(HTML_BACK_LINK_RE);
	if (!m) {
		return current;
	}
	return current.replace(HTML_BACK_LINK_RE, `[View in Fabric](${m[1]})`);
}

/**
 * Incoming transform — pull-source form → Fabric DB form.
 *
 * For Fizzy, swap a markdown back-link `[View in Fabric](url)` (which Fabric
 * Tiptap would render as literal text) back into the canonical HTML anchor
 * so Tiptap renders it as a clickable hyperlink. For every other provider
 * (and for descriptions with no back-link), return the input byte-for-byte.
 *
 * The user-authored portion of the description is NEVER transformed — only
 * the literal `[View in Fabric]` link span is rewritten.
 */
export function normalizeBackLinkFromProvider(
	description: string | null | undefined,
	providerDetectedType: string | null | undefined,
): string {
	const current = description ?? "";
	if (!isFizzy(providerDetectedType)) {
		return current;
	}
	const m = current.match(MARKDOWN_BACK_LINK_RE);
	if (!m) {
		return current;
	}
	const safeUrl = m[1].replace(/"/g, "&quot;");
	return current.replace(
		MARKDOWN_BACK_LINK_RE,
		`<p><a href="${safeUrl}">View in Fabric</a></p>`,
	);
}
