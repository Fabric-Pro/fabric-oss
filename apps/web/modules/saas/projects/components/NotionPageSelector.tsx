"use client";

/**
 * Shared Notion page selector dialog.
 *
 * Used across project setup and project knowledge flows to choose the Notion
 * pages Fabric should keep nearby.
 */

import { Badge } from "@ui/components/badge";
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
	CheckCircleIcon,
	ChevronRightIcon,
	DatabaseIcon,
	FileTextIcon,
	FolderIcon,
	FolderOpenIcon,
	HomeIcon,
	Loader2Icon,
	SearchIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type BreadcrumbItem,
	type NotionPage,
	parseChildPagesFromContent,
	parseNotionResults,
	rankSearchResults,
} from "../lib/notion-utils";

export type NotionPageSelectorResult = {
	pageId: string;
	title: string;
	url?: string;
	icon?: string;
	type?: "page" | "database";
	lastEdited?: string;
};

type NotionPageSelectorMeta = {
	fetchToolName?: string;
};

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mcpConfigId: string | null;
	organizationId?: string | null;
	onConfirm: (
		pages: NotionPageSelectorResult[],
		meta: NotionPageSelectorMeta,
	) => void;
	initialSelectedIds?: string[];
	syncedPageIds?: string[];
	confirmLoading?: boolean;
	selectionMode?: "single" | "multi";
};

export function NotionPageSelector({
	open,
	onOpenChange,
	mcpConfigId,
	organizationId,
	onConfirm,
	initialSelectedIds = [],
	syncedPageIds = [],
	confirmLoading = false,
	selectionMode = "multi",
}: Props) {
	const t = useTranslations("tooltips.contextSources");
	const tC = useTranslations("tooltips.common");

	// Navigation state
	const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
	const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
		{ id: null, title: "Team Spaces" },
	]);

	// Search state
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [isSearchMode, setIsSearchMode] = useState(false);

	// Selection state
	const [localSelection, setLocalSelection] = useState<Set<string>>(
		new Set(),
	);

	// Tools state
	const [availableTools, setAvailableTools] = useState<string[]>([]);
	const [toolsLoading, setToolsLoading] = useState(false);
	const [toolsError, setToolsError] = useState<string | null>(null);

	// Teams state (for root-level team space listing)
	const [teams, setTeams] = useState<
		Array<{ id: string; name: string; type: string; role: string }>
	>([]);
	const [teamsLoading, setTeamsLoading] = useState(false);

	// Pages state
	const [pages, setPages] = useState<NotionPage[]>([]);
	const [pagesLoading, setPagesLoading] = useState(false);
	const [pagesError, setPagesError] = useState<string | null>(null);

	// Cache pages across team space visits so handleConfirm can resolve cross-space selections
	const pageCacheRef = useRef<Map<string, NotionPage>>(new Map());

	// Stable ref for initialSelectedIds to avoid infinite loop in reset effect.
	// Default prop `initialSelectedIds = []` creates a new array every render,
	// which would re-trigger the effect on every render when open=true.
	const initialSelectedIdsRef = useRef(initialSelectedIds);
	initialSelectedIdsRef.current = initialSelectedIds;

	// Derived state
	const isAtRoot = currentFolderId === null;

	// Client-side filtering at root (for team space filter and search-only fallback)
	const filteredPages = useMemo(() => {
		if (!isAtRoot) {
			return pages;
		}
		if (!searchQuery.trim()) {
			return pages;
		}
		const q = searchQuery.toLowerCase().trim();
		return pages.filter((p) => p.title.toLowerCase().includes(q));
	}, [pages, searchQuery, isAtRoot]);

	// Select All: adds all currently visible page IDs
	const selectAll = useCallback(() => {
		setLocalSelection((prev) => {
			const next = new Set(prev);
			for (const p of filteredPages) {
				if (!syncedPageIds.includes(p.id)) {
					next.add(p.id);
				}
			}
			return next;
		});
	}, [filteredPages, syncedPageIds]);

	// Deselect All: removes only currently visible page IDs
	const deselectAll = useCallback(() => {
		const visibleIds = new Set(filteredPages.map((p) => p.id));
		setLocalSelection((prev) => {
			const next = new Set(prev);
			for (const id of visibleIds) {
				next.delete(id);
			}
			return next;
		});
	}, [filteredPages]);

	// Debounce search query
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedQuery(searchQuery);
			setIsSearchMode(searchQuery.trim().length > 0);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	// Reset state when dialog opens.
	// initialSelectedIds is intentionally read from a ref (not listed as a dep)
	// to avoid an infinite loop: the default `[]` prop creates a new array every
	// render, which would re-fire this effect on every render while open=true.
	// Callers must ensure initialSelectedIds is finalized before setting open=true
	// (i.e., don't mutate it while the dialog is open). All current callers satisfy
	// this: the value is derived from stable server state, not in-flight local state.
	useEffect(() => {
		if (open) {
			setLocalSelection(new Set(initialSelectedIdsRef.current));
			setSearchQuery("");
			setDebouncedQuery("");
			setIsSearchMode(false);
			setCurrentFolderId(null);
			setBreadcrumbs([{ id: null, title: "Team Spaces" }]);
			setTeams([]);
			setPages([]);
			setPagesError(null);
			pageCacheRef.current.clear();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Fetch available tools
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

	// Tool detection
	const searchTool = useMemo(() => {
		return availableTools.find((t) => t.toLowerCase().includes("search"));
	}, [availableTools]);

	const teamsTool = useMemo(() => {
		return availableTools.find((t) => {
			const lower = t.toLowerCase();
			return lower.includes("get-teams") || lower.includes("get_teams");
		});
	}, [availableTools]);

	const fetchTool = useMemo(() => {
		return availableTools.find((t) => {
			const lower = t.toLowerCase();
			return (
				(lower.includes("fetch") ||
					lower.includes("get_page") ||
					lower.includes("read_page")) &&
				!lower.includes("search") &&
				!lower.includes("teams")
			);
		});
	}, [availableTools]);

	// Client-side filtered teams for root-level search
	const filteredTeams = useMemo(() => {
		if (!searchQuery.trim()) {
			return teams;
		}
		const q = searchQuery.toLowerCase().trim();
		return teams.filter((t) => t.name.toLowerCase().includes(q));
	}, [teams, searchQuery]);

	// Fetch team spaces when at root and teamsTool is available
	useEffect(() => {
		if (!open || !mcpConfigId || toolsLoading || !teamsTool || !isAtRoot) {
			return;
		}

		async function fetchTeams() {
			setTeamsLoading(true);
			try {
				const response = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId,
						toolName: teamsTool,
						params: {},
						organizationId: organizationId ?? undefined,
					}),
				});

				const data = await response.json();
				if (data.error) {
					console.error(
						"[NotionPageSelector] Teams error:",
						data.error,
					);
					setTeams([]);
					return;
				}

				let parsedTeams: Array<{
					id: string;
					name: string;
					type: string;
					role: string;
				}> = [];

				try {
					const result =
						typeof data.result === "string"
							? JSON.parse(data.result)
							: data.result;

					// Handle text content array format from MCP
					if (Array.isArray(result)) {
						for (const item of result) {
							if (item.type === "text" && item.text) {
								const parsed =
									typeof item.text === "string"
										? JSON.parse(item.text)
										: item.text;
								if (parsed.joinedTeams) {
									parsedTeams = parsed.joinedTeams;
									break;
								}
							}
						}
					} else if (result?.joinedTeams) {
						parsedTeams = result.joinedTeams;
					}
				} catch (parseErr) {
					console.error(
						"[NotionPageSelector] Failed to parse teams:",
						parseErr,
					);
				}

				setTeams(parsedTeams);
			} catch (err) {
				console.error("[NotionPageSelector] Teams fetch error:", err);
				setTeams([]);
			} finally {
				setTeamsLoading(false);
			}
		}

		fetchTeams();
	}, [open, mcpConfigId, toolsLoading, teamsTool, isAtRoot, organizationId]);

	// Fetch pages: inside a team space, or at root in search-only fallback (no teamsTool)
	useEffect(() => {
		if (
			!open ||
			!mcpConfigId ||
			toolsLoading ||
			(isAtRoot && !!teamsTool)
		) {
			return;
		}

		if (!searchTool) {
			setPages([]);
			setPagesLoading(false);
			return;
		}

		// notion-search requires a query parameter
		if (!debouncedQuery || debouncedQuery.trim().length === 0) {
			if (isAtRoot) {
				setPages([]);
				setPagesLoading(false);
			}
			return;
		}

		async function fetchPages() {
			setPagesLoading(true);
			setPagesError(null);
			try {
				const params: Record<string, string> = {
					query: debouncedQuery.trim(),
				};

				const response = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId,
						toolName: searchTool,
						params,
						organizationId: organizationId ?? undefined,
					}),
				});

				const data = await response.json();
				if (data.error) {
					console.error(
						"[NotionPageSelector] MCP error:",
						data.error,
					);
					setPagesError(data.error);
					return;
				}

				const parsedPages = parseNotionResults(data.result);
				for (const p of parsedPages) {
					pageCacheRef.current.set(p.id, p);
				}
				setPages(rankSearchResults(parsedPages, debouncedQuery));
			} catch (err) {
				console.error("[NotionPageSelector] Fetch error:", err);
				setPagesError(
					err instanceof Error ? err.message : "Failed to load pages",
				);
			} finally {
				setPagesLoading(false);
			}
		}

		fetchPages();
	}, [
		open,
		mcpConfigId,
		toolsLoading,
		searchTool,
		debouncedQuery,
		currentFolderId,
		isAtRoot,
		organizationId,
		teamsTool,
	]);

	// Fetch child pages of a team space by finding and fetching its home page
	const fetchTeamChildPages = useCallback(
		async (teamName: string) => {
			if (!mcpConfigId || !searchTool || !fetchTool) {
				return;
			}

			setPagesLoading(true);
			setPagesError(null);
			setPages([]);

			try {
				// Step 1: Search for the team name to find home page
				const searchResp = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId,
						toolName: searchTool,
						params: { query: teamName },
						organizationId: organizationId ?? undefined,
					}),
				});
				const searchData = await searchResp.json();
				if (searchData.error) {
					setPagesError(searchData.error);
					return;
				}

				const searchResults = parseNotionResults(searchData.result);
				// Find a page likely to be the teamspace home
				const homePage =
					searchResults.find((p) => {
						const lower = p.title.toLowerCase();
						return (
							lower.includes("teamspace home") ||
							lower.includes("team home") ||
							(lower.includes("home") &&
								lower.includes(
									teamName.split(" ")[0].toLowerCase(),
								))
						);
					}) || searchResults[0];

				if (!homePage) {
					setPagesError("Could not find team space home page");
					return;
				}

				// Step 2: Fetch the home page to get child page references
				const fetchResp = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId,
						toolName: fetchTool,
						params: { id: homePage.id },
						organizationId: organizationId ?? undefined,
					}),
				});
				const fetchData = await fetchResp.json();
				if (fetchData.error) {
					console.error(
						"[NotionPageSelector] Fetch error:",
						fetchData.error,
					);
					setPagesError("Could not load team space pages");
					return;
				}

				// Step 3: Parse child pages from content
				const content =
					typeof fetchData.result === "string"
						? fetchData.result
						: fetchData.result?.text ||
							JSON.stringify(fetchData.result);

				const childPages = parseChildPagesFromContent(content);

				if (childPages.length === 0) {
					// Fallback: show search results for team name instead
					const parsedPages = parseNotionResults(searchData.result);
					for (const p of parsedPages) {
						pageCacheRef.current.set(p.id, p);
					}
					setPages(parsedPages);
					return;
				}

				// Convert to NotionPage format
				const notionPages: NotionPage[] = childPages.map((cp) => ({
					id: cp.id,
					title: cp.title,
					type: "page" as const,
					url: cp.url,
					hasChildren: false,
				}));

				for (const p of notionPages) {
					pageCacheRef.current.set(p.id, p);
				}
				setPages(notionPages);
			} catch (err) {
				console.error(
					"[NotionPageSelector] Team child pages error:",
					err,
				);
				setPagesError(
					err instanceof Error
						? err.message
						: "Failed to load team pages",
				);
			} finally {
				setPagesLoading(false);
			}
		},
		[mcpConfigId, searchTool, fetchTool, organizationId],
	);

	// Navigate into a team space
	const navigateToTeam = useCallback(
		(team: { id: string; name: string }) => {
			setCurrentFolderId(team.id);
			setBreadcrumbs((prev) => [
				...prev,
				{ id: team.id, title: team.name },
			]);
			setSearchQuery("");
			setDebouncedQuery("");
			setIsSearchMode(false);
			setPages([]);
			setPagesError(null);
			fetchTeamChildPages(team.name);
		},
		[fetchTeamChildPages],
	);

	const navigateToBreadcrumb = useCallback((index: number) => {
		setBreadcrumbs((prev) => {
			const sliced = prev.slice(0, index + 1);
			setCurrentFolderId(
				index === 0 ? null : (sliced[index]?.id ?? null),
			);
			return sliced;
		});
		setSearchQuery("");
		setDebouncedQuery("");
		setIsSearchMode(false);
		setPages([]);
	}, []);

	const clearSearch = useCallback(() => {
		setSearchQuery("");
		setDebouncedQuery("");
		setIsSearchMode(false);
	}, []);

	// Selection
	const toggleSelection = useCallback(
		(page: NotionPage) => {
			if (syncedPageIds.includes(page.id)) {
				return;
			}
			setLocalSelection((prev) => {
				if (selectionMode === "single") {
					return new Set([page.id]);
				}
				const next = new Set(prev);
				if (next.has(page.id)) {
					next.delete(page.id);
				} else {
					next.add(page.id);
				}
				return next;
			});
		},
		[selectionMode, syncedPageIds],
	);

	const handleConfirm = useCallback(() => {
		const resolvedIds = new Set<string>();
		const results: NotionPageSelectorResult[] = [];

		// Resolve from page cache first
		for (const p of pageCacheRef.current.values()) {
			if (localSelection.has(p.id) && !resolvedIds.has(p.id)) {
				resolvedIds.add(p.id);
				results.push({
					pageId: p.id,
					title: p.title,
					url: p.url,
					icon: p.icon,
					type: p.type,
					lastEdited: p.lastEdited,
				});
			}
		}

		// Also include pages from current filteredPages that might not be in cache
		for (const p of filteredPages) {
			if (localSelection.has(p.id) && !resolvedIds.has(p.id)) {
				resolvedIds.add(p.id);
				results.push({
					pageId: p.id,
					title: p.title,
					url: p.url,
					icon: p.icon,
					type: p.type,
					lastEdited: p.lastEdited,
				});
			}
		}

		// Preserve any selected IDs from initialSelectedIds that weren't fetched
		// in this session (e.g., user re-opened dialog without revisiting those pages)
		for (const id of localSelection) {
			if (!resolvedIds.has(id)) {
				results.push({
					pageId: id,
					title: id, // Fallback title - page wasn't fetched this session
				});
			}
		}

		onConfirm(results, { fetchToolName: fetchTool ?? undefined });
	}, [localSelection, filteredPages, onConfirm, fetchTool]);

	const hasRequiredTools = !!teamsTool || !!searchTool;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
				<DialogHeader className="flex-shrink-0">
					<DialogTitle>
						{isAtRoot && teamsTool
							? "Select a Team Space"
							: selectionMode === "single"
								? "Select a Notion Page"
								: "Select Notion Pages"}
					</DialogTitle>
					<DialogDescription>
						{isAtRoot && teamsTool
							? "Choose a team space to browse its pages."
							: selectionMode === "single"
								? "Select a page to use."
								: "Select pages to include as context for your project."}
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 min-h-0 flex flex-col overflow-hidden">
					{toolsLoading ? (
						<div className="flex items-center justify-center py-8">
							<Loader2Icon className="size-6 animate-spin text-muted-foreground mr-2" />
							<span className="text-muted-foreground">
								Loading...
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
										Could not find browse or search tools.
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
											key={crumb.id ?? "root"}
											className="flex items-center"
										>
											{index > 0 && (
												<ChevronRightIcon className="size-4 text-muted-foreground mx-1 shrink-0" />
											)}
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														onClick={() =>
															navigateToBreadcrumb(
																index,
															)
														}
														className={cn(
															"flex items-center gap-1 px-2 py-1 rounded hover:bg-muted transition-colors whitespace-nowrap",
															index ===
																breadcrumbs.length -
																	1 &&
																!isSearchMode
																? "font-medium text-foreground"
																: "text-muted-foreground",
														)}
													>
														{index === 0 ? (
															<HomeIcon className="size-4" />
														) : (
															<FolderIcon className="size-4" />
														)}
														<span
															className="max-w-[150px] truncate"
															title={crumb.title}
														>
															{crumb.title}
														</span>
													</button>
												</TooltipTrigger>
												<TooltipContent
													side="top"
													sideOffset={6}
													className="max-w-[420px] break-words"
												>
													{crumb.title}
												</TooltipContent>
											</Tooltip>
										</div>
									))}
								</div>
							)}

							{/* Search input */}
							<div className="relative flex-shrink-0">
								<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
								<Input
									placeholder={
										isAtRoot && teamsTool
											? "Filter team spaces..."
											: isAtRoot
												? "Search Notion pages..."
												: "Search all Notion pages..."
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

							{/* Select All / Deselect All */}
							{selectionMode === "multi" &&
								(!isAtRoot || (isAtRoot && !teamsTool)) &&
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
								{/* ROOT: Team spaces */}
								{isAtRoot && teamsTool ? (
									teamsLoading ? (
										<div className="flex items-center justify-center h-full min-h-[200px]">
											<Loader2Icon className="size-6 animate-spin text-muted-foreground" />
										</div>
									) : filteredTeams.length === 0 ? (
										<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-2 p-4">
											{searchQuery.trim() ? (
												<>
													<SearchIcon className="size-8 opacity-50" />
													<p>
														No team spaces matching
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
													<FolderOpenIcon className="size-8 opacity-50" />
													<p>No team spaces found</p>
												</>
											)}
										</div>
									) : (
										<div className="p-2 space-y-1">
											{filteredTeams.map((team) => (
												<Tooltip key={team.id}>
													<TooltipTrigger asChild>
														<button
															type="button"
															onClick={() =>
																navigateToTeam(
																	team,
																)
															}
															className="w-full flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-foreground/5"
														>
															<div className="shrink-0">
																<FolderIcon className="size-5 text-muted-foreground" />
															</div>
															<div className="flex-1 min-w-0 text-left">
																<p
																	className="font-medium truncate"
																	title={
																		team.name
																	}
																>
																	{team.name}
																</p>
																<div className="flex items-center gap-2 text-xs text-muted-foreground">
																	<Badge
																		variant="outline"
																		className="text-xs capitalize"
																	>
																		{team.role ||
																			"member"}
																	</Badge>
																	{team.type && (
																		<span className="capitalize">
																			{
																				team.type
																			}
																		</span>
																	)}
																</div>
															</div>
															<ChevronRightIcon className="size-4 text-muted-foreground shrink-0" />
														</button>
													</TooltipTrigger>
													<TooltipContent
														side="top"
														sideOffset={6}
														className="max-w-[420px] break-words"
													>
														{team.name}
													</TooltipContent>
												</Tooltip>
											))}
										</div>
									)
								) : /* ROOT: No teams tool, search-only fallback */
								isAtRoot && !teamsTool ? (
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
											<p className="font-medium">
												Search to find pages
											</p>
											<p className="text-xs text-center max-w-[250px]">
												Type in the search box above to
												find Notion pages
											</p>
										</div>
									) : (
										<PageList
											pages={filteredPages}
											localSelection={localSelection}
											syncedPageIds={syncedPageIds}
											toggleSelection={toggleSelection}
										/>
									)
								) : /* INSIDE TEAM SPACE: Pages with checkboxes */
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
												: "This team space has no linked pages. Try searching above."}
										</p>
									</div>
								) : (
									<PageList
										pages={filteredPages}
										localSelection={localSelection}
										syncedPageIds={syncedPageIds}
										toggleSelection={toggleSelection}
									/>
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
									(isAtRoot && !!teamsTool) ||
									localSelection.size === 0 ||
									!hasRequiredTools ||
									confirmLoading
								}
							>
								{confirmLoading ? (
									<>
										<Loader2Icon className="size-4 animate-spin mr-2" />
										Adding...
									</>
								) : isAtRoot && teamsTool ? (
									"Select a team space first"
								) : selectionMode === "single" ? (
									"Select"
								) : (
									`Add ${localSelection.size} Page${localSelection.size !== 1 ? "s" : ""}`
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("addNotionPages")}</TooltipContent>
					</Tooltip>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Shared page list rendering */
function PageList({
	pages,
	localSelection,
	syncedPageIds,
	toggleSelection,
}: {
	pages: NotionPage[];
	localSelection: Set<string>;
	syncedPageIds: string[];
	toggleSelection: (page: NotionPage) => void;
}) {
	return (
		<div className="p-2 space-y-1">
			{pages.map((page) => {
				const isSelected = localSelection.has(page.id);
				const isSynced = syncedPageIds.includes(page.id);

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
						{/* Checkbox */}
						{isSynced ? (
							<CheckCircleIcon className="size-4 text-success shrink-0" />
						) : (
							<Checkbox
								checked={isSelected}
								onCheckedChange={() => toggleSelection(page)}
							/>
						)}

						{/* Icon */}
						<div className="shrink-0">
							{page.icon ? (
								<span className="text-lg">{page.icon}</span>
							) : page.type === "database" ? (
								<DatabaseIcon className="size-5 text-muted-foreground" />
							) : page.hasChildren ? (
								<FolderIcon className="size-5 text-muted-foreground" />
							) : (
								<FileTextIcon className="size-5 text-muted-foreground" />
							)}
						</div>

						{/* Title */}
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className="flex-1 min-w-0 text-left"
									onClick={() => {
										if (!isSynced) {
											toggleSelection(page);
										}
									}}
								>
									<p
										className="font-medium truncate"
										title={page.title || "Untitled"}
									>
										{page.title || "Untitled"}
									</p>
									<div className="flex items-center gap-2 text-xs text-muted-foreground">
										<Badge
											variant="outline"
											className="text-xs capitalize"
										>
											{page.type}
										</Badge>
										{isSynced && (
											<Badge
												variant="secondary"
												className="text-xs"
											>
												Synced
											</Badge>
										)}
									</div>
								</button>
							</TooltipTrigger>
							<TooltipContent
								side="top"
								sideOffset={6}
								className="max-w-[520px]"
							>
								<div className="font-medium break-words">
									{page.title || "Untitled"}
								</div>
								{page.url ? (
									<div className="mt-1 text-[11px] opacity-80 break-all">
										{page.url}
									</div>
								) : null}
								{page.type || page.lastEdited ? (
									<div className="mt-1 flex items-center gap-2 text-[11px] opacity-70">
										{page.type && (
											<span className="capitalize">
												{page.type}
											</span>
										)}
										{page.lastEdited && (
											<span>
												Edited{" "}
												{new Date(
													page.lastEdited,
												).toLocaleDateString(
													undefined,
													{
														year: "numeric",
														month: "short",
														day: "numeric",
													},
												)}
											</span>
										)}
									</div>
								) : null}
							</TooltipContent>
						</Tooltip>
					</div>
				);
			})}
		</div>
	);
}
