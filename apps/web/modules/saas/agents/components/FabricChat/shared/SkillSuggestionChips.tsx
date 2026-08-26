"use client";

/**
 * SkillSuggestionChips
 *
 * Renders a row of chip buttons above the chat input suggesting
 * relevant skills based on the user's last message.
 *
 * Features:
 * - Click to execute skill and inject content into input
 * - Dismiss individual chips or all at once
 * - Auto-dismiss after 10 seconds
 * - Max 3 chips
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { Lightbulb, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export interface SkillSuggestion {
	skillId: string;
	name: string;
	reason: string;
	confidence: number;
}

export interface SkillSuggestionChipsProps {
	suggestions: SkillSuggestion[];
	onSuggestionClick?: (skillContent: string) => void;
	organizationId?: string | null;
	/** Called when user starts typing (to auto-dismiss) */
	onTyping?: () => void;
	/** Whether to show the chips */
	visible?: boolean;
}

const AUTO_DISMISS_MS = 10_000;

export function SkillSuggestionChips({
	suggestions,
	onSuggestionClick,
	organizationId,
	onTyping,
	visible = true,
}: SkillSuggestionChipsProps) {
	const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
	const [executingId, setExecutingId] = useState<string | null>(null);
	const dismissTimerRef = useRef<NodeJS.Timeout | null>(null);
	const hasAutoDismissedRef = useRef(false);

	// Stable key so the reset effect only fires when the actual set of
	// skill IDs changes, not on every parent re-render that creates a new
	// suggestions array reference.
	const suggestionsKey = useMemo(
		() => suggestions.map((s) => s.skillId).join(","),
		[suggestions],
	);

	// Reset dismissed state when suggestions change
	useEffect(() => {
		setDismissedIds(new Set());
		hasAutoDismissedRef.current = false;
	}, [suggestionsKey]);

	// Auto-dismiss after 10 seconds
	useEffect(() => {
		if (suggestions.length === 0 || hasAutoDismissedRef.current) {
			return;
		}

		if (dismissTimerRef.current) {
			clearTimeout(dismissTimerRef.current);
		}

		dismissTimerRef.current = setTimeout(() => {
			hasAutoDismissedRef.current = true;
			setDismissedIds(new Set(suggestions.map((s) => s.skillId)));
		}, AUTO_DISMISS_MS);

		return () => {
			if (dismissTimerRef.current) {
				clearTimeout(dismissTimerRef.current);
			}
		};
	}, [suggestions]);

	const handleDismiss = useCallback((skillId: string) => {
		setDismissedIds((prev) => new Set([...prev, skillId]));
	}, []);

	const handleDismissAll = useCallback(() => {
		setDismissedIds(new Set(suggestions.map((s) => s.skillId)));
	}, [suggestions]);

	const handleExecute = useCallback(
		async (suggestion: SkillSuggestion) => {
			if (executingId) {
				return;
			}

			setExecutingId(suggestion.skillId);
			try {
				const result = await orpcClient.skills.execute({
					id: suggestion.skillId,
					organizationId: organizationId ?? null,
				});

				const skillPrompt = `Using the "${result.name}" skill:\n\n${result.description}\n\n${result.content}\n\n`;
				onSuggestionClick?.(skillPrompt);

				// Dismiss this chip after execution
				setDismissedIds(
					(prev) => new Set([...prev, suggestion.skillId]),
				);
			} catch (error) {
				toast.error("Failed to load skill", {
					description:
						error instanceof Error
							? error.message
							: "Unknown error",
				});
			} finally {
				setExecutingId(null);
			}
		},
		[executingId, organizationId, onSuggestionClick],
	);

	if (!visible || suggestions.length === 0) {
		return null;
	}

	const visibleSuggestions = suggestions
		.filter((s) => !dismissedIds.has(s.skillId))
		.slice(0, 3);

	if (visibleSuggestions.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
			<span className="text-xs text-muted-foreground flex items-center gap-1 shrink-0">
				<Lightbulb className="h-3 w-3" />
				Suggested skills:
			</span>
			{visibleSuggestions.map((suggestion) => (
				<Badge
					key={suggestion.skillId}
					variant="secondary"
					className={cn(
						"text-xs cursor-pointer rounded-full gap-1.5 pr-1 transition-all hover:bg-primary/10 hover:text-primary",
						executingId === suggestion.skillId && "opacity-60",
					)}
					onClick={() => handleExecute(suggestion)}
					title={suggestion.reason}
				>
					<Zap className="h-3 w-3" />
					<span className="max-w-[160px] truncate">
						{suggestion.name}
					</span>
					<span className="text-[10px] text-muted-foreground hidden sm:inline">
						Try this?
					</span>
					<Button
						variant="ghost"
						size="icon"
						className="h-4 w-4 ml-0.5 hover:bg-background rounded-full"
						onClick={(e) => {
							e.stopPropagation();
							handleDismiss(suggestion.skillId);
						}}
						title="Dismiss"
					>
						<X className="h-2.5 w-2.5" />
					</Button>
				</Badge>
			))}
			<Button
				variant="ghost"
				size="sm"
				className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
				onClick={handleDismissAll}
				title="Dismiss all"
			>
				Dismiss
			</Button>
		</div>
	);
}
