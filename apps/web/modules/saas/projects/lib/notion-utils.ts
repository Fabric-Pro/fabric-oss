/**
 * Shared Notion MCP integration utilities.
 *
 * Used by NotionResourceBrowser and WizardIntegrationsSection
 * for parsing MCP tool responses and ranking search results.
 */

export type NotionPage = {
	id: string;
	title: string;
	type: "page" | "database";
	url?: string;
	icon?: string;
	lastEdited?: string;
	parentId?: string | null;
	hasChildren?: boolean;
};

export type BreadcrumbItem = {
	id: string | null; // null for root
	title: string;
};

/**
 * Parse MCP tool results into NotionPage array.
 * Handles multiple response formats from different Notion MCP servers.
 */
export function parseNotionResults(result: unknown): NotionPage[] {
	if (!result) {
		return [];
	}

	// If it's already an array of pages
	if (Array.isArray(result)) {
		return result.map(parseNotionPage).filter(Boolean) as NotionPage[];
	}

	// If it's an object with results/pages array
	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;
		if (Array.isArray(obj.results)) {
			return obj.results
				.map(parseNotionPage)
				.filter(Boolean) as NotionPage[];
		}
		if (Array.isArray(obj.pages)) {
			return obj.pages
				.map(parseNotionPage)
				.filter(Boolean) as NotionPage[];
		}
		// Single page result
		const page = parseNotionPage(obj);
		if (page) {
			return [page];
		}
	}

	// If it's a string, try to parse as JSON
	if (typeof result === "string") {
		try {
			return parseNotionResults(JSON.parse(result));
		} catch {
			return [];
		}
	}

	return [];
}

/**
 * Parse a single item into NotionPage.
 */
function parseNotionPage(item: unknown): NotionPage | null {
	if (!item || typeof item !== "object") {
		return null;
	}

	const obj = item as Record<string, unknown>;

	// Try to extract id
	const id =
		(obj.id as string) || (obj.pageId as string) || (obj.page_id as string);
	if (!id) {
		return null;
	}

	// Try to extract title
	let title = "Untitled";
	if (typeof obj.title === "string") {
		title = obj.title;
	} else if (
		obj.properties &&
		typeof obj.properties === "object" &&
		(obj.properties as Record<string, unknown>).title
	) {
		// Notion API format
		const titleProp = (obj.properties as Record<string, unknown>)
			.title as unknown;
		if (Array.isArray(titleProp) && titleProp[0]?.plain_text) {
			title = titleProp[0].plain_text;
		}
	} else if (typeof obj.name === "string") {
		title = obj.name;
	}

	// Determine type
	const type: "page" | "database" =
		obj.object === "database" || obj.type === "database"
			? "database"
			: "page";

	// Extract icon
	let icon: string | undefined;
	if (obj.icon && typeof obj.icon === "object") {
		const iconObj = obj.icon as Record<string, unknown>;
		if (iconObj.emoji) {
			icon = iconObj.emoji as string;
		}
	}

	// Extract URL
	const url = (obj.url as string) || (obj.link as string) || undefined;

	// Extract last edited time
	const lastEdited =
		(obj.last_edited_time as string) ||
		(obj.lastEdited as string) ||
		undefined;

	// Extract parent ID for hierarchy
	let parentId: string | null = null;
	if (obj.parent && typeof obj.parent === "object") {
		const parent = obj.parent as Record<string, unknown>;
		parentId =
			(parent.page_id as string) ||
			(parent.database_id as string) ||
			(parent.block_id as string) ||
			null;
	} else if (typeof obj.parent_id === "string") {
		parentId = obj.parent_id;
	} else if (typeof obj.parentId === "string") {
		parentId = obj.parentId;
	}

	// Check if has children
	const hasChildren =
		obj.has_children === true ||
		obj.hasChildren === true ||
		type === "database";

	return {
		id,
		title,
		type,
		icon,
		url,
		lastEdited,
		parentId,
		hasChildren,
	};
}

/**
 * Rank search results by relevance to the query.
 *
 * Preserves ALL results (never removes any). Reorders by:
 * 1. Deduplicates by page ID
 * 2. Exact title match (case-insensitive)
 * 3. Title starts with query
 * 4. Title contains query
 * 5. Everything else (content-only matches)
 * Within each tier, sorts by lastEdited descending (most recent first).
 */
export function rankSearchResults(
	pages: NotionPage[],
	query: string,
): NotionPage[] {
	if (!query.trim()) {
		return pages;
	}

	// Deduplicate by ID
	const seen = new Set<string>();
	const unique = pages.filter((p) => {
		if (seen.has(p.id)) {
			return false;
		}
		seen.add(p.id);
		return true;
	});

	const lowerQuery = query.toLowerCase().trim();

	return unique.sort((a, b) => {
		const aTier = getRelevanceTier(a.title, lowerQuery);
		const bTier = getRelevanceTier(b.title, lowerQuery);

		if (aTier !== bTier) {
			return aTier - bTier; // Lower tier number = higher relevance
		}

		// Within same tier, sort by lastEdited descending
		if (a.lastEdited && b.lastEdited) {
			const aTime = new Date(a.lastEdited).getTime();
			const bTime = new Date(b.lastEdited).getTime();
			if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) {
				return bTime - aTime;
			}
		}
		// Pages with lastEdited come before those without
		if (a.lastEdited && !b.lastEdited) {
			return -1;
		}
		if (!a.lastEdited && b.lastEdited) {
			return 1;
		}

		return 0;
	});
}

/**
 * Get relevance tier for a page title relative to a query.
 * Lower number = higher relevance.
 */
function getRelevanceTier(title: string, lowerQuery: string): number {
	const lowerTitle = title.toLowerCase();

	if (lowerTitle === lowerQuery) {
		return 0; // Exact match
	}
	if (lowerTitle.startsWith(lowerQuery)) {
		return 1; // Starts with
	}
	if (lowerTitle.includes(lowerQuery)) {
		return 2; // Contains
	}
	return 3; // No title match (content-only match)
}

/**
 * Parse child page references from notion-fetch content.
 * Matches `<page url="{{https://www.notion.so/ID}}">Title</page>` format
 * returned by the Notion MCP fetch tool for team space home pages.
 */
export function parseChildPagesFromContent(
	text: string,
): Array<{ id: string; title: string; url: string }> {
	const childPages: Array<{ id: string; title: string; url: string }> = [];
	const pageRegex =
		/<page\s+url="(?:\{\{)?(https:\/\/www\.notion\.so\/([a-f0-9]+))(?:\}\})?">([^<]+)<\/page>/g;
	let match: RegExpExecArray | null;
	match = pageRegex.exec(text);
	while (match !== null) {
		const [, url, rawId, title] = match;
		// Convert 32-char hex to UUID format
		const id =
			rawId.length === 32
				? `${rawId.slice(0, 8)}-${rawId.slice(8, 12)}-${rawId.slice(12, 16)}-${rawId.slice(16, 20)}-${rawId.slice(20)}`
				: rawId;
		childPages.push({ id, title: title.trim(), url });
		match = pageRegex.exec(text);
	}
	return childPages;
}
