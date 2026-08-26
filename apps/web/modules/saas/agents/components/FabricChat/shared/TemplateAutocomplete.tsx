"use client";

/**
 * TemplateAutocomplete - Dropdown for @template mention search results
 *
 * Shows matching templates with emoji, name, category badge, and description preview.
 * Supports keyboard navigation.
 */

import { cn } from "@ui/lib";
import { Loader2 } from "lucide-react";
import type { MentionableTemplate } from "../../../hooks/useTemplateMention";

export interface TemplateAutocompleteProps {
	/** Search results to display */
	results: MentionableTemplate[];
	/** Whether search is loading */
	isLoading: boolean;
	/** Currently selected index */
	selectedIndex: number;
	/** Callback when template is selected */
	onSelect: (template: MentionableTemplate) => void;
	/** Callback when hovering over an item */
	onHover: (index: number) => void;
	/** Additional class name */
	className?: string;
}

/** Format category for display */
function formatCategory(category: string): string {
	return category
		.replace(/_/g, " ")
		.toLowerCase()
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Get category color */
function getCategoryColor(category: string): string {
	const colors: Record<string, string> = {
		ENGINEERING:
			"bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
		PRODUCT:
			"bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
		PRODUCT_MANAGEMENT:
			"bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
		MARKETING:
			"bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300",
		SALES: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
		SUPPORT:
			"bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
		DATA: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
		DESIGN: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
		FINANCE:
			"bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
		LEGAL: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
		OPERATIONS:
			"bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300",
		PRODUCTIVITY:
			"bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
		KNOWLEDGE:
			"bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
		HIRING: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
		GENERAL:
			"bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300",
	};
	return colors[category] || colors.GENERAL;
}

export function TemplateAutocomplete({
	results,
	isLoading,
	selectedIndex,
	onSelect,
	onHover,
	className,
}: TemplateAutocompleteProps) {
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
					<span className="text-sm">Searching templates...</span>
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
					No templates found
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
				{results.map((template, index) => (
					<button
						key={template.id}
						type="button"
						className={cn(
							"w-full px-3 py-2.5 text-left flex items-start gap-3 hover:bg-muted/50 transition-colors",
							index === selectedIndex && "bg-muted",
						)}
						onClick={() => onSelect(template)}
						onMouseEnter={() => onHover(index)}
					>
						{/* Emoji */}
						<span className="text-xl shrink-0 w-8 text-center">
							{template.heroEmojis?.[0] || "🤖"}
						</span>

						{/* Content */}
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2 mb-0.5">
								<span className="font-medium text-sm truncate">
									{template.displayName}
								</span>
								<span
									className={cn(
										"text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0",
										getCategoryColor(template.category),
									)}
								>
									{formatCategory(template.category)}
								</span>
							</div>
							<p className="text-xs text-muted-foreground line-clamp-1">
								{template.description}
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
