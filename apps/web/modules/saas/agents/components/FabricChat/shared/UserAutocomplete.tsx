"use client";

/**
 * UserAutocomplete - Dropdown for @user mention search results
 *
 * Shows matching users with avatar, name, and email.
 * Supports keyboard navigation.
 */

import { cn } from "@ui/lib";
import { Loader2, User } from "lucide-react";
import type { MentionableUser } from "../../../hooks/useUserMention";

export interface UserAutocompleteProps {
	/** Search results to display */
	results: MentionableUser[];
	/** Whether search is loading */
	isLoading: boolean;
	/** Currently selected index */
	selectedIndex: number;
	/** Callback when user is selected */
	onSelect: (user: MentionableUser) => void;
	/** Callback when hovering over an item */
	onHover: (index: number) => void;
	/** Additional class name */
	className?: string;
}

export function UserAutocomplete({
	results,
	isLoading,
	selectedIndex,
	onSelect,
	onHover,
	className,
}: UserAutocompleteProps) {
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
					<span className="text-sm">Searching members...</span>
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
					No members found
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
				{results.map((user, index) => (
					<button
						key={user.id}
						type="button"
						className={cn(
							"w-full px-3 py-2.5 text-left flex items-start gap-3 hover:bg-muted/50 transition-colors",
							index === selectedIndex && "bg-muted",
						)}
						onClick={() => onSelect(user)}
						onMouseEnter={() => onHover(index)}
					>
						{/* Avatar */}
						<span className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-muted overflow-hidden">
							{user.avatarUrl ? (
								<img
									src={user.avatarUrl}
									alt={user.name || ""}
									className="w-full h-full object-cover"
								/>
							) : (
								<User className="h-4 w-4 text-muted-foreground" />
							)}
						</span>

						{/* Content */}
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2 mb-0.5">
								<span className="font-medium text-sm truncate">
									{user.name || "Unknown"}
								</span>
								<span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-muted text-muted-foreground capitalize">
									{user.role.toLowerCase()}
								</span>
							</div>
							<p className="text-xs text-muted-foreground truncate">
								{user.email || ""}
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
