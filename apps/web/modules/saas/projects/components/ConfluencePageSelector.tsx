"use client";

/**
 * Confluence Page Selector Dialog (MCP-based)
 *
 * Discovers available Confluence MCP tools and provides two browsing modes:
 * 1. Search mode - searches Confluence content by query
 * 2. Space browsing - lists spaces then pages within a space
 *
 * Used by:
 * - ContextUploaderDialog (unified project setup wizard)
 */

import { TruncatedText } from "@shared/components/TruncatedText";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	ChevronRightIcon,
	FileTextIcon,
	FolderIcon,
	HomeIcon,
	Loader2Icon,
	SearchIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

interface ConfluencePage {
	id: string;
	title: string;
	spaceKey: string;
	spaceName?: string;
	url?: string;
	type?: string;
}

interface ConfluenceSpace {
	key: string;
	name: string;
	/**
	 * Opaque space id (distinct from `key`). Atlassian's
	 * `getPagesInConfluenceSpace` keys on this `spaceId`, not the space key.
	 */
	id?: string;
	type?: string;
	url?: string;
}

interface BreadcrumbItem {
	key: string | null;
	title: string;
}

interface ConfluencePageSelectorProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mcpConfigId: string | null;
	organizationId?: string | null;
	initialSelectedIds?: string[];
	/** Page IDs already added to the project — rendered disabled / uncheckable. */
	syncedPageIds?: string[];
	confirmLoading?: boolean;
	onConfirm: (
		pages: Array<{
			pageId: string;
			title: string;
			spaceKey: string;
			url?: string;
			mcpConfigId: string;
		}>,
	) => void;
}

// ── Tool detection ─────────────────────────────────────────────────────────

// Patterns are matched case-insensitively as substrings. They cover both
// snake_case community Confluence MCP servers and Atlassian's official Rovo
// server, whose tools are camelCase (searchConfluenceUsingCql,
// getConfluenceSpaces, getPagesInConfluenceSpace). The Rovo patterns are chosen
// to discriminate cleanly: `confluencespaces` (plural) matches getConfluence*S*paces
// but not getPagesInConfluenceSpace (singular), and `pagesin` matches only the
// pages-in-space tool.
const SEARCH_TOOL_PATTERNS = [
	"confluence_search",
	"search_content",
	"confluence_search_content",
	"searchconfluence", // Rovo: searchConfluenceUsingCql
];

const SPACES_TOOL_PATTERNS = [
	"confluence_get_spaces",
	"list_spaces",
	"get_spaces",
	"confluencespaces", // Rovo: getConfluenceSpaces
];

const PAGES_IN_SPACE_PATTERNS = [
	"get_pages_in_space",
	"confluence_get_pages",
	"list_pages",
	"get_space_content",
	"pagesin", // Rovo: getPagesInConfluenceSpace
];

function detectTool(tools: string[], patterns: string[]): string | undefined {
	for (const pattern of patterns) {
		const match = tools.find((t) => t.toLowerCase().includes(pattern));
		if (match) {
			return match;
		}
	}
	return undefined;
}

/**
 * Build the query params for a search tool. Atlassian's `searchConfluenceUsingCql`
 * takes a CQL string, not a free-text `query` — so for cql-style tools we wrap
 * the user's text as `text ~ "…"` (quotes/backslashes escaped). Other servers
 * keep the plain `query` param.
 */
function buildSearchParams(
	searchTool: string,
	query: string,
): Record<string, string> {
	if (/cql/i.test(searchTool)) {
		const escaped = query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return { cql: `text ~ "${escaped}"` };
	}
	return { query };
}

// ── Response parsers ───────────────────────────────────────────────────────

function unwrapMcpResult(result: unknown): unknown {
	try {
		let data = typeof result === "string" ? JSON.parse(result) : result;
		// MCP text content array: [{ type: "text", text: "..." }]
		if (Array.isArray(data) && data[0]?.type === "text" && data[0]?.text) {
			data =
				typeof data[0].text === "string"
					? JSON.parse(data[0].text)
					: data[0].text;
		}
		return data;
	} catch {
		return result;
	}
}

function parseSpacesResult(result: unknown): ConfluenceSpace[] {
	try {
		const data = unwrapMcpResult(result);

		const list: unknown[] = Array.isArray(data)
			? data
			: Array.isArray((data as Record<string, unknown>)?.results)
				? ((data as Record<string, unknown>).results as unknown[])
				: Array.isArray((data as Record<string, unknown>)?.spaces)
					? ((data as Record<string, unknown>).spaces as unknown[])
					: [];

		return list
			.map((item: unknown) => {
				const sp = item as Record<string, unknown>;
				return {
					key: String(sp.key ?? sp.spaceKey ?? ""),
					name: String(sp.name ?? sp.title ?? ""),
					id:
						sp.id != null
							? String(sp.id)
							: sp.spaceId != null
								? String(sp.spaceId)
								: undefined,
					type: sp.type ? String(sp.type) : undefined,
					url: sp.url
						? String(sp.url)
						: sp._links && typeof sp._links === "object"
							? String(
									(sp._links as Record<string, unknown>)
										.webui ?? "",
								)
							: undefined,
				} satisfies ConfluenceSpace;
			})
			.filter((sp) => sp.key && sp.name);
	} catch {
		return [];
	}
}

function parsePagesResult(result: unknown): ConfluencePage[] {
	try {
		const data = unwrapMcpResult(result);

		const list: unknown[] = Array.isArray(data)
			? data
			: Array.isArray((data as Record<string, unknown>)?.results)
				? ((data as Record<string, unknown>).results as unknown[])
				: Array.isArray((data as Record<string, unknown>)?.pages)
					? ((data as Record<string, unknown>).pages as unknown[])
					: [];

		return list
			.map((item: unknown) => {
				const outer = item as Record<string, unknown>;
				// CQL search (searchConfluenceUsingCql) nests the page under
				// `content`; space listings return the page fields flat.
				const pg =
					outer.content &&
					typeof outer.content === "object" &&
					!Array.isArray(outer.content)
						? (outer.content as Record<string, unknown>)
						: outer;
				return {
					id: String(pg.id ?? pg.pageId ?? ""),
					title: String(pg.title ?? pg.name ?? ""),
					spaceKey: String(
						pg.spaceKey ??
							pg.space_key ??
							(typeof pg.space === "object" &&
							pg.space !== null &&
							"key" in (pg.space as Record<string, unknown>)
								? (pg.space as Record<string, unknown>).key
								: ""),
					),
					spaceName:
						typeof pg.space === "object" &&
						pg.space !== null &&
						"name" in (pg.space as Record<string, unknown>)
							? String((pg.space as Record<string, unknown>).name)
							: undefined,
					url: pg.url
						? String(pg.url)
						: pg._links && typeof pg._links === "object"
							? String(
									(pg._links as Record<string, unknown>)
										.webui ?? "",
								)
							: undefined,
					type: pg.type ? String(pg.type) : undefined,
				} satisfies ConfluencePage;
			})
			.filter((pg) => pg.id && pg.title);
	} catch {
		return [];
	}
}

// ── Component ──────────────────────────────────────────────────────────────

export function ConfluencePageSelector({
	open,
	onOpenChange,
	mcpConfigId,
	organizationId,
	initialSelectedIds = [],
	syncedPageIds = [],
	confirmLoading = false,
	onConfirm,
}: ConfluencePageSelectorProps) {
	const t = useTranslations("tooltips.contextSources");
	const tC = useTranslations("tooltips.common");

	const syncedPageIdSet = useMemo(
		() => new Set(syncedPageIds),
		[syncedPageIds],
	);

	// Stable ref for initialSelectedIds to avoid an infinite loop in the reset
	// effect. The default prop `initialSelectedIds = []` creates a new array
	// every render, so listing it as an effect dep would re-run the reset on
	// every render (mirrors NotionPageSelector).
	const initialSelectedIdsRef = useRef(initialSelectedIds);
	initialSelectedIdsRef.current = initialSelectedIds;

	// Pages loaded across navigation/search, keyed by id. Lets `handleConfirm`
	// resolve title/spaceKey for a selection made via search then navigated away
	// (instead of falling back to the raw page id).
	const [knownPages, setKnownPages] = useState<Map<string, ConfluencePage>>(
		new Map(),
	);

	// Tool discovery
	const [availableTools, setAvailableTools] = useState<string[]>([]);
	const [toolsLoading, setToolsLoading] = useState(false);
	const [toolsError, setToolsError] = useState<string | null>(null);

	// Navigation (space browsing mode). `currentSpaceId` is the opaque space id
	// (when the server exposes one) that pages-in-space tools key on; the key is
	// retained for display/breadcrumbs and as a fallback.
	const [currentSpaceKey, setCurrentSpaceKey] = useState<string | null>(null);
	const [currentSpaceId, setCurrentSpaceId] = useState<string | null>(null);
	const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
		{ key: null, title: "Spaces" },
	]);

	// Spaces
	const [spaces, setSpaces] = useState<ConfluenceSpace[]>([]);
	const [spacesLoading, setSpacesLoading] = useState(false);

	// Pages
	const [pages, setPages] = useState<ConfluencePage[]>([]);
	const [pagesLoading, setPagesLoading] = useState(false);
	const [pagesError, setPagesError] = useState<string | null>(null);

	// Search
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [isSearchMode, setIsSearchMode] = useState(false);

	// Selection
	const [localSelection, setLocalSelection] = useState<Set<string>>(
		new Set(),
	);

	// Derived tools
	const searchTool = useMemo(
		() => detectTool(availableTools, SEARCH_TOOL_PATTERNS),
		[availableTools],
	);
	const spacesTool = useMemo(
		() => detectTool(availableTools, SPACES_TOOL_PATTERNS),
		[availableTools],
	);
	const pagesInSpaceTool = useMemo(
		() => detectTool(availableTools, PAGES_IN_SPACE_PATTERNS),
		[availableTools],
	);

	const isAtRoot = currentSpaceKey === null;
	const hasRequiredTools = !!searchTool || !!spacesTool;

	// Client-side filter for spaces at root level
	const filteredSpaces = useMemo(() => {
		if (!searchQuery.trim() || !isAtRoot) {
			return spaces;
		}
		const query = searchQuery.toLowerCase().trim();
		return spaces.filter(
			(sp) =>
				sp.name.toLowerCase().includes(query) ||
				sp.key.toLowerCase().includes(query),
		);
	}, [spaces, searchQuery, isAtRoot]);

	// Client-side filter for pages. In server search mode the results already
	// match the query server-side — and CQL matches page *body* text, so the
	// titles often don't contain the query. Re-applying a title filter there
	// would hide legitimate hits ("No pages found"), so skip it; the title
	// filter only narrows a space's own page listing.
	const filteredPages = useMemo(() => {
		if (!searchQuery.trim() || isSearchMode) {
			return pages;
		}
		const query = searchQuery.toLowerCase().trim();
		return pages.filter(
			(pg) =>
				pg.title.toLowerCase().includes(query) ||
				pg.spaceKey.toLowerCase().includes(query),
		);
	}, [pages, searchQuery, isSearchMode]);

	// Debounce search for server-side search
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedQuery(searchQuery);
			setIsSearchMode(searchQuery.trim().length > 0 && isAtRoot);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery, isAtRoot]);

	// ── Reset on open ──────────────────────────────────────────────────────

	// initialSelectedIds is intentionally read from a ref (not listed as a dep)
	// so the reset runs only on an open transition. Callers must finalize
	// initialSelectedIds before setting open=true.
	useEffect(() => {
		if (open) {
			setLocalSelection(new Set(initialSelectedIdsRef.current));
			setSearchQuery("");
			setDebouncedQuery("");
			setIsSearchMode(false);
			setCurrentSpaceKey(null);
			setCurrentSpaceId(null);
			setBreadcrumbs([{ key: null, title: "Spaces" }]);
			setSpaces([]);
			setPages([]);
			setPagesError(null);
			setKnownPages(new Map());
		}
	}, [open]);

	// Accumulate every page we've seen (search results + space listings) so a
	// selection survives navigation away from the view that loaded it.
	useEffect(() => {
		if (pages.length === 0) {
			return;
		}
		setKnownPages((prev) => {
			const next = new Map(prev);
			for (const pg of pages) {
				next.set(pg.id, pg);
			}
			return next;
		});
	}, [pages]);

	// ── Fetch tools ────────────────────────────────────────────────────────

	useEffect(() => {
		if (!open || !mcpConfigId) {
			return;
		}

		async function fetchTools() {
			setToolsLoading(true);
			setToolsError(null);
			try {
				const response = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId,
						action: "list_tools",
						organizationId: organizationId ?? undefined,
					}),
				});
				const data = await response.json();
				if (data.error) {
					setToolsError(data.error);
				} else {
					setAvailableTools(data.tools || []);
				}
			} catch (err) {
				setToolsError(
					err instanceof Error ? err.message : "Failed to load tools",
				);
			} finally {
				setToolsLoading(false);
			}
		}

		fetchTools();
	}, [open, mcpConfigId, organizationId]);

	// ── Fetch spaces at root ───────────────────────────────────────────────

	useEffect(() => {
		if (!open || !mcpConfigId || toolsLoading || !spacesTool || !isAtRoot) {
			return;
		}

		async function fetchSpaces() {
			setSpacesLoading(true);
			try {
				const response = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId,
						toolName: spacesTool,
						params: {},
						organizationId: organizationId ?? undefined,
					}),
				});
				const data = await response.json();
				if (data.error) {
					setSpaces([]);
					return;
				}
				const parsed = parseSpacesResult(data.result);
				setSpaces(parsed.sort((a, b) => a.name.localeCompare(b.name)));
			} catch {
				setSpaces([]);
			} finally {
				setSpacesLoading(false);
			}
		}

		fetchSpaces();
	}, [open, mcpConfigId, toolsLoading, spacesTool, isAtRoot, organizationId]);

	// ── Search pages (server-side via search tool) ─────────────────────────

	useEffect(() => {
		if (!open || !mcpConfigId || toolsLoading) {
			return;
		}
		if (!searchTool) {
			return;
		}

		// Only do server-side search at root with a query, or skip if we have space browsing
		if (isAtRoot && spacesTool && !isSearchMode) {
			return;
		}
		if (isAtRoot && !debouncedQuery.trim()) {
			if (!spacesTool) {
				setPages([]);
				setPagesLoading(false);
			}
			return;
		}
		// Inside a space, don't use server search (we use pagesInSpaceTool instead)
		if (!isAtRoot) {
			return;
		}

		async function searchPages() {
			setPagesLoading(true);
			setPagesError(null);
			try {
				const response = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId,
						toolName: searchTool,
						params: buildSearchParams(
							searchTool as string,
							debouncedQuery.trim(),
						),
						organizationId: organizationId ?? undefined,
					}),
				});
				const data = await response.json();
				if (data.error) {
					setPagesError(data.error);
					return;
				}
				setPages(parsePagesResult(data.result));
			} catch (err) {
				setPagesError(
					err instanceof Error
						? err.message
						: "Failed to search pages",
				);
			} finally {
				setPagesLoading(false);
			}
		}

		searchPages();
	}, [
		open,
		mcpConfigId,
		toolsLoading,
		searchTool,
		spacesTool,
		debouncedQuery,
		isAtRoot,
		isSearchMode,
		organizationId,
	]);

	// ── Fetch pages in a space ─────────────────────────────────────────────

	useEffect(() => {
		if (
			!open ||
			!mcpConfigId ||
			toolsLoading ||
			isAtRoot ||
			!currentSpaceKey
		) {
			return;
		}

		// Try pagesInSpaceTool first, fall back to searchTool with space filter
		const toolToUse = pagesInSpaceTool || searchTool;
		if (!toolToUse) {
			return;
		}

		async function fetchSpacePages() {
			setPagesLoading(true);
			setPagesError(null);
			try {
				// Atlassian's getPagesInConfluenceSpace keys on the opaque
				// `spaceId`; community servers key on `spaceKey`. Prefer the id
				// when the spaces listing surfaced one, else fall back to the key.
				const params: Record<string, string> = pagesInSpaceTool
					? currentSpaceId
						? { spaceId: currentSpaceId }
						: { spaceKey: currentSpaceKey as string }
					: {
							query: debouncedQuery.trim() || "*",
							spaceKey: currentSpaceKey as string,
						};

				const response = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId,
						toolName: toolToUse,
						params,
						organizationId: organizationId ?? undefined,
					}),
				});
				const data = await response.json();
				if (data.error) {
					setPagesError(data.error);
					return;
				}
				const parsed = parsePagesResult(data.result);
				// Ensure spaceKey is set for all parsed pages
				setPages(
					parsed.map((pg) => ({
						...pg,
						spaceKey: pg.spaceKey || (currentSpaceKey as string),
					})),
				);
			} catch (err) {
				setPagesError(
					err instanceof Error ? err.message : "Failed to load pages",
				);
			} finally {
				setPagesLoading(false);
			}
		}

		fetchSpacePages();
	}, [
		open,
		mcpConfigId,
		toolsLoading,
		isAtRoot,
		currentSpaceKey,
		currentSpaceId,
		pagesInSpaceTool,
		searchTool,
		debouncedQuery,
		organizationId,
	]);

	// ── Navigation ─────────────────────────────────────────────────────────

	const navigateToSpace = useCallback((space: ConfluenceSpace) => {
		setCurrentSpaceKey(space.key);
		setCurrentSpaceId(space.id ?? null);
		setBreadcrumbs((prev) => [
			...prev,
			{ key: space.key, title: space.name },
		]);
		setSearchQuery("");
		setDebouncedQuery("");
		setIsSearchMode(false);
		setPages([]);
		setPagesError(null);
	}, []);

	const navigateToBreadcrumb = useCallback(
		(index: number) => {
			setBreadcrumbs((prev) => {
				const sliced = prev.slice(0, index + 1);
				const targetKey =
					index === 0 ? null : (sliced[index]?.key ?? null);
				setCurrentSpaceKey(targetKey);
				// Re-resolve the space id from the loaded spaces list (breadcrumbs
				// only carry the key); null at root.
				setCurrentSpaceId(
					targetKey
						? (spaces.find((sp) => sp.key === targetKey)?.id ??
								null)
						: null,
				);
				return sliced;
			});
			setSearchQuery("");
			setDebouncedQuery("");
			setIsSearchMode(false);
			setPages([]);
		},
		[spaces],
	);

	const clearSearch = useCallback(() => {
		setSearchQuery("");
		setDebouncedQuery("");
		setIsSearchMode(false);
	}, []);

	// ── Selection ──────────────────────────────────────────────────────────

	const toggleSelection = useCallback(
		(pageId: string) => {
			if (syncedPageIdSet.has(pageId)) {
				return;
			}
			setLocalSelection((prev) => {
				const next = new Set(prev);
				if (next.has(pageId)) {
					next.delete(pageId);
				} else {
					next.add(pageId);
				}
				return next;
			});
		},
		[syncedPageIdSet],
	);

	const selectAll = useCallback(() => {
		setLocalSelection((prev) => {
			const next = new Set(prev);
			for (const pg of filteredPages) {
				if (!syncedPageIdSet.has(pg.id)) {
					next.add(pg.id);
				}
			}
			return next;
		});
	}, [filteredPages, syncedPageIdSet]);

	const deselectAll = useCallback(() => {
		const visibleIds = new Set(filteredPages.map((pg) => pg.id));
		setLocalSelection((prev) => {
			const next = new Set(prev);
			for (const id of visibleIds) {
				next.delete(id);
			}
			return next;
		});
	}, [filteredPages]);

	const handleConfirm = useCallback(() => {
		const resolvedIds = new Set<string>();
		const results: Array<{
			pageId: string;
			title: string;
			spaceKey: string;
			url?: string;
			mcpConfigId: string;
		}> = [];

		for (const pg of pages) {
			if (localSelection.has(pg.id) && !resolvedIds.has(pg.id)) {
				resolvedIds.add(pg.id);
				results.push({
					pageId: pg.id,
					title: pg.title,
					spaceKey: pg.spaceKey,
					url: pg.url,
					mcpConfigId: mcpConfigId ?? "",
				});
			}
		}

		// Resolve selections not in the current view via the accumulated
		// known-pages map (e.g. selected in search, then navigated away). Only
		// fall back to the raw id when a page was never loaded.
		for (const id of localSelection) {
			if (resolvedIds.has(id)) {
				continue;
			}
			resolvedIds.add(id);
			const known = knownPages.get(id);
			results.push({
				pageId: id,
				title: known?.title || id,
				spaceKey: known?.spaceKey ?? "",
				url: known?.url,
				mcpConfigId: mcpConfigId ?? "",
			});
		}

		onConfirm(results);
	}, [localSelection, pages, knownPages, onConfirm, mcpConfigId]);

	// ── Render ─────────────────────────────────────────────────────────────

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
				<DialogHeader className="flex-shrink-0">
					<DialogTitle className="flex items-center gap-2">
						<FileTextIcon className="size-5 text-blue-500" />
						{isAtRoot && spacesTool
							? "Select a Confluence Space"
							: "Select Confluence Pages"}
					</DialogTitle>
					<DialogDescription>
						{isAtRoot && spacesTool
							? "Choose a space to browse its pages, or search across all spaces."
							: "Select pages to include as context for your project."}
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 min-h-0 flex flex-col overflow-hidden">
					{toolsLoading ? (
						<div className="flex items-center justify-center py-8">
							<Loader2Icon className="size-6 animate-spin text-muted-foreground mr-2" />
							<span className="text-muted-foreground">
								Connecting to Confluence...
							</span>
						</div>
					) : toolsError ? (
						<div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
							<div className="flex items-center gap-2 text-destructive">
								<AlertCircleIcon className="size-5" />
								<span>{toolsError}</span>
							</div>
						</div>
					) : !hasRequiredTools ? (
						<div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
							<div className="flex items-start gap-2 text-highlight/80">
								<AlertCircleIcon className="size-5 mt-0.5" />
								<div>
									<p className="font-medium">
										Missing required tools
									</p>
									<p className="text-sm mt-1">
										Could not find search or browse tools.
										Ensure the Confluence MCP server is
										configured correctly.
									</p>
								</div>
							</div>
						</div>
					) : (
						<div className="flex flex-col h-full gap-3 min-h-0">
							{/* Breadcrumbs */}
							{(!isAtRoot || breadcrumbs.length > 1) && (
								<div className="flex items-center gap-1 text-sm flex-shrink-0 overflow-x-auto pb-1">
									{breadcrumbs.map((crumb, index) => (
										<div
											key={crumb.key ?? "root"}
											className="flex items-center"
										>
											{index > 0 && (
												<ChevronRightIcon className="size-4 text-muted-foreground mx-1 shrink-0" />
											)}
											<button
												type="button"
												onClick={() =>
													navigateToBreadcrumb(index)
												}
												className={cn(
													"flex items-center gap-1 px-2 py-1 rounded hover:bg-muted transition-colors whitespace-nowrap",
													index ===
														breadcrumbs.length -
															1 && !isSearchMode
														? "font-medium text-foreground"
														: "text-muted-foreground",
												)}
											>
												{index === 0 ? (
													<HomeIcon className="size-4" />
												) : (
													<FolderIcon className="size-4" />
												)}
												<TruncatedText
													as="span"
													text={crumb.title}
													className="max-w-[150px]"
												/>
											</button>
										</div>
									))}
								</div>
							)}

							{/* Search */}
							<div className="relative flex-shrink-0">
								<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
								<Input
									placeholder={
										isAtRoot && spacesTool
											? "Search Confluence pages or filter spaces..."
											: "Filter pages..."
									}
									value={searchQuery}
									onChange={(e) =>
										setSearchQuery(e.target.value)
									}
									className="pl-10 pr-10"
								/>
								{searchQuery && (
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												onClick={clearSearch}
												aria-label="Clear search"
												className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
											>
												<XIcon className="size-4" />
											</button>
										</TooltipTrigger>
										<TooltipContent>
											{tC("clearSearch")}
										</TooltipContent>
									</Tooltip>
								)}
							</div>

							{/* Select All / Deselect All (only when showing pages) */}
							{(!isAtRoot ||
								(isAtRoot && (!spacesTool || isSearchMode))) &&
								filteredPages.length > 0 && (
									<div className="flex items-center justify-between text-sm flex-shrink-0">
										<span className="text-muted-foreground">
											{localSelection.size > 0
												? `${localSelection.size} selected`
												: `${filteredPages.length} page${filteredPages.length !== 1 ? "s" : ""}`}
										</span>
										<div className="flex gap-2">
											<button
												type="button"
												onClick={selectAll}
												className="text-sm text-primary hover:underline cursor-pointer"
											>
												Select All
											</button>
											<span className="text-muted-foreground">
												|
											</span>
											<button
												type="button"
												onClick={deselectAll}
												className="text-sm text-primary hover:underline cursor-pointer"
											>
												Deselect All
											</button>
										</div>
									</div>
								)}

							{/* Content area */}
							<div className="flex-1 min-h-0 overflow-y-auto rounded-lg border">
								{/* ROOT: space listing (when not in search mode) */}
								{isAtRoot && spacesTool && !isSearchMode ? (
									spacesLoading ? (
										<div className="flex items-center justify-center h-full min-h-[200px]">
											<Loader2Icon className="size-6 animate-spin text-muted-foreground" />
										</div>
									) : filteredSpaces.length === 0 ? (
										<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-2 p-4">
											{searchQuery.trim() ? (
												<>
													<SearchIcon className="size-8 opacity-50" />
													<p>
														No spaces matching
														&ldquo;
														{searchQuery.trim()}
														&rdquo;
													</p>
													<Button
														variant="ghost"
														size="sm"
														onClick={clearSearch}
													>
														Clear filter
													</Button>
												</>
											) : (
												<>
													<FolderIcon className="size-8 opacity-50" />
													<p>No spaces found</p>
												</>
											)}
										</div>
									) : (
										<div className="p-2 space-y-1">
											{filteredSpaces.map((space) => (
												<button
													key={space.key}
													type="button"
													onClick={() =>
														navigateToSpace(space)
													}
													className="w-full flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-foreground/5"
												>
													<div className="shrink-0">
														<FolderIcon className="size-5 text-muted-foreground" />
													</div>
													<div className="flex-1 min-w-0 text-left">
														<TruncatedText
															as="p"
															text={space.name}
															className="font-medium"
														/>
														<p className="text-xs text-muted-foreground">
															{space.key}
															{space.type &&
																` - ${space.type}`}
														</p>
													</div>
													<ChevronRightIcon className="size-4 text-muted-foreground shrink-0" />
												</button>
											))}
										</div>
									)
								) : /* ROOT: search-only fallback (no spacesTool) */
								isAtRoot && !spacesTool && !isSearchMode ? (
									<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-2 p-4">
										<SearchIcon className="size-8 opacity-50" />
										<p className="font-medium">
											Search to find pages
										</p>
										<p className="text-xs text-center max-w-[250px]">
											Type in the search box above to find
											Confluence pages
										</p>
									</div>
								) : /* Pages list (search results or space pages) */
								pagesLoading ? (
									<div className="flex items-center justify-center h-full min-h-[200px]">
										<Loader2Icon className="size-6 animate-spin text-muted-foreground" />
									</div>
								) : pagesError ? (
									<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-2 p-4">
										<AlertCircleIcon className="size-8 opacity-50" />
										<p className="text-sm text-center">
											{pagesError}
										</p>
									</div>
								) : filteredPages.length === 0 ? (
									<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-2 p-4">
										<SearchIcon className="size-8 opacity-50" />
										<p>No pages found</p>
										<p className="text-xs text-center max-w-[250px]">
											{searchQuery.trim()
												? "Try a different search term"
												: "This space has no pages."}
										</p>
									</div>
								) : (
									<div className="p-2 space-y-1">
										{filteredPages.map((page) => {
											const isSynced =
												syncedPageIdSet.has(page.id);
											const isSelected =
												!isSynced &&
												localSelection.has(page.id);

											return (
												<div
													key={page.id}
													className={cn(
														"flex items-center gap-3 p-3 rounded-lg transition-colors",
														isSynced
															? "opacity-60"
															: isSelected
																? "bg-primary/10"
																: "hover:bg-foreground/5",
													)}
												>
													<Checkbox
														checked={
															isSynced ||
															isSelected
														}
														disabled={isSynced}
														aria-disabled={isSynced}
														onCheckedChange={() =>
															toggleSelection(
																page.id,
															)
														}
													/>

													<div className="shrink-0">
														<FileTextIcon className="size-5 text-muted-foreground" />
													</div>

													<button
														type="button"
														className="flex-1 min-w-0 text-left disabled:cursor-default"
														disabled={isSynced}
														onClick={() =>
															toggleSelection(
																page.id,
															)
														}
													>
														<TruncatedText
															as="p"
															text={
																page.title ||
																"Untitled"
															}
															className="font-medium text-sm"
														/>
														<TruncatedText
															as="p"
															text={`${
																page.spaceName ||
																page.spaceKey
															}${
																page.type
																	? ` - ${page.type}`
																	: ""
															}`}
															className="text-xs text-muted-foreground"
														/>
													</button>

													{isSynced && (
														<span className="shrink-0 text-xs font-medium text-muted-foreground">
															Added
														</span>
													)}

													{page.url && (
														<a
															href={page.url}
															target="_blank"
															rel="noopener noreferrer"
															onClick={(e) =>
																e.stopPropagation()
															}
															className="shrink-0 text-xs text-primary hover:underline"
														>
															Open
														</a>
													)}
												</div>
											);
										})}
									</div>
								)}
							</div>
						</div>
					)}
				</div>

				<DialogFooter className="flex-shrink-0 pt-4 border-t">
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								onClick={handleConfirm}
								disabled={
									confirmLoading ||
									toolsLoading ||
									!!toolsError ||
									!hasRequiredTools ||
									localSelection.size === 0 ||
									(isAtRoot && !!spacesTool && !isSearchMode)
								}
							>
								{confirmLoading && (
									<Loader2Icon className="size-4 animate-spin" />
								)}
								{isAtRoot && spacesTool && !isSearchMode
									? "Select a space first"
									: `Add ${localSelection.size} Page${localSelection.size !== 1 ? "s" : ""}`}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t("addConfluencePages")}
						</TooltipContent>
					</Tooltip>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
