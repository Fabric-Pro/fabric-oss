/**
 * SearchResultsDisplay
 *
 * Beautiful display component for web search results.
 * Inspired by Scira's design with source cards, favicons, images, and metadata badges.
 */

"use client";

import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@ui/components/accordion";
import { Badge } from "@ui/components/badge";
import { Card, CardContent } from "@ui/components/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { cn } from "@ui/lib";
import {
	ArrowUpRight,
	ChevronDown,
	Clock,
	ExternalLink,
	FileText,
	Globe,
	Layers,
	Search,
	User2,
	Zap,
} from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";
import { Response } from "./response";

// Types matching our web search tool output
interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	content?: string;
	publishedDate?: string;
	author?: string;
	images?: string[];
	favicon?: string;
}

interface WebSearchOutput {
	success: boolean;
	error?: string;
	provider?: string;
	searchTime?: number;
	totalResults?: number;
	results: SearchResult[];
}

// Helper to get favicon URL
const getFaviconUrl = (url: string, favicon?: string) => {
	if (favicon) {
		return favicon;
	}
	try {
		const domain = new URL(url).hostname;
		return `https://www.google.com/s2/favicons?sz=128&domain=${domain}`;
	} catch {
		return null;
	}
};

// Helper to extract hostname
const getHostname = (url: string) => {
	try {
		return new URL(url).hostname.replace("www.", "");
	} catch {
		return url;
	}
};

// Helper to format date
const formatDate = (dateStr?: string) => {
	if (!dateStr) {
		return null;
	}
	try {
		return new Date(dateStr).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	} catch {
		return dateStr;
	}
};

// Enhanced Source Card Component with image support
interface SourceCardProps {
	result: SearchResult;
	index: number;
	showContent?: boolean;
}

function SourceCard({
	result,
	index: _index,
	showContent = false,
}: SourceCardProps) {
	const [imageLoaded, setImageLoaded] = useState(false);
	const [imageError, setImageError] = useState(false);
	const faviconUrl = getFaviconUrl(result.url, result.favicon);
	const hostname = useMemo(() => getHostname(result.url), [result.url]);
	const formattedDate = formatDate(result.publishedDate);
	const hasImage = result.images && result.images.length > 0 && !imageError;
	const hasContent = result.content && result.content.length > 100;

	return (
		<div className="border-b border-border last:border-0">
			<div className="flex">
				{/* Featured Image - Left side (like Scira's EnhancedSourceCard) */}
				{hasImage && (
					<div className="w-[20%] shrink-0 min-w-[100px] max-w-[150px]">
						<div className="h-full min-h-[100px] overflow-hidden relative bg-muted">
							<Image
								src={result.images?.[0] ?? ""}
								alt={result.title || "Featured image"}
								className={cn(
									"w-full h-full object-cover transition-opacity",
									!imageLoaded && "opacity-0",
								)}
								width={150}
								height={100}
								unoptimized
								onLoad={() => setImageLoaded(true)}
								onError={() => {
									setImageError(true);
									setImageLoaded(true);
								}}
							/>
						</div>
					</div>
				)}

				{/* Content */}
				<div className="flex-1 p-4 min-w-0">
					<div className="flex gap-3">
						{/* Favicon */}
						<div className="relative w-10 h-10 shrink-0 rounded-lg overflow-hidden bg-muted flex items-center justify-center">
							{faviconUrl ? (
								<Image
									src={faviconUrl}
									alt=""
									width={40}
									height={40}
									className="object-contain"
									unoptimized
									onError={(e) => {
										e.currentTarget.style.display = "none";
									}}
								/>
							) : (
								<Globe className="w-5 h-5 text-muted-foreground" />
							)}
						</div>

						<div className="flex-1 min-w-0">
							{/* Title with link */}
							<a
								href={result.url}
								target="_blank"
								rel="noopener noreferrer"
								className="group inline-flex items-center gap-1.5"
							>
								<h3 className="font-medium text-sm text-foreground line-clamp-2 leading-snug group-hover:text-primary transition-colors">
									{result.title || "Untitled"}
								</h3>
								<ArrowUpRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
							</a>

							{/* Metadata badges */}
							<div className="flex flex-wrap items-center gap-1.5 mt-2">
								<Badge
									variant="secondary"
									className="rounded-md bg-muted hover:bg-muted text-muted-foreground border-0 text-[10px] h-5 px-1.5"
								>
									<Globe className="h-2.5 w-2.5 mr-1" />
									{hostname}
								</Badge>
								{result.author && (
									<Badge
										variant="secondary"
										className="rounded-md bg-violet-50 hover:bg-violet-100 dark:bg-violet-900/20 dark:hover:bg-violet-900/30 text-violet-600 dark:text-violet-400 border-0 text-[10px] h-5 px-1.5"
									>
										<User2 className="h-2.5 w-2.5 mr-1" />
										{result.author}
									</Badge>
								)}
								{formattedDate && (
									<Badge
										variant="secondary"
										className="rounded-md bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:hover:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border-0 text-[10px] h-5 px-1.5"
									>
										<Clock className="h-2.5 w-2.5 mr-1" />
										{formattedDate}
									</Badge>
								)}
							</div>
						</div>
					</div>

					{/* Snippet/Description */}
					<p className="text-xs text-muted-foreground mt-2.5 line-clamp-2 leading-relaxed">
						{result.snippet || "No description available"}
					</p>

					{/* View source link */}
					<div className="mt-3">
						<a
							href={result.url}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium transition-colors"
						>
							<ArrowUpRight className="h-3 w-3" />
							View source
						</a>
					</div>
				</div>
			</div>

			{/* Full Content Accordion (like Scira) */}
			{hasContent && showContent && (
				<div className="border-t border-border">
					<Accordion type="single" collapsible>
						<AccordionItem value="content" className="border-0">
							<AccordionTrigger className="px-4 py-3 text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors">
								<div className="flex items-center gap-2">
									<FileText className="h-3.5 w-3.5" />
									<span>View full content</span>
								</div>
							</AccordionTrigger>
							<AccordionContent className="pb-0">
								<div className="max-h-[300px] overflow-y-auto p-4 bg-muted/30 border-t">
									<div className="prose prose-sm dark:prose-invert max-w-none">
										<Response>{result.content}</Response>
									</div>
								</div>
							</AccordionContent>
						</AccordionItem>
					</Accordion>
				</div>
			)}
		</div>
	);
}

// Compact inline sources display (for showing in chat)
interface CompactSourcesProps {
	results: SearchResult[];
	maxDisplay?: number;
}

function CompactSources({ results, maxDisplay = 4 }: CompactSourcesProps) {
	const displayResults = results.slice(0, maxDisplay);
	const remaining = results.length - maxDisplay;

	return (
		<div className="flex flex-wrap items-center gap-1.5 mt-2">
			{displayResults.map((result, index) => {
				const faviconUrl = getFaviconUrl(result.url, result.favicon);
				const hostname = getHostname(result.url);

				return (
					<a
						key={index}
						href={result.url}
						target="_blank"
						rel="noopener noreferrer"
						className={cn(
							"inline-flex items-center gap-1.5 px-2 py-1 rounded-md",
							"bg-muted/50 hover:bg-muted text-xs text-muted-foreground hover:text-foreground",
							"transition-colors",
						)}
					>
						{faviconUrl ? (
							<Image
								src={faviconUrl}
								alt=""
								width={12}
								height={12}
								className="rounded-sm"
								unoptimized
							/>
						) : (
							<Globe className="w-3 h-3" />
						)}
						<span className="truncate max-w-[100px]">
							{hostname}
						</span>
						<ExternalLink className="w-2.5 h-2.5 opacity-50" />
					</a>
				);
			})}
			{remaining > 0 && (
				<span className="text-xs text-muted-foreground">
					+{remaining} more
				</span>
			)}
		</div>
	);
}

// Main Search Results Display Component
interface SearchResultsDisplayProps {
	output: WebSearchOutput;
	className?: string;
	defaultExpanded?: boolean;
}

export function SearchResultsDisplay({
	output,
	className,
	defaultExpanded = true,
}: SearchResultsDisplayProps) {
	const [isExpanded, setIsExpanded] = useState(defaultExpanded);

	// Handle error state
	if (!output.success || output.error) {
		return (
			<div
				className={cn(
					"rounded-lg border border-destructive/30 bg-destructive/5 p-4",
					className,
				)}
			>
				<div className="flex items-center gap-3">
					<div className="h-8 w-8 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
						<Globe className="h-4 w-4 text-destructive" />
					</div>
					<div>
						<div className="text-sm font-medium text-destructive">
							Search failed
						</div>
						{output.error && (
							<div className="text-xs text-destructive/80 mt-0.5">
								{output.error}
							</div>
						)}
					</div>
				</div>
			</div>
		);
	}

	// Handle empty results
	if (!output.results || output.results.length === 0) {
		return (
			<div
				className={cn(
					"rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 p-4",
					className,
				)}
			>
				<div className="flex items-center gap-3">
					<div className="h-8 w-8 rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center shrink-0">
						<Globe className="h-4 w-4 text-amber-600 dark:text-amber-400" />
					</div>
					<div className="text-sm font-medium text-amber-700 dark:text-amber-300">
						No results found
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"rounded-lg border bg-card overflow-hidden shadow-sm",
				className,
			)}
		>
			<Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
				{/* Header */}
				<CollapsibleTrigger className="w-full px-4 py-3 flex items-center justify-between hover:bg-accent/30 transition-colors border-b border-border">
					<div className="flex items-center gap-2.5">
						<Layers className="h-4 w-4 text-muted-foreground" />
						<span className="text-sm font-medium">
							Retrieved from {output.results.length} sources
						</span>
						{output.provider && (
							<Badge
								variant="secondary"
								className="rounded-md border-0 text-[10px] h-5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400"
							>
								{output.provider}
							</Badge>
						)}
						{output.searchTime && (
							<Badge
								variant="secondary"
								className="rounded-md border-0 text-[10px] h-5"
							>
								<Zap className="h-2.5 w-2.5 mr-1" />
								{(output.searchTime / 1000).toFixed(1)}s
							</Badge>
						)}
					</div>
					<ChevronDown
						className={cn(
							"h-4 w-4 text-muted-foreground transition-transform duration-200",
							isExpanded && "rotate-180",
						)}
					/>
				</CollapsibleTrigger>

				{/* Results */}
				<CollapsibleContent>
					<div className="max-h-[600px] overflow-y-auto">
						{output.results.map((result, index) => (
							<SourceCard
								key={index}
								result={result}
								index={index}
								showContent={!!result.content}
							/>
						))}
					</div>
				</CollapsibleContent>
			</Collapsible>

			{/* Always show compact sources when collapsed */}
			{!isExpanded && (
				<div className="px-4 pb-3">
					<CompactSources results={output.results} />
				</div>
			)}
		</div>
	);
}

/**
 * Check if an output object is a web search result
 */
export function isWebSearchOutput(output: unknown): output is WebSearchOutput {
	if (typeof output !== "object" || output === null) {
		return false;
	}
	const o = output as Record<string, unknown>;
	return "success" in o && "results" in o && Array.isArray(o.results);
}

/**
 * Loading state component for search tools
 * Shows an animated loading state while search is in progress
 */
interface SearchLoadingStateProps {
	text?: string;
	className?: string;
}

export function SearchLoadingState({
	text = "Searching the web...",
	className,
}: SearchLoadingStateProps) {
	return (
		<Card className={cn("relative w-full overflow-hidden", className)}>
			{/* Animated border */}
			<div className="absolute inset-0 rounded-lg">
				<div className="absolute inset-0 rounded-lg bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-blue-500/20 animate-pulse" />
			</div>

			<CardContent className="relative p-4">
				<div className="flex items-center gap-3">
					{/* Animated icon container */}
					<div className="relative h-10 w-10 rounded-full flex items-center justify-center bg-blue-50 dark:bg-blue-950">
						<div
							className="absolute inset-0 rounded-full bg-gradient-to-r from-blue-400 to-purple-400 opacity-20 animate-spin"
							style={{ animationDuration: "3s" }}
						/>
						<Search className="h-5 w-5 text-blue-500 animate-pulse" />
					</div>

					<div className="space-y-2 flex-1">
						{/* Shimmer text effect */}
						<div className="relative overflow-hidden">
							<span className="text-sm font-medium bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent animate-shimmer">
								{text}
							</span>
						</div>

						{/* Animated dots */}
						<div className="flex gap-1.5">
							{[...Array(4)].map((_, i) => (
								<div
									key={i}
									className="h-1.5 rounded-full bg-muted-foreground/30 animate-pulse"
									style={{
										width: `${Math.random() * 40 + 20}px`,
										animationDelay: `${i * 0.15}s`,
									}}
								/>
							))}
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
