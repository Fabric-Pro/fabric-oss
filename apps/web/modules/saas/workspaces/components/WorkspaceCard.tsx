"use client";

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ArchiveIcon,
	ArrowRightIcon,
	FileTextIcon,
	FolderOpenIcon,
	MessageSquareIcon,
	MoreHorizontalIcon,
	TrashIcon,
} from "lucide-react";
import Link from "next/link";

interface WorkspaceCardProps {
	workspace: {
		id: string;
		name: string;
		description: string | null;
		type: "PERSONAL" | "CUSTOM";
		status: "ACTIVE" | "ARCHIVED";
		documentLimit: number;
		documentCount: number;
		conversationCount: number;
		isOwner: boolean;
		createdAt: string;
		updatedAt: string;
	};
	basePath: string;
	onArchive?: () => void;
	onDelete?: () => void;
}

export function WorkspaceCard({
	workspace,
	basePath,
	onArchive,
	onDelete,
}: WorkspaceCardProps) {
	const isArchived = workspace.status === "ARCHIVED";
	const isPersonal = workspace.type === "PERSONAL";
	const workspaceUrl = `${basePath}/workspaces/${workspace.id}`;
	const docUsagePct =
		workspace.documentLimit > 0
			? Math.min(
					100,
					Math.round(
						(workspace.documentCount / workspace.documentLimit) *
							100,
					),
				)
			: 0;

	return (
		<div
			data-onboarding-target="workspaces-card"
			className={cn(
				"group relative flex flex-col rounded-xl border bg-card transition-all hover:border-primary/30 hover:shadow-md",
				isArchived && "opacity-60",
			)}
		>
			{/* Header */}
			<div className="flex gap-3 p-4 pb-3">
				{/* Icon */}
				<Link
					href={workspaceUrl}
					className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 dark:bg-teal-900/20"
				>
					<FolderOpenIcon className="h-4.5 w-4.5 text-teal-600 dark:text-teal-400" />
				</Link>

				{/* Content */}
				<div className="flex-1 min-w-0">
					<div className="flex items-start justify-between gap-2">
						<Link href={workspaceUrl} className="flex-1 min-w-0">
							<h3 className="font-semibold text-sm leading-snug line-clamp-2 group-hover:text-primary transition-colors">
								{workspace.name}
							</h3>
						</Link>

						<div className="flex items-center gap-1 shrink-0">
							{isPersonal && (
								<span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
									Personal
								</span>
							)}
							{isArchived && (
								<span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
									Archived
								</span>
							)}
							{workspace.isOwner && !isPersonal && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="icon-sm"
											className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
											onClick={(e) => e.stopPropagation()}
										>
											<MoreHorizontalIcon className="h-3.5 w-3.5" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem onClick={onArchive}>
											<ArchiveIcon className="h-4 w-4 mr-2" />
											{isArchived
												? "Reactivate"
												: "Archive"}
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={onDelete}
											className="text-destructive"
										>
											<TrashIcon className="h-4 w-4 mr-2" />
											Delete
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</div>
					</div>

					<p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
						{workspace.description || "No description"}
					</p>
				</div>
			</div>

			{/* Usage bar */}
			<div className="px-4 pb-3">
				<div className="flex items-center justify-between mb-1">
					<span className="text-[11px] text-muted-foreground flex items-center gap-1">
						<FileTextIcon className="h-3 w-3" />
						{workspace.documentCount}/{workspace.documentLimit} docs
					</span>
					<span className="text-[11px] text-muted-foreground">
						{docUsagePct}%
					</span>
				</div>
				<div className="h-1 rounded-full bg-muted overflow-hidden">
					<div
						className={cn(
							"h-full rounded-full transition-all",
							docUsagePct >= 90
								? "bg-red-500"
								: docUsagePct >= 70
									? "bg-amber-500"
									: "bg-teal-500",
						)}
						style={{ width: `${docUsagePct}%` }}
					/>
				</div>
			</div>

			{/* Footer */}
			<div className="mt-auto flex items-center justify-between border-t px-4 py-2.5">
				<div className="flex items-center gap-3 text-[11px] text-muted-foreground">
					<span className="flex items-center gap-1">
						<MessageSquareIcon className="h-3 w-3" />
						{workspace.conversationCount} chats
					</span>
					<span>
						{formatDistanceToNow(new Date(workspace.updatedAt), {
							addSuffix: true,
						})}
					</span>
				</div>
				<ArrowRightIcon className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
			</div>
		</div>
	);
}
