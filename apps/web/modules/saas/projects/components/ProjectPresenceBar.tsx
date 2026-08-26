"use client";

/**
 * ProjectPresenceBar Component
 *
 * Displays active users viewing/editing a project in real-time.
 * Shows avatar stack with tooltips for user details.
 */

import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	type ActivityEvent,
	type ContextChangeEvent,
	type DocumentChangeEvent,
	useProjectPresence,
} from "../hooks";

// The presence payload carries the raw tab id (e.g. "atlas", "overview"). Map
// the ids whose display name differs from a simple capitalization to their
// human label; everything else just gets its first letter capitalized so the
// tooltip reads "Viewing Atlas" / "Viewing Overview" rather than the raw id.
//
// "understanding" is the pre-#1735 id for the tab now called Atlas. A client
// still running the old bundle (not yet reloaded after the rename deploy) keeps
// broadcasting that legacy id, which would otherwise surface as the stale
// "Viewing Understanding". Alias it to "Atlas" so the tooltip stays correct
// through the transition window.
const TAB_DISPLAY_LABELS: Record<string, string> = {
	atlas: "Atlas",
	understanding: "Atlas",
};

function tabDisplayLabel(tabId: string): string {
	return (
		TAB_DISPLAY_LABELS[tabId] ??
		tabId.charAt(0).toUpperCase() + tabId.slice(1)
	);
}

interface ProjectPresenceBarProps {
	projectId: string;
	currentUserId: string;
	currentTab?: string;
	className?: string;
	onDocumentChange?: (event: DocumentChangeEvent) => void;
	onContextChange?: (event: ContextChangeEvent) => void;
	onActivity?: (event: ActivityEvent) => void;
}

export function ProjectPresenceBar({
	projectId,
	currentUserId,
	currentTab,
	className,
	onDocumentChange,
	onContextChange,
	onActivity,
}: ProjectPresenceBarProps) {
	const { activeUsers, isConnected } = useProjectPresence({
		projectId,
		activeTab: currentTab,
		onDocumentChange,
		onContextChange,
		onActivity,
	});

	// Filter out current user
	const otherUsers = activeUsers.filter((u) => u.userId !== currentUserId);

	// Don't render if no other users are viewing
	if (otherUsers.length === 0) {
		return (
			<div className={cn("flex items-center gap-2", className)}>
				{isConnected && (
					<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<span className="size-1.5 rounded-full bg-green-500 animate-pulse" />
						<span>Live</span>
					</div>
				)}
			</div>
		);
	}

	const maxVisible = 5;
	const visibleUsers = otherUsers.slice(0, maxVisible);
	const hiddenCount = otherUsers.length - maxVisible;

	return (
		<TooltipProvider>
			<div className={cn("flex items-center gap-2", className)}>
				<span className="text-xs text-muted-foreground">
					{otherUsers.length === 1
						? "1 person viewing"
						: `${otherUsers.length} people viewing`}
				</span>

				<div className="flex -space-x-2">
					{visibleUsers.map((user) => (
						<Tooltip key={user.userId}>
							<TooltipTrigger asChild>
								<Avatar
									className={cn(
										"size-7 border-2 border-background cursor-default",
										"ring-2 ring-green-500/50 ring-offset-1 ring-offset-background",
										"transition-transform hover:scale-110 hover:z-10",
									)}
								>
									<AvatarImage
										src={user.userImage}
										alt={user.userName}
									/>
									<AvatarFallback className="text-xs bg-gradient-to-br from-emerald-500 to-green-600 text-white">
										{user.userName
											.slice(0, 2)
											.toUpperCase()}
									</AvatarFallback>
								</Avatar>
							</TooltipTrigger>
							<TooltipContent
								side="bottom"
								className="text-center"
							>
								<p className="font-medium">{user.userName}</p>
								{user.activeTab && (
									<p className="text-xs text-muted-foreground">
										Viewing{" "}
										{tabDisplayLabel(user.activeTab)}
									</p>
								)}
								{user.editingDocId && (
									<p className="text-xs text-highlight">
										Currently editing
									</p>
								)}
							</TooltipContent>
						</Tooltip>
					))}

					{hiddenCount > 0 && (
						<Tooltip>
							<TooltipTrigger asChild>
								<div
									className={cn(
										"size-7 rounded-full bg-muted",
										"flex items-center justify-center text-xs font-medium",
										"border-2 border-background cursor-default",
									)}
								>
									+{hiddenCount}
								</div>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								<p className="text-xs">
									{hiddenCount} more{" "}
									{hiddenCount === 1 ? "person" : "people"}
								</p>
							</TooltipContent>
						</Tooltip>
					)}
				</div>

				{isConnected && (
					<span className="size-2 rounded-full bg-green-500 animate-pulse" />
				)}
			</div>
		</TooltipProvider>
	);
}
