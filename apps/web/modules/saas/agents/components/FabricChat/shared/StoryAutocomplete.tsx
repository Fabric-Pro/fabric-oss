"use client";

/**
 * StoryAutocomplete - Dropdown for @story / @issue mention search results
 *
 * Shows matching stories with F-XXX identifier, title, and status badge.
 * Supports keyboard navigation.
 */

import { cn } from "@ui/lib";
import { BookOpen, Loader2 } from "lucide-react";
import type { MentionableStory } from "../../../hooks/useStoryMention";

export interface StoryAutocompleteProps {
	/** Search results to display */
	results: MentionableStory[];
	/** Whether search is loading */
	isLoading: boolean;
	/** Currently selected index */
	selectedIndex: number;
	/** Callback when story is selected */
	onSelect: (story: MentionableStory) => void;
	/** Callback when hovering over an item */
	onHover: (index: number) => void;
	/** Additional class name */
	className?: string;
}

export function StoryAutocomplete({
	results,
	isLoading,
	selectedIndex,
	onSelect,
	onHover,
	className,
}: StoryAutocompleteProps) {
	if (isLoading) {
		return (
			<div
				className={cn(
					"absolute bottom-full left-0 right-0 mb-2 bg-popover border rounded-lg shadow-lg z-50 p-4",
					className,
				)}
			>
				<div className="flex items-center justify-center gap-2 text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					<span className="text-sm">Searching stories...</span>
				</div>
			</div>
		);
	}

	if (results.length === 0) {
		return (
			<div
				className={cn(
					"absolute bottom-full left-0 right-0 mb-2 bg-popover border rounded-lg shadow-lg z-50 p-4",
					className,
				)}
			>
				<p className="text-sm text-muted-foreground text-center">
					No stories found
				</p>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"absolute bottom-full left-0 right-0 mb-2 bg-popover border rounded-lg shadow-lg z-50 overflow-hidden",
				className,
			)}
		>
			<div className="max-h-64 overflow-y-auto">
				{results.map((story, index) => (
					<button
						key={story.id}
						type="button"
						className={cn(
							"w-full px-3 py-2.5 text-left flex items-start gap-3 hover:bg-muted/50 transition-colors",
							index === selectedIndex && "bg-muted",
						)}
						onClick={() => onSelect(story)}
						onMouseEnter={() => onHover(index)}
					>
						{/* Story icon */}
						<span className="shrink-0 w-8 h-8 flex items-center justify-center rounded bg-muted">
							<BookOpen className="h-4 w-4 text-muted-foreground" />
						</span>

						{/* Content */}
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2 mb-0.5">
								<span className="font-mono text-xs text-muted-foreground shrink-0">
									{story.identifier}
								</span>
								<span className="font-medium text-sm truncate">
									{story.title}
								</span>
							</div>
							<span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground inline-block">
								{story.status}
							</span>
						</div>
					</button>
				))}
			</div>

			{/* Footer hint */}
			<div className="px-3 py-2 border-t bg-muted/30 text-[10px] text-muted-foreground flex items-center gap-3">
				<span>
					<kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">
						↑↓
					</kbd>{" "}
					navigate
				</span>
				<span>
					<kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">
						Enter
					</kbd>{" "}
					select
				</span>
				<span>
					<kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">
						Esc
					</kbd>{" "}
					close
				</span>
			</div>
		</div>
	);
}
