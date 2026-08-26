"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
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
	MoreHorizontalIcon,
	PauseIcon,
	PlayIcon,
	TrashIcon,
	ZapIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

interface WorkflowCardProps {
	workflow: {
		id: string;
		name: string;
		description: string | null;
		status: "DRAFT" | "PUBLISHED" | "ACTIVE" | "PAUSED" | "ARCHIVED";
		triggerType: string;
		version: number;
		heroEmojis?: string[];
		heroImageUrl?: string | null;
		updatedAt: Date;
		_count: {
			executions: number;
			versions: number;
		};
	};
	variant?: "grid" | "list";
	onRefresh?: () => void;
}

const statusConfig: Record<
	string,
	{ label: string; className: string; dot: string }
> = {
	DRAFT: {
		label: "Draft",
		className: "bg-muted text-muted-foreground",
		dot: "bg-muted-foreground/50",
	},
	PUBLISHED: {
		label: "Published",
		className: "bg-primary/10 text-primary",
		dot: "bg-primary",
	},
	ACTIVE: {
		label: "Active",
		className: "bg-success/10 text-success",
		dot: "bg-success",
	},
	PAUSED: {
		label: "Paused",
		className: "bg-highlight/10 text-highlight",
		dot: "bg-highlight",
	},
	ARCHIVED: {
		label: "Archived",
		className: "bg-destructive/10 text-destructive",
		dot: "bg-destructive",
	},
};

export function WorkflowCard({
	workflow,
	variant = "grid",
	onRefresh,
}: WorkflowCardProps) {
	const router = useRouter();
	const { basePath: orgBasePath, organizationId } = useOrganizationContext();
	const basePath = `${orgBasePath}/workflows`;

	const statusInfo = statusConfig[workflow.status] ?? statusConfig.DRAFT;

	const deleteMutation = useMutation(
		orpc.workflows.delete.mutationOptions({
			onSuccess: () => {
				toast.success("Workflow deleted");
				onRefresh?.();
			},
			onError: () => {
				toast.error("Failed to delete workflow");
			},
		}),
	);

	const duplicateMutation = useMutation(
		orpc.workflows.duplicate.mutationOptions({
			onSuccess: (data) => {
				toast.success("Workflow duplicated");
				router.push(`${basePath}/${data.workflow.id}`);
			},
			onError: () => {
				toast.error("Failed to duplicate workflow");
			},
		}),
	);

	const updateMutation = useMutation(
		orpc.workflows.update.mutationOptions({
			onSuccess: () => {
				toast.success("Workflow updated");
				onRefresh?.();
			},
			onError: () => {
				toast.error("Failed to update workflow");
			},
		}),
	);

	// PUBLISHED and ACTIVE are the same thing to every trigger path, so a
	// published workflow is already live. Keying the toggle on ACTIVE alone
	// offered "Activate" on a workflow that was already accepting webhooks and
	// firing its schedule, and left Pause two clicks away behind that no-op.
	const isLive =
		workflow.status === "ACTIVE" || workflow.status === "PUBLISHED";

	const handleStatusToggle = () => {
		const newStatus = isLive ? "PAUSED" : "ACTIVE";
		updateMutation.mutate({
			id: workflow.id,
			organizationId,
			status: newStatus,
		});
	};

	const triggerLabel = workflow.triggerType
		.toLowerCase()
		.replace(/_/g, " ")
		.replace(/\b\w/g, (l) => l.toUpperCase());

	// List view variant
	if (variant === "list") {
		return (
			<button
				type="button"
				className="w-full text-left cursor-pointer hover:bg-muted/50 transition-colors border rounded-lg p-4"
				onClick={() => router.push(`${basePath}/${workflow.id}`)}
			>
				<div className="flex items-center justify-between">
					<div className="flex-1 min-w-0">
						<h3 className="font-medium mb-1">{workflow.name}</h3>
						<p className="text-sm text-muted-foreground line-clamp-1">
							{workflow.description || "No description"}
						</p>
					</div>
					<div className="flex items-center gap-4">
						<span
							className={cn(
								"text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1",
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
						<span className="text-sm text-muted-foreground">
							{workflow._count.executions} runs
						</span>
						<DropdownMenu>
							<DropdownMenuTrigger
								asChild
								onClick={(e) => e.stopPropagation()}
							>
								<Button variant="ghost" size="icon">
									<MoreHorizontalIcon className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										handleStatusToggle();
									}}
								>
									{isLive ? (
										<>
											<PauseIcon className="h-4 w-4 mr-2" />
											Pause
										</>
									) : (
										<>
											<PlayIcon className="h-4 w-4 mr-2" />
											Activate
										</>
									)}
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										duplicateMutation.mutate({
											id: workflow.id,
											organizationId,
										});
									}}
								>
									<CopyIcon className="h-4 w-4 mr-2" />
									Duplicate
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									className="text-destructive"
									onClick={(e) => {
										e.stopPropagation();
										deleteMutation.mutate({
											id: workflow.id,
											organizationId,
										});
									}}
								>
									<TrashIcon className="h-4 w-4 mr-2" />
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</button>
		);
	}

	// Grid view — compact tile
	return (
		<div className="group relative flex flex-col rounded-xl border bg-card transition-colors hover:border-primary/30 hover:bg-muted/20">
			{/* Status badge + dropdown - absolute top-right so title gets full width */}
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
							<MoreHorizontalIcon className="h-3.5 w-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem
							onClick={(e) => {
								e.stopPropagation();
								handleStatusToggle();
							}}
						>
							{isLive ? (
								<>
									<PauseIcon className="h-4 w-4 mr-2" />
									Pause
								</>
							) : (
								<>
									<PlayIcon className="h-4 w-4 mr-2" />
									Activate
								</>
							)}
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={(e) => {
								e.stopPropagation();
								duplicateMutation.mutate({
									id: workflow.id,
									organizationId,
								});
							}}
						>
							<CopyIcon className="h-4 w-4 mr-2" />
							Duplicate
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="text-destructive"
							onClick={(e) => {
								e.stopPropagation();
								deleteMutation.mutate({
									id: workflow.id,
									organizationId,
								});
							}}
						>
							<TrashIcon className="h-4 w-4 mr-2" />
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Header */}
			<div className="flex gap-3 p-4 pb-3">
				{/* Icon */}
				<button
					type="button"
					className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary/10 cursor-pointer"
					onClick={() => router.push(`${basePath}/${workflow.id}`)}
				>
					<ZapIcon className="h-4.5 w-4.5 text-secondary" />
				</button>

				{/* Content - pr-16 so text clears the absolute badge */}
				<div className="flex-1 min-w-0 pr-16">
					<button
						type="button"
						className="w-full text-left cursor-pointer"
						onClick={() =>
							router.push(`${basePath}/${workflow.id}`)
						}
					>
						<h3 className="font-semibold text-sm leading-snug line-clamp-2 group-hover:text-primary transition-colors">
							{workflow.name}
						</h3>
					</button>
					<p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
						{workflow.description || "No description provided"}
					</p>
				</div>
			</div>

			{/* Trigger + version badges */}
			<div className="px-4 pb-3 flex flex-wrap gap-1.5">
				<span className="text-[10px] px-1.5 py-0.5 rounded-sm font-medium bg-muted text-muted-foreground">
					{triggerLabel}
				</span>
				<span className="text-[10px] px-1.5 py-0.5 rounded-sm font-medium bg-muted text-muted-foreground">
					v{workflow.version}
				</span>
			</div>

			{/* Footer */}
			<div className="mt-auto flex items-center justify-between border-t px-4 py-2.5">
				<div className="flex items-center gap-3 text-[11px] text-muted-foreground">
					<span>{workflow._count.executions} runs</span>
					<span>
						{formatDistanceToNow(workflow.updatedAt, {
							addSuffix: true,
						})}
					</span>
				</div>
				<ArrowRightIcon className="h-3.5 w-3.5 text-primary opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-[opacity,transform] duration-150" />
			</div>
		</div>
	);
}
