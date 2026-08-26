"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import {
	BrainCircuitIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	HistoryIcon,
	LoaderIcon,
	MessageSquareIcon,
	SaveIcon,
	SearchIcon,
	SparklesIcon,
	Trash2Icon,
	UsersIcon,
	WrenchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const RESPONSE_STYLES = [
	{
		id: "detailed",
		label: "Detailed",
		description: "Comprehensive explanations with examples",
	},
	{
		id: "concise",
		label: "Concise",
		description: "Brief, to-the-point responses",
	},
	{
		id: "bullet_points",
		label: "Bullet Points",
		description: "Structured lists for quick scanning",
	},
	{
		id: "conversational",
		label: "Conversational",
		description: "Friendly, natural dialogue style",
	},
] as const;

const VERBOSITY_LEVELS = [
	{ id: "minimal", label: "Minimal", description: "Just the essentials" },
	{ id: "concise", label: "Concise", description: "Brief but complete" },
	{ id: "standard", label: "Standard", description: "Balanced detail level" },
	{ id: "detailed", label: "Detailed", description: "In-depth explanations" },
] as const;

const CODE_LANGUAGES = [
	{ id: "typescript", label: "TypeScript" },
	{ id: "javascript", label: "JavaScript" },
	{ id: "python", label: "Python" },
	{ id: "rust", label: "Rust" },
	{ id: "go", label: "Go" },
	{ id: "java", label: "Java" },
	{ id: "csharp", label: "C#" },
	{ id: "cpp", label: "C++" },
	{ id: "ruby", label: "Ruby" },
	{ id: "php", label: "PHP" },
] as const;

interface OrchestratorMemoryFormProps {
	organizationId?: string | null;
}

const EPISODES_PER_PAGE = 10;

export function OrchestratorMemoryForm({
	organizationId,
}: OrchestratorMemoryFormProps) {
	const queryClient = useQueryClient();

	// Local state for form
	const [responseStyle, setResponseStyle] = useState<string | undefined>();
	const [verbosity, setVerbosity] = useState<string | undefined>();
	const [codeLanguage, setCodeLanguage] = useState<string | undefined>();
	const [hasChanges, setHasChanges] = useState(false);

	// Episode viewer state
	const [expandedEpisodes, setExpandedEpisodes] = useState<Set<string>>(
		new Set(),
	);
	const [searchQuery, setSearchQuery] = useState("");
	const [episodeOffset, setEpisodeOffset] = useState(0);

	// Fetch current preferences
	const { data, isLoading, error } = useQuery({
		queryKey: ["orchestrator-memory-preferences", organizationId],
		queryFn: () =>
			orpcClient.orchestrator.memory.getPreferences({
				organizationId: organizationId ?? null,
			}),
		// Cache preferences for 2 minutes - they rarely change
		staleTime: 2 * 60 * 1000,
		gcTime: 5 * 60 * 1000,
	});

	// Fetch episodes with pagination
	const { data: episodesData, isLoading: episodesLoading } = useQuery({
		queryKey: [
			"orchestrator-memory-episodes",
			organizationId,
			episodeOffset,
		],
		queryFn: () =>
			orpcClient.orchestrator.memory.getEpisodes({
				organizationId: organizationId ?? null,
				limit: EPISODES_PER_PAGE,
				offset: episodeOffset,
			}),
		// Cache episode list for 1 minute
		staleTime: 60 * 1000,
		gcTime: 5 * 60 * 1000,
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
				limit: 20,
			}),
		enabled: false, // Only search when triggered
	});

	// Toggle episode expansion
	const toggleEpisode = (episodeId: string) => {
		setExpandedEpisodes((prev) => {
			const next = new Set(prev);
			if (next.has(episodeId)) {
				next.delete(episodeId);
			} else {
				next.add(episodeId);
			}
			return next;
		});
	};

	// Handle search
	const handleSearch = () => {
		if (searchQuery.trim().length >= 3) {
			searchEpisodes();
		}
	};

	// Format relative time
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

	// Update preferences mutation
	const updateMutation = useMutation({
		mutationFn: (updates: {
			responseStyle?: string;
			verbosity?: string;
			codeLanguage?: string;
		}) =>
			orpcClient.orchestrator.memory.updatePreferences({
				organizationId: organizationId ?? null,
				responseStyle: updates.responseStyle as any,
				verbosity: updates.verbosity as any,
				codeLanguage: updates.codeLanguage,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["orchestrator-memory-preferences"],
			});
			toast.success("Preferences saved");
			setHasChanges(false);
		},
		onError: (error) => {
			toast.error("Failed to save preferences");
			console.error(error);
		},
	});

	// Clear patterns mutation
	const clearPatternsMutation = useMutation({
		mutationFn: () =>
			orpcClient.orchestrator.memory.clearLearnedPatterns({
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["orchestrator-memory-preferences"],
			});
			toast.success("Learned patterns cleared");
		},
		onError: (error) => {
			toast.error("Failed to clear patterns");
			console.error(error);
		},
	});

	// Delete single pattern mutation
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
		onError: (error) => {
			toast.error("Failed to remove pattern");
			console.error(error);
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
			queryClient.invalidateQueries({
				queryKey: ["orchestrator-memory-search"],
			});
			toast.success("Conversation removed from memory");
		},
		onError: (error) => {
			toast.error("Failed to remove conversation");
			console.error(error);
		},
	});

	// Initialize form state from server data
	useEffect(() => {
		if (data?.preferences) {
			setResponseStyle(data.preferences.responseStyle ?? undefined);
			setVerbosity(data.preferences.verbosity ?? undefined);
			setCodeLanguage(data.preferences.codeLanguage ?? undefined);
		}
	}, [data]);

	// Track changes
	useEffect(() => {
		if (!data?.preferences) {
			return;
		}
		const changed =
			responseStyle !== (data.preferences.responseStyle ?? undefined) ||
			verbosity !== (data.preferences.verbosity ?? undefined) ||
			codeLanguage !== (data.preferences.codeLanguage ?? undefined);
		setHasChanges(changed);
	}, [responseStyle, verbosity, codeLanguage, data]);

	const handleSave = () => {
		updateMutation.mutate({
			responseStyle,
			verbosity,
			codeLanguage,
		});
	};

	const learnedPatterns =
		(data?.preferences?.preferences as { learnedPatterns?: string[] })
			?.learnedPatterns || [];

	if (isLoading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-32 w-full" />
				<Skeleton className="h-32 w-full" />
				<Skeleton className="h-32 w-full" />
			</div>
		);
	}

	if (error) {
		return (
			<Card className="p-6">
				<p className="text-destructive">
					Failed to load preferences. Please try again.
				</p>
			</Card>
		);
	}

	return (
		<div className="space-y-6">
			{/* Response Preferences */}
			<Card className="p-6">
				<div className="flex items-center gap-3 mb-4">
					<MessageSquareIcon className="size-5 text-primary" />
					<h3 className="font-semibold text-lg">Response Style</h3>
					{data?.isDefault && (
						<Badge variant="secondary">Using Defaults</Badge>
					)}
				</div>

				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					<div className="space-y-1.5">
						<p className="text-sm font-medium">Response Format</p>
						<Select
							value={responseStyle ?? "auto"}
							onValueChange={(v) =>
								setResponseStyle(v === "auto" ? undefined : v)
							}
						>
							<SelectTrigger>
								<SelectValue placeholder="Auto" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="auto">Auto</SelectItem>
								{RESPONSE_STYLES.map((style) => (
									<SelectItem key={style.id} value={style.id}>
										{style.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-1.5">
						<p className="text-sm font-medium">Verbosity</p>
						<Select
							value={verbosity ?? "auto"}
							onValueChange={(v) =>
								setVerbosity(v === "auto" ? undefined : v)
							}
						>
							<SelectTrigger>
								<SelectValue placeholder="Auto" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="auto">Auto</SelectItem>
								{VERBOSITY_LEVELS.map((level) => (
									<SelectItem key={level.id} value={level.id}>
										{level.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-1.5">
						<p className="text-sm font-medium">Code Language</p>
						<Select
							value={codeLanguage ?? "auto"}
							onValueChange={(v) =>
								setCodeLanguage(v === "auto" ? undefined : v)
							}
						>
							<SelectTrigger>
								<SelectValue placeholder="Auto" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="auto">Auto</SelectItem>
								{CODE_LANGUAGES.map((lang) => (
									<SelectItem key={lang.id} value={lang.id}>
										{lang.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>

				{hasChanges && (
					<div className="mt-4 pt-4 border-t flex justify-end">
						<Button
							onClick={handleSave}
							disabled={updateMutation.isPending}
						>
							{updateMutation.isPending ? (
								<LoaderIcon className="size-4 mr-2 animate-spin" />
							) : (
								<SaveIcon className="size-4 mr-2" />
							)}
							Save Preferences
						</Button>
					</div>
				)}
			</Card>

			{/* Learned Patterns */}
			<Card className="p-6">
				<div className="flex items-center justify-between mb-4">
					<div className="flex items-center gap-3">
						<BrainCircuitIcon className="size-5 text-primary" />
						<h3 className="font-semibold text-lg">
							Learned Patterns
						</h3>
						<Badge variant="outline">
							{learnedPatterns.length} patterns
						</Badge>
					</div>

					{learnedPatterns.length > 0 && (
						<AlertDialog>
							<AlertDialogTrigger asChild>
								<Button variant="ghost" size="sm">
									<Trash2Icon className="size-4 mr-2" />
									Clear All
								</Button>
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										Clear Learned Patterns?
									</AlertDialogTitle>
									<AlertDialogDescription>
										This will remove all patterns that
										Fabric AI has learned from your
										conversations. The AI will start
										learning fresh.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>
										Cancel
									</AlertDialogCancel>
									<AlertDialogAction
										onClick={() =>
											clearPatternsMutation.mutate()
										}
									>
										Clear Patterns
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					)}
				</div>

				<p className="text-sm text-muted-foreground mb-4">
					Fabric AI learns your preferences over time based on your
					feedback and interactions. These patterns help personalize
					responses.
				</p>

				{learnedPatterns.length > 0 ? (
					<div className="space-y-2">
						{learnedPatterns.map((pattern, index) => (
							<div
								key={index}
								className="flex items-center gap-2 text-sm bg-muted/50 rounded-md px-3 py-2 group"
							>
								<SparklesIcon className="size-4 text-highlight shrink-0" />
								<span className="flex-1">{pattern}</span>
								<Button
									variant="ghost"
									size="sm"
									className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
									onClick={() =>
										deletePatternMutation.mutate(pattern)
									}
									disabled={deletePatternMutation.isPending}
								>
									<Trash2Icon className="size-3" />
								</Button>
							</div>
						))}
					</div>
				) : (
					<div className="text-center py-8 text-muted-foreground">
						<BrainCircuitIcon className="size-8 mx-auto mb-2 opacity-50" />
						<p>No patterns learned yet</p>
						<p className="text-xs mt-1">
							Use Fabric AI and it will learn your preferences
						</p>
					</div>
				)}
			</Card>

			{/* Recent Conversations (Episodic Memory) */}
			<Card className="p-6">
				<div className="flex items-center gap-3 mb-4">
					<HistoryIcon className="size-5 text-primary" />
					<h3 className="font-semibold text-lg">
						Conversation Memory
					</h3>
					<Badge variant="outline">
						{episodesData?.total ?? 0} episodes
					</Badge>
				</div>

				<p className="text-sm text-muted-foreground mb-4">
					Fabric AI remembers past conversations to provide more
					relevant and context-aware assistance. Click on any
					conversation to see full details.
				</p>

				{/* Search Bar */}
				<div className="flex gap-2 mb-4">
					<div className="relative flex-1">
						<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
						<SearchInput
							placeholder="Search conversations (min 3 characters)..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) =>
								e.key === "Enter" && handleSearch()
							}
							className="pl-9"
						/>
					</div>
					<Button
						variant="secondary"
						onClick={handleSearch}
						disabled={
							searchQuery.trim().length < 3 || searchLoading
						}
					>
						{searchLoading ? (
							<LoaderIcon className="size-4 animate-spin" />
						) : (
							"Search"
						)}
					</Button>
				</div>

				{/* Search Results */}
				{searchResults?.episodes &&
					searchResults.episodes.length > 0 && (
						<div className="mb-4 p-3 bg-primary/5 rounded-lg border border-primary/20">
							<div className="flex items-center justify-between mb-2">
								<span className="text-sm font-medium">
									Search Results (
									{searchResults.episodes.length})
								</span>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										setSearchQuery("");
										queryClient.removeQueries({
											queryKey: [
												"orchestrator-memory-search",
											],
										});
									}}
								>
									Clear
								</Button>
							</div>
							<div className="space-y-2">
								{searchResults.episodes.map((episode) => (
									<EpisodeCard
										key={episode.id}
										episode={episode}
										isExpanded={expandedEpisodes.has(
											episode.id,
										)}
										onToggle={() =>
											toggleEpisode(episode.id)
										}
										onDelete={() =>
											deleteEpisodeMutation.mutate(
												episode.id,
											)
										}
										isDeleting={
											deleteEpisodeMutation.isPending
										}
										formatRelativeTime={formatRelativeTime}
									/>
								))}
							</div>
						</div>
					)}

				{/* Episode List */}
				{episodesLoading ? (
					<div className="space-y-2">
						<Skeleton className="h-20 w-full" />
						<Skeleton className="h-20 w-full" />
						<Skeleton className="h-20 w-full" />
					</div>
				) : episodesData?.episodes &&
					episodesData.episodes.length > 0 ? (
					<>
						<div className="space-y-2">
							{episodesData.episodes.map((episode) => (
								<EpisodeCard
									key={episode.id}
									episode={episode}
									isExpanded={expandedEpisodes.has(
										episode.id,
									)}
									onToggle={() => toggleEpisode(episode.id)}
									onDelete={() =>
										deleteEpisodeMutation.mutate(episode.id)
									}
									isDeleting={deleteEpisodeMutation.isPending}
									formatRelativeTime={formatRelativeTime}
								/>
							))}
						</div>

						{/* Pagination */}
						<div className="flex items-center justify-between mt-4 pt-4 border-t">
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									setEpisodeOffset(
										Math.max(
											0,
											episodeOffset - EPISODES_PER_PAGE,
										),
									)
								}
								disabled={episodeOffset === 0}
							>
								Previous
							</Button>
							<span className="text-sm text-muted-foreground">
								Showing {episodeOffset + 1} -{" "}
								{Math.min(
									episodeOffset + EPISODES_PER_PAGE,
									episodesData.total,
								)}{" "}
								of {episodesData.total}
							</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									setEpisodeOffset(
										episodeOffset + EPISODES_PER_PAGE,
									)
								}
								disabled={
									episodeOffset + EPISODES_PER_PAGE >=
									episodesData.total
								}
							>
								Next
							</Button>
						</div>
					</>
				) : (
					<div className="text-center py-8 text-muted-foreground">
						<HistoryIcon className="size-8 mx-auto mb-2 opacity-50" />
						<p>No conversation history yet</p>
						<p className="text-xs mt-1">
							Start using Fabric AI to build conversation memory
						</p>
					</div>
				)}
			</Card>
		</div>
	);
}

// Episode Card Component with expandable details
function EpisodeCard({
	episode,
	isExpanded,
	onToggle,
	onDelete,
	isDeleting,
	formatRelativeTime,
}: {
	episode: {
		id: string;
		title: string;
		summary: string;
		keyTopics: string[];
		userIntents: string[];
		outcome: string;
		toolsUsed: string[];
		agentsUsed: string[];
		messageCount: number;
		turnCount: number;
		conversationStartedAt: Date | string;
		conversationEndedAt: Date | string | null;
	};
	isExpanded: boolean;
	onToggle: () => void;
	onDelete: () => void;
	isDeleting: boolean;
	formatRelativeTime: (date: Date | string) => string;
}) {
	return (
		<Collapsible open={isExpanded} onOpenChange={onToggle}>
			<div
				className={cn(
					"bg-muted/50 rounded-md border transition-colors",
					isExpanded && "border-primary/30 bg-muted/70",
				)}
			>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="w-full px-3 py-2 flex items-start gap-3 text-left hover:bg-muted/80 rounded-md transition-colors"
					>
						{isExpanded ? (
							<ChevronDownIcon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
						) : (
							<ChevronRightIcon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
						)}
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2">
								<p className="text-sm font-medium truncate flex-1">
									{episode.title}
								</p>
								<span className="text-xs text-muted-foreground shrink-0">
									{formatRelativeTime(
										episode.conversationStartedAt,
									)}
								</span>
							</div>
							{!isExpanded && (
								<p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
									{episode.summary}
								</p>
							)}
							<div className="flex items-center gap-2 mt-1 flex-wrap">
								{episode.keyTopics
									.slice(0, isExpanded ? undefined : 3)
									.map((topic) => (
										<Badge
											key={topic}
											variant="secondary"
											className="text-xs"
										>
											{topic}
										</Badge>
									))}
								{!isExpanded &&
									episode.keyTopics.length > 3 && (
										<span className="text-xs text-muted-foreground">
											+{episode.keyTopics.length - 3} more
										</span>
									)}
							</div>
						</div>
						<Badge
							variant={
								episode.outcome === "success"
									? "default"
									: episode.outcome === "failure"
										? "destructive"
										: "secondary"
							}
							className="shrink-0"
						>
							{episode.outcome}
						</Badge>
					</button>
				</CollapsibleTrigger>

				<CollapsibleContent>
					<div className="px-3 pb-3 pt-1 border-t border-border/50 mt-1 space-y-3">
						{/* Full Summary */}
						<div>
							<h4 className="text-xs font-medium text-muted-foreground mb-1">
								Summary
							</h4>
							<p className="text-sm">{episode.summary}</p>
						</div>

						{/* User Intents */}
						{episode.userIntents.length > 0 && (
							<div>
								<h4 className="text-xs font-medium text-muted-foreground mb-1">
									User Intents
								</h4>
								<div className="flex flex-wrap gap-1">
									{episode.userIntents.map((intent) => (
										<Badge
											key={intent}
											variant="outline"
											className="text-xs"
										>
											{intent}
										</Badge>
									))}
								</div>
							</div>
						)}

						{/* Tools & Agents Used */}
						<div className="flex gap-4">
							{episode.toolsUsed.length > 0 && (
								<div className="flex-1">
									<h4 className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
										<WrenchIcon className="size-3" />
										Tools Used
									</h4>
									<div className="flex flex-wrap gap-1">
										{episode.toolsUsed.map((tool) => (
											<Badge
												key={tool}
												variant="outline"
												className="text-xs font-mono"
											>
												{tool}
											</Badge>
										))}
									</div>
								</div>
							)}
							{episode.agentsUsed.length > 0 && (
								<div className="flex-1">
									<h4 className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
										<UsersIcon className="size-3" />
										Agents Used
									</h4>
									<div className="flex flex-wrap gap-1">
										{episode.agentsUsed.map((agent) => (
											<Badge
												key={agent}
												variant="outline"
												className="text-xs"
											>
												{agent}
											</Badge>
										))}
									</div>
								</div>
							)}
						</div>

						{/* Stats & Delete */}
						<div className="flex items-center justify-between pt-2 border-t border-border/50">
							<div className="flex items-center gap-4 text-xs text-muted-foreground">
								<span>{episode.messageCount} messages</span>
								<span>{episode.turnCount} turns</span>
								{episode.conversationEndedAt && (
									<span>
										Ended:{" "}
										{new Date(
											episode.conversationEndedAt,
										).toLocaleString()}
									</span>
								)}
							</div>
							<Button
								variant="ghost"
								size="sm"
								className="text-muted-foreground hover:text-destructive h-7"
								onClick={(e) => {
									e.stopPropagation();
									onDelete();
								}}
								disabled={isDeleting}
							>
								{isDeleting ? (
									<LoaderIcon className="size-3 animate-spin mr-1" />
								) : (
									<Trash2Icon className="size-3 mr-1" />
								)}
								Remove
							</Button>
						</div>
					</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}
