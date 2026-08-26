"use client";

/**
 * SkillAutocomplete - Dropdown for /slash-command skill search results
 *
 * Shows matching skills with name, slug (as /<slug>), and description.
 * Supports keyboard navigation and click selection.
 */

import { cn } from "@ui/lib";
import { Loader2, PuzzleIcon } from "lucide-react";
import type { SlashCommandSkill } from "../../../hooks/useSkillSlashCommand";

export interface SkillAutocompleteProps {
	/** Search results to display */
	results: SlashCommandSkill[];
	/** Whether search is loading */
	isLoading: boolean;
	/** Currently selected index */
	selectedIndex: number;
	/** Callback when skill is selected */
	onSelect: (skill: SlashCommandSkill) => void;
	/** Callback when hovering over an item */
	onHover: (index: number) => void;
	/** Current query text */
	query?: string;
	/** Additional class name */
	className?: string;
}

export function SkillAutocomplete({
	results,
	isLoading,
	selectedIndex,
	onSelect,
	onHover,
	query = "",
	className,
}: SkillAutocompleteProps) {
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
					<span className="text-sm">Loading skills...</span>
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
					No skills found
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
			<div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b bg-muted/50">
				Skills{query ? ` — type /${query}` : ""}
			</div>
			<div className="max-h-64 overflow-y-auto">
				{results.map((skill, index) => (
					<button
						key={skill.id}
						type="button"
						className={cn(
							"w-full px-3 py-2.5 text-left flex items-start gap-3 hover:bg-muted/50 transition-colors border-b last:border-b-0",
							index === selectedIndex && "bg-muted",
						)}
						onClick={() => onSelect(skill)}
						onMouseEnter={() => onHover(index)}
					>
						<PuzzleIcon className="mt-0.5 size-4 text-primary shrink-0" />
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2 mb-0.5">
								<span className="font-medium text-sm truncate">
									{skill.name}
								</span>
								<span className="text-xs text-muted-foreground font-mono shrink-0">
									/{skill.slug}
								</span>
							</div>
							<p className="text-xs text-muted-foreground line-clamp-2">
								{skill.description}
							</p>
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
