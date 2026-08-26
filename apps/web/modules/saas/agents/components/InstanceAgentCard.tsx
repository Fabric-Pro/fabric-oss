"use client";

import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
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
	ArrowRightIcon,
	CopyIcon,
	EditIcon,
	MoreVerticalIcon,
	PlayIcon,
	TrashIcon,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface InstanceAgentCardProps {
	instance: {
		id: string;
		name: string;
		description?: string | null;
		status: string;
		runCount?: number | null;
		lastRunAt?: Date | string | null;
		template?: {
			displayName?: string | null;
			category?: string | null;
		} | null;
	};
	basePath: string;
	onDelete: (id: string) => void;
}

const statusConfig: Record<
	string,
	{ label: string; className: string; dot: string }
> = {
	ACTIVE: {
		label: "Active",
		className: "bg-success/10 text-success",
		dot: "bg-success",
	},
	DRAFT: {
		label: "Draft",
		className: "bg-muted text-muted-foreground",
		dot: "bg-muted-foreground/50",
	},
	ARCHIVED: {
		label: "Archived",
		className: "bg-highlight/10 text-highlight",
		dot: "bg-highlight",
	},
};

export function InstanceAgentCard({
	instance,
	basePath,
	onDelete,
}: InstanceAgentCardProps) {
	const router = useRouter();
	const statusInfo = statusConfig[instance.status] ?? statusConfig.DRAFT;
	const editHref = `${basePath}/agents/${instance.id}/edit`;
	const chatbotHref = `${basePath}/nexus?agent=${encodeURIComponent(
		JSON.stringify({
			agentId: `template-instance:${instance.id}`,
			name: instance.name,
			description: instance.description ?? "",
		}),
	)}`;

	return (
		<div
			role="button"
			tabIndex={0}
			aria-label={`Try ${instance.name}`}
			className="group relative flex flex-col rounded-xl border bg-card text-left transition-colors hover:border-primary/30 hover:bg-muted/20 cursor-pointer"
			onClick={() => router.push(chatbotHref)}
			onKeyDown={(e) => {
				if (
					(e.key === "Enter" || e.key === " ") &&
					e.target === e.currentTarget
				) {
					e.preventDefault();
					router.push(chatbotHref);
				}
			}}
		>
			{/* Status badge + dropdown — top-right */}
			<div className="absolute top-3 right-3 z-10 flex items-center gap-1">
				<span
					className={cn(
						"text-[10px] px-1.5 py-0.5 rounded font-medium leading-tight flex items-center gap-1",
						statusInfo.className,
					)}
				>
					<span
						className={cn(
							"h-1.5 w-1.5 rounded-full",
							statusInfo.dot,
						)}
					/>
					{statusInfo.label}
				</span>

				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
							onClick={(e) => e.stopPropagation()}
						>
							<MoreVerticalIcon className="h-3.5 w-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem asChild>
							<Link
								href={editHref}
								onClick={(e) => e.stopPropagation()}
							>
								<EditIcon className="mr-2 h-4 w-4" />
								Edit
							</Link>
						</DropdownMenuItem>
						<DropdownMenuItem asChild>
							<Link
								href={chatbotHref}
								onClick={(e) => e.stopPropagation()}
							>
								<PlayIcon className="mr-2 h-4 w-4" />
								Try Agent
							</Link>
						</DropdownMenuItem>
						<DropdownMenuItem asChild>
							<Link
								href={`${editHref.replace("/edit", "/duplicate")}`}
								onClick={(e) => e.stopPropagation()}
							>
								<CopyIcon className="mr-2 h-4 w-4" />
								Duplicate
							</Link>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={(e) => {
								e.stopPropagation();
								onDelete(instance.id);
							}}
							className="text-destructive"
						>
							<TrashIcon className="mr-2 h-4 w-4" />
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Header */}
			<div className="flex gap-3 p-4 pb-3">
				<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
					<RobotIcon className="h-4.5 w-4.5 text-primary" />
				</div>

				<div className="min-w-0 flex-1 pr-16">
					<h3 className="font-semibold text-sm leading-snug line-clamp-2 group-hover:text-primary transition-colors">
						{instance.name}
					</h3>
					<p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
						{instance.description || "No description provided"}
					</p>
				</div>
			</div>

			{/* Footer */}
			<div className="mt-auto flex items-center justify-between border-t px-4 py-2.5">
				<div className="flex items-center gap-3 text-[11px] text-muted-foreground">
					<span className="flex items-center gap-1">
						<ZapIcon className="h-3 w-3" />
						{instance.runCount || 0}{" "}
						{(instance.runCount || 0) === 1 ? "run" : "runs"}
					</span>
					{instance.lastRunAt && (
						<span>
							{formatDistanceToNow(new Date(instance.lastRunAt), {
								addSuffix: true,
							})}
						</span>
					)}
				</div>
				<ArrowRightIcon className="h-3.5 w-3.5 text-primary opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-[opacity,transform] duration-150" />
			</div>
		</div>
	);
}
