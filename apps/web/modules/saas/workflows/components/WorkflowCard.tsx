"use client";

import { isWorkflowLive } from "@repo/utils/workflow-status";
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
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { WORKFLOW_STATUS_DISPLAY } from "../lib/workflow-status-display";
import { ScheduledBadge } from "./ScheduledBadge";

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
		lastRunAt?: Date | null;
		_count: {
			executions: number;
			versions: number;
		};
	};
	variant?: "grid" | "list";
	onRefresh?: () => void;
}

function StatusBadge({
	status,
}: {
	status: WorkflowCardProps["workflow"]["status"];
}) {
	const statusInfo =
		WORKFLOW_STATUS_DISPLAY[status] ?? WORKFLOW_STATUS_DISPLAY.DRAFT;
	return (
		<span
			className={cn(
				"text-[10px] px-1.5 py-0.5 rounded font-medium leading-tight flex items-center gap-1",
				statusInfo.className,
			)}
		>
			<span className={cn("h-1.5 w-1.5 rounded-full", statusInfo.dot)} />
			{statusInfo.label}
		</span>
	);
}

export function WorkflowCard({
	workflow,
	variant = "grid",
	onRefresh,
}: WorkflowCardProps) {
	const router = useRouter();
	const { basePath: orgBasePath, organizationId } = useOrganizationContext();
	const basePath = `${orgBasePath}/workflows`;

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
	const isLive = isWorkflowLive(workflow.status);

	const handleStatusToggle = () => {
		const newStatus = isLive ? "PAUSED" : "ACTIVE";
		updateMutation.mutate({
			id: workflow.id,
			organizationId,
			status: newStatus,
		});
	};

	const isScheduled = workflow.triggerType === "SCHEDULE";

	const triggerLabel = workflow.triggerType
		.toLowerCase()
		.replace(/_/g, " ")
		.replace(/\b\w/g, (l) => l.toUpperCase());

	// List view variant
	if (variant === "list") {
		return (
			<div className="w-full text-left hover:bg-muted/50 transition-colors border rounded-lg p-4">
				<div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
					<Link
						href={`${basePath}/${workflow.id}`}
						className="flex-1 min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<h3 className="font-medium mb-1">{workflow.name}</h3>
						<p className="text-sm text-muted-foreground line-clamp-1">
							{workflow.description || "No description"}
						</p>
					</Link>
					<div className="flex flex-wrap items-center gap-3 sm:shrink-0 sm:flex-nowrap sm:gap-4">
						{isScheduled && <ScheduledBadge />}
						<StatusBadge status={workflow.status} />
						<span className="text-sm text-muted-foreground">
							{workflow._count.executions} runs
						</span>
						<DropdownMenu>
							<DropdownMenuTrigger
								asChild
								onClick={(e) => e.stopPropagation()}
							>
								<Button
									variant="ghost"
									size="icon"
									aria-label="Workflow actions"
								>
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
			</div>
		);
	}

	// Grid view — compact tile
	return (
		<div className="group relative flex flex-col rounded-xl border bg-card transition-colors hover:border-primary/30 hover:bg-muted/20">
			{/* Header */}
			<div
				data-testid="workflow-card-header"
				className="flex gap-3 p-4 pb-3"
			>
				{/* Icon */}
				<button
					type="button"
					aria-label={`Open ${workflow.name}`}
					className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary/10 cursor-pointer"
					onClick={() => router.push(`${basePath}/${workflow.id}`)}
				>
					<ZapIcon className="h-4.5 w-4.5 text-secondary" />
				</button>

				<div className="flex-1 min-w-0">
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

				{/* Only the menu shares the title row; the status lives in the meta row below, so the title keeps the card's width */}
				<div className="shrink-0">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Workflow actions"
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
			</div>

			{/* Status, trigger + version badges */}
			<div
				data-testid="workflow-card-meta"
				className="px-4 pb-3 flex flex-wrap items-center gap-1.5"
			>
				<StatusBadge status={workflow.status} />
				{isScheduled ? (
					<ScheduledBadge />
				) : (
					<span className="text-[10px] px-1.5 py-0.5 rounded-sm font-medium bg-muted text-muted-foreground">
						{triggerLabel}
					</span>
				)}
				<span className="text-[10px] px-1.5 py-0.5 rounded-sm font-medium bg-muted text-muted-foreground">
					v{workflow.version}
				</span>
			</div>

			{/* Footer */}
			<div className="mt-auto flex items-center justify-between border-t px-4 py-2.5">
				<div className="flex items-center gap-3 text-[11px] text-muted-foreground">
					<span>{workflow._count.executions} runs</span>
					<span>
						{workflow.lastRunAt
							? `Last run ${formatDistanceToNow(workflow.lastRunAt, { addSuffix: true })}`
							: `Edited ${formatDistanceToNow(workflow.updatedAt, { addSuffix: true })}`}
					</span>
				</div>
				<ArrowRightIcon className="h-3.5 w-3.5 text-primary opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-[opacity,transform] duration-150" />
			</div>
		</div>
	);
}
