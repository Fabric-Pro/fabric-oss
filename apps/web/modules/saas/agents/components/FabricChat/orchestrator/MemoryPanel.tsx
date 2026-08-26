/**
 * MemoryPanel - Shows learned patterns and conversation memory in the Orchestrator
 *
 * Displays:
 * - Learned patterns from past conversations
 * - Recent episodic memories (conversation history)
 * - Quick search functionality
 */

import { useOrganizationSlug } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ScrollArea } from "@ui/components/scroll-area";
import { SearchInput } from "@ui/components/search-input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	BrainIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ExternalLinkIcon,
	HelpCircleIcon,
	HistoryIcon,
	LightbulbIcon,
	SearchIcon,
	SparklesIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

const ITEMS_PER_PAGE = 5;

interface MemoryPanelProps {
	isOpen: boolean;
	onClose: () => void;
	organizationId?: string | null;
}

export function MemoryPanel({
	isOpen,
	onClose,
	organizationId,
}: MemoryPanelProps) {
	const queryClient = useQueryClient();
	const orgSlug = useOrganizationSlug();
	const [searchQuery, setSearchQuery] = useState("");
	const [patternsPage, setPatternsPage] = useState(0);
	const [episodesPage, setEpisodesPage] = useState(0);

	// Build settings page URL
	const settingsUrl = orgSlug
		? `/app/${orgSlug}/settings/ai-memory`
		: "/app/settings/ai-memory";

	// Fetch preferences (learned patterns)
	const { data: prefsData, isLoading: prefsLoading } = useQuery({
		queryKey: ["orchestrator-memory-preferences", organizationId],
		queryFn: () =>
			orpcClient.orchestrator.memory.getPreferences({
				organizationId: organizationId ?? null,
			}),
		enabled: isOpen,
	});

	// Fetch recent episodes
	const { data: episodesData, isLoading: episodesLoading } = useQuery({
		queryKey: ["orchestrator-memory-episodes", organizationId, 0],
		queryFn: () =>
			orpcClient.orchestrator.memory.getEpisodes({
				organizationId: organizationId ?? null,
				limit: 10,
			}),
		enabled: isOpen,
	});

	// Search episodes
	const {
		data: searchResults,
		isLoading: searchLoading,
		refetch: searchEpisodes,
	} = useQuery({
		queryKey: ["orchestrator-memory-search", organizationId, searchQuery],
		queryFn: () =>
			orpcClient.orchestrator.memory.searchEpisodes({
				organizationId: organizationId ?? null,
				query: searchQuery,
				limit: 10,
			}),
		enabled: false,
	});

	// Delete pattern mutation
	const deletePatternMutation = useMutation({
		mutationFn: (pattern: string) =>
			orpcClient.orchestrator.memory.deletePattern({
				organizationId: organizationId ?? null,
				pattern,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["orchestrator-memory-preferences"],
			});
			toast.success("Pattern removed");
		},
	});

	// Delete episode mutation
	const deleteEpisodeMutation = useMutation({
		mutationFn: (episodeId: string) =>
			orpcClient.orchestrator.memory.deleteEpisode({
				organizationId: organizationId ?? null,
				episodeId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["orchestrator-memory-episodes"],
			});
			toast.success("Memory removed");
		},
	});

	const handleSearch = () => {
		if (searchQuery.trim().length >= 3) {
			searchEpisodes();
		}
	};

	const learnedPatterns =
		(prefsData?.preferences?.preferences?.learnedPatterns as string[]) ||
		[];

	const formatRelativeTime = (date: Date | string) => {
		const d = new Date(date);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) {
			return "just now";
		}
		if (diffMins < 60) {
			return `${diffMins}m ago`;
		}
		if (diffHours < 24) {
			return `${diffHours}h ago`;
		}
		if (diffDays < 7) {
			return `${diffDays}d ago`;
		}
		return d.toLocaleDateString();
	};

	const displayEpisodes =
		searchResults?.episodes || episodesData?.episodes || [];

	// Pagination for patterns
	const patternsStart = patternsPage * ITEMS_PER_PAGE;
	const paginatedPatterns = learnedPatterns.slice(
		patternsStart,
		patternsStart + ITEMS_PER_PAGE,
	);
	const totalPatternsPages = Math.ceil(
		learnedPatterns.length / ITEMS_PER_PAGE,
	);

	// Pagination for episodes
	const episodesStart = episodesPage * ITEMS_PER_PAGE;
	const paginatedEpisodes = displayEpisodes.slice(
		episodesStart,
		episodesStart + ITEMS_PER_PAGE,
	);
	const totalEpisodesPages = Math.ceil(
		displayEpisodes.length / ITEMS_PER_PAGE,
	);

	return (
		<Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<SheetContent className="!w-[50vw] !max-w-none min-w-[400px] p-0">
				<SheetHeader className="px-4 pt-4 pb-2 border-b">
					<div className="flex items-center justify-between">
						<SheetTitle className="flex items-center gap-2">
							<BrainIcon className="size-5" />
							AI Memory
						</SheetTitle>
						<Link
							href={settingsUrl}
							className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
							onClick={onClose}
						>
							Full Settings
							<ExternalLinkIcon className="size-3" />
						</Link>
					</div>
					<SheetDescription>
						What Fabric AI remembers about you
					</SheetDescription>
				</SheetHeader>

				<ScrollArea className="h-[calc(100vh-100px)]">
					<div className="p-4 space-y-6">
						{/* Learned Patterns Section */}
						<div>
							<div className="flex items-center justify-between mb-3">
								<div className="flex items-center gap-2">
									<SparklesIcon className="size-4 text-highlight" />
									<h3 className="font-medium text-sm">
										Learned Patterns
									</h3>
									<Badge
										variant="outline"
										className="text-xs"
									>
										{learnedPatterns.length}
									</Badge>
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger asChild>
												<HelpCircleIcon className="size-3.5 text-muted-foreground/50 cursor-help" />
											</TooltipTrigger>
											<TooltipContent
												side="right"
												className="max-w-[300px] p-3"
											>
												<div className="space-y-2 text-xs">
													<p className="font-medium flex items-center gap-1.5">
														<LightbulbIcon className="size-3.5 text-highlight" />
														How to Teach Patterns
													</p>
													<p className="text-muted-foreground">
														Add these phrases to any
														message:
													</p>
													<ul className="space-y-1 text-muted-foreground">
														<li>
															&quot;Remember
															to...&quot;
														</li>
														<li>
															&quot;I
															prefer...&quot;
														</li>
														<li>
															&quot;From now
															on...&quot;
														</li>
														<li>
															&quot;Always
															show...&quot;
														</li>
														<li>
															&quot;Don&apos;t
															forget...&quot;
														</li>
													</ul>
													<p className="text-muted-foreground pt-1 border-t">
														<strong>
															Example:
														</strong>{" "}
														&quot;Show my tasks.
														Remember to always
														display them in a
														table.&quot;
													</p>
												</div>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</div>
								{totalPatternsPages > 1 && (
									<div className="flex items-center gap-1">
										<Button
											variant="ghost"
											size="sm"
											className="h-6 w-6 p-0"
											onClick={() =>
												setPatternsPage((p) =>
													Math.max(0, p - 1),
												)
											}
											disabled={patternsPage === 0}
										>
											<ChevronLeftIcon className="size-3" />
										</Button>
										<span className="text-xs text-muted-foreground">
											{patternsPage + 1}/
											{totalPatternsPages}
										</span>
										<Button
											variant="ghost"
											size="sm"
											className="h-6 w-6 p-0"
											onClick={() =>
												setPatternsPage((p) =>
													Math.min(
														totalPatternsPages - 1,
														p + 1,
													),
												)
											}
											disabled={
												patternsPage >=
												totalPatternsPages - 1
											}
										>
											<ChevronRightIcon className="size-3" />
										</Button>
									</div>
								)}
							</div>

							{prefsLoading ? (
								<div className="space-y-2">
									<Skeleton className="h-8 w-full" />
									<Skeleton className="h-8 w-full" />
								</div>
							) : paginatedPatterns.length > 0 ? (
								<div className="space-y-1.5">
									{paginatedPatterns.map((pattern, index) => (
										<div
											key={patternsStart + index}
											className="flex items-center gap-2 text-sm bg-muted/50 rounded-md px-3 py-2 group"
										>
											<SparklesIcon className="size-3 text-highlight/60 flex-shrink-0" />
											<span className="flex-1 text-muted-foreground">
												{pattern}
											</span>
											<Button
												variant="ghost"
												size="sm"
												className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
												onClick={() =>
													deletePatternMutation.mutate(
														pattern,
													)
												}
												disabled={
													deletePatternMutation.isPending
												}
											>
												<Trash2Icon className="size-3" />
											</Button>
										</div>
									))}
								</div>
							) : (
								<div className="bg-muted/30 rounded-lg p-4 text-center">
									<SparklesIcon className="size-8 text-highlight/30 mx-auto mb-2" />
									<p className="text-sm font-medium text-muted-foreground mb-1">
										No patterns learned yet
									</p>
									<p className="text-xs text-muted-foreground/80 mb-3">
										Teach me your preferences by adding
										phrases to your messages
									</p>
									<div className="text-left bg-background/50 rounded-md p-3 space-y-1.5">
										<p className="text-[11px] font-medium text-muted-foreground">
											Try saying:
										</p>
										<ul className="text-[11px] text-muted-foreground/80 space-y-1">
											<li className="flex items-start gap-2">
												<span className="text-highlight">
													✦
												</span>
												<span>
													&quot;Remember to always
													show results in tables&quot;
												</span>
											</li>
											<li className="flex items-start gap-2">
												<span className="text-highlight">
													✦
												</span>
												<span>
													&quot;I prefer concise
													bullet-point responses&quot;
												</span>
											</li>
											<li className="flex items-start gap-2">
												<span className="text-highlight">
													✦
												</span>
												<span>
													&quot;From now on, include
													timestamps&quot;
												</span>
											</li>
										</ul>
									</div>
								</div>
							)}
						</div>

						{/* Conversation Memory Section */}
						<div>
							<div className="flex items-center justify-between mb-3">
								<div className="flex items-center gap-2">
									<HistoryIcon className="size-4 text-primary" />
									<h3 className="font-medium text-sm">
										Conversation Memory
									</h3>
									<Badge
										variant="outline"
										className="text-xs"
									>
										{episodesData?.total ?? 0}
									</Badge>
								</div>
								{totalEpisodesPages > 1 && (
									<div className="flex items-center gap-1">
										<Button
											variant="ghost"
											size="sm"
											className="h-6 w-6 p-0"
											onClick={() =>
												setEpisodesPage((p) =>
													Math.max(0, p - 1),
												)
											}
											disabled={episodesPage === 0}
										>
											<ChevronLeftIcon className="size-3" />
										</Button>
										<span className="text-xs text-muted-foreground">
											{episodesPage + 1}/
											{totalEpisodesPages}
										</span>
										<Button
											variant="ghost"
											size="sm"
											className="h-6 w-6 p-0"
											onClick={() =>
												setEpisodesPage((p) =>
													Math.min(
														totalEpisodesPages - 1,
														p + 1,
													),
												)
											}
											disabled={
												episodesPage >=
												totalEpisodesPages - 1
											}
										>
											<ChevronRightIcon className="size-3" />
										</Button>
									</div>
								)}
							</div>

							{/* Search */}
							<div className="flex gap-2 mb-3">
								<div className="relative flex-1">
									<SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
									<SearchInput
										placeholder="Search memories..."
										value={searchQuery}
										onChange={(e) =>
											setSearchQuery(e.target.value)
										}
										onKeyDown={(e) =>
											e.key === "Enter" && handleSearch()
										}
										className="pl-8 h-8 text-sm"
									/>
								</div>
								{searchQuery && (
									<Button
										variant="ghost"
										size="sm"
										className="h-8 px-2"
										onClick={() => {
											setSearchQuery("");
											queryClient.removeQueries({
												queryKey: [
													"orchestrator-memory-search",
												],
											});
										}}
									>
										<XIcon className="size-3.5" />
									</Button>
								)}
							</div>

							{episodesLoading || searchLoading ? (
								<div className="space-y-2">
									<Skeleton className="h-16 w-full" />
									<Skeleton className="h-16 w-full" />
								</div>
							) : paginatedEpisodes.length > 0 ? (
								<div className="space-y-2">
									{paginatedEpisodes.map((episode) => (
										<div
											key={episode.id}
											className="bg-muted/50 rounded-md p-3 group"
										>
											<div className="flex items-start justify-between gap-2">
												<div className="flex-1 min-w-0">
													<p className="text-sm font-medium truncate">
														{episode.title}
													</p>
													<p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
														{episode.summary}
													</p>
													<div className="flex items-center gap-1.5 mt-2 flex-wrap">
														{episode.keyTopics
															.slice(0, 3)
															.map((topic) => (
																<Badge
																	key={topic}
																	variant="secondary"
																	className="text-[10px] px-1.5 py-0"
																>
																	{topic}
																</Badge>
															))}
														{episode.keyTopics
															.length > 3 && (
															<span className="text-[10px] text-muted-foreground">
																+
																{episode
																	.keyTopics
																	.length - 3}
															</span>
														)}
													</div>
												</div>
												<div className="flex flex-col items-end gap-1">
													<span className="text-[10px] text-muted-foreground">
														{formatRelativeTime(
															episode.conversationStartedAt,
														)}
													</span>
													<Button
														variant="ghost"
														size="sm"
														className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
														onClick={() =>
															deleteEpisodeMutation.mutate(
																episode.id,
															)
														}
														disabled={
															deleteEpisodeMutation.isPending
														}
													>
														<Trash2Icon className="size-3" />
													</Button>
												</div>
											</div>
										</div>
									))}
								</div>
							) : (
								<p className="text-sm text-muted-foreground text-center py-4">
									No conversation history yet. Your past
									conversations will appear here.
								</p>
							)}
						</div>
					</div>
				</ScrollArea>
			</SheetContent>
		</Sheet>
	);
}

// =============================================================================
// Trigger Button Component
// =============================================================================

interface MemoryPanelTriggerProps {
	onClick: () => void;
	patternsCount?: number;
	episodesCount?: number;
	isActive?: boolean;
	className?: string;
}

export function MemoryPanelTrigger({
	onClick,
	patternsCount = 0,
	episodesCount = 0,
	isActive = false,
	className,
}: MemoryPanelTriggerProps) {
	const totalItems = patternsCount + episodesCount;

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant={isActive ? "secondary" : "ghost"}
						size="sm"
						className={cn(
							"gap-2 transition-colors",
							isActive && "bg-primary/10",
							className,
						)}
						onClick={onClick}
					>
						<BrainIcon className="size-4" />
						<span className="hidden sm:inline">Memory</span>
						{totalItems > 0 && (
							<Badge
								variant="secondary"
								className="text-[10px] px-1.5 py-0"
							>
								{totalItems}
							</Badge>
						)}
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="max-w-[260px] p-3">
					<div className="text-xs space-y-2">
						<p className="font-medium">AI Memory</p>
						{totalItems > 0 ? (
							<div className="space-y-1.5">
								{patternsCount > 0 && (
									<div className="flex items-center gap-2 text-muted-foreground">
										<SparklesIcon className="size-3 text-highlight" />
										<span>
											{patternsCount} learned pattern
											{patternsCount !== 1 ? "s" : ""}
										</span>
									</div>
								)}
								{episodesCount > 0 && (
									<div className="flex items-center gap-2 text-muted-foreground">
										<HistoryIcon className="size-3" />
										<span>
											{episodesCount} conversation
											{episodesCount !== 1 ? "s" : ""}{" "}
											remembered
										</span>
									</div>
								)}
								<p className="text-muted-foreground/70 text-[10px] pt-1 border-t">
									Click to view and manage memories
								</p>
							</div>
						) : (
							<div className="space-y-2">
								<p className="text-muted-foreground">
									Fabric AI learns from your conversations
								</p>
								<div className="text-muted-foreground/80 space-y-0.5">
									<p className="text-[10px]">
										Teach patterns by saying:
									</p>
									<p className="text-[10px] italic">
										&quot;Remember to...&quot; or &quot;I
										prefer...&quot;
									</p>
								</div>
							</div>
						)}
					</div>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
