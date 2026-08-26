/**
 * CollaborationStatus Component
 *
 * Shows the real-time collaboration status including connection state,
 * sync status, and active collaborators with their avatars.
 */

"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { RefreshCw, Users, Wifi, WifiOff } from "lucide-react";

interface CollaboratorInfo {
	name: string;
	color: string;
	image?: string;
}

interface CollaborationStatusProps {
	isConnected: boolean;
	isSynced: boolean;
	collaborators: CollaboratorInfo[];
}

export function CollaborationStatus({
	isConnected,
	isSynced,
	collaborators,
}: CollaborationStatusProps) {
	return (
		<TooltipProvider>
			<div className="flex items-center gap-2">
				{/* Connection status */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Badge
							variant={isConnected ? "default" : "secondary"}
							className="h-4 gap-1 px-1.5 py-0 text-[10px] cursor-default"
						>
							{isConnected ? (
								isSynced ? (
									<Wifi className="h-3 w-3" />
								) : (
									<RefreshCw className="h-3 w-3 animate-spin" />
								)
							) : (
								<WifiOff className="h-3 w-3" />
							)}
							<span className="hidden sm:inline">
								{isSynced
									? "Synced"
									: isConnected
										? "Syncing..."
										: "Offline"}
							</span>
						</Badge>
					</TooltipTrigger>
					<TooltipContent>
						<p>
							{isConnected
								? isSynced
									? "Connected and synced with collaboration server"
									: "Syncing changes with collaboration server..."
								: "Working offline - changes will sync when reconnected"}
						</p>
					</TooltipContent>
				</Tooltip>

				{/* Collaborators */}
				{collaborators.length > 0 && (
					<div className="flex items-center gap-1">
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="flex items-center gap-1 cursor-default">
									<Users className="h-4 w-4 text-muted-foreground" />
									<span className="text-xs text-muted-foreground hidden sm:inline">
										{collaborators.length}
									</span>
								</div>
							</TooltipTrigger>
							<TooltipContent>
								<p>
									{collaborators.length === 1
										? "1 other person is editing"
										: `${collaborators.length} others are editing`}
								</p>
							</TooltipContent>
						</Tooltip>
						<div className="flex -space-x-2">
							{collaborators.slice(0, 3).map((collab, i) => (
								<Tooltip key={i}>
									<TooltipTrigger asChild>
										<Avatar
											className="h-6 w-6 border-2 border-background cursor-default"
											style={{
												borderColor: collab.color,
											}}
										>
											<AvatarImage
												src={collab.image}
												alt={collab.name}
											/>
											<AvatarFallback
												className="text-xs text-white"
												style={{
													backgroundColor:
														collab.color,
												}}
											>
												{collab.name
													.slice(0, 2)
													.toUpperCase()}
											</AvatarFallback>
										</Avatar>
									</TooltipTrigger>
									<TooltipContent>
										<p>{collab.name}</p>
										<p className="text-xs text-muted-foreground">
											Currently editing
										</p>
									</TooltipContent>
								</Tooltip>
							))}
							{collaborators.length > 3 && (
								<Tooltip>
									<TooltipTrigger asChild>
										<div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs border-2 border-background cursor-default">
											+{collaborators.length - 3}
										</div>
									</TooltipTrigger>
									<TooltipContent>
										<p>
											{collaborators
												.slice(3)
												.map((c) => c.name)
												.join(", ")}
										</p>
									</TooltipContent>
								</Tooltip>
							)}
						</div>
					</div>
				)}
			</div>
		</TooltipProvider>
	);
}
