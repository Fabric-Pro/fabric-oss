"use client";

/**
 * TaskPlanView Component
 *
 * Displays the full task plan with all steps and visual indicators
 * for approval requirements and step status.
 */

import type { TaskPlan, TaskStep } from "@repo/temporal";
import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib";
import {
	AlertTriangle,
	CheckCircle2,
	Circle,
	Clock,
	Loader2,
	ShieldAlert,
	XCircle,
} from "lucide-react";

interface TaskPlanViewProps {
	plan: TaskPlan;
	/** Currently executing step ID */
	currentStepId?: string;
	/** Step ID that requires approval */
	pendingApprovalStepId?: string;
	/** Whether to show in compact mode */
	compact?: boolean;
	className?: string;
}

export function TaskPlanView({
	plan,
	currentStepId,
	pendingApprovalStepId,
	compact = false,
	className,
}: TaskPlanViewProps) {
	if (!plan?.steps || plan.steps.length === 0) {
		return null;
	}

	const getRiskBadgeVariant = (
		riskLevel?: string,
	): "default" | "secondary" | "destructive" | "outline" => {
		switch (riskLevel?.toLowerCase()) {
			case "critical":
			case "high":
				return "destructive";
			case "medium":
				return "secondary";
			default:
				return "outline";
		}
	};

	return (
		<div className={cn("space-y-3", className)}>
			{/* Plan header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium">Task Plan</span>
					<Badge
						variant={getRiskBadgeVariant(plan.riskLevel)}
						className="text-xs"
					>
						{plan.riskLevel?.toUpperCase()} RISK
					</Badge>
				</div>
				<span className="text-xs text-muted-foreground">
					{plan.steps.filter((s) => s.status === "complete").length}/
					{plan.steps.length} steps
				</span>
			</div>

			{/* Plan description */}
			{!compact && plan.description && (
				<p className="text-sm text-muted-foreground">
					{plan.description}
				</p>
			)}

			{/* Steps list */}
			<div className="space-y-1">
				{plan.steps.map((step, index) => (
					<TaskStepItem
						key={step.id}
						step={step}
						index={index}
						isCurrentStep={step.id === currentStepId}
						isPendingApproval={step.id === pendingApprovalStepId}
						compact={compact}
					/>
				))}
			</div>
		</div>
	);
}

interface TaskStepItemProps {
	step: TaskStep;
	index: number;
	isCurrentStep?: boolean;
	isPendingApproval?: boolean;
	compact?: boolean;
}

function TaskStepItem({
	step,
	index,
	isCurrentStep,
	isPendingApproval,
	compact,
}: TaskStepItemProps) {
	const getStatusIcon = () => {
		if (isPendingApproval) {
			return (
				<ShieldAlert className="size-4 text-highlight animate-pulse" />
			);
		}
		switch (step.status) {
			case "complete":
				return <CheckCircle2 className="size-4 text-success" />;
			case "in_progress":
				return (
					<Loader2 className="size-4 text-blue-500 animate-spin" />
				);
			case "error":
				return <XCircle className="size-4 text-destructive" />;
			case "skipped":
				return <Circle className="size-4 text-muted-foreground/50" />;
			case "awaiting_approval":
				return <ShieldAlert className="size-4 text-highlight" />;
			default:
				return <Circle className="size-4 text-muted-foreground" />;
		}
	};

	const getStatusColor = () => {
		if (isPendingApproval) {
			return "text-amber-700 dark:text-amber-400 font-medium";
		}
		if (isCurrentStep) {
			return "text-blue-700 dark:text-blue-400 font-medium";
		}
		switch (step.status) {
			case "complete":
				return "text-foreground";
			case "in_progress":
				return "text-blue-700 dark:text-blue-400 font-medium";
			case "error":
				return "text-destructive";
			case "skipped":
				return "text-muted-foreground/50 line-through";
			default:
				return "text-muted-foreground";
		}
	};

	const showApprovalBadge =
		step.requiresApproval && step.status !== "complete";

	// Truncate long descriptions for display
	const truncatedDescription =
		step.description.length > 150
			? `${step.description.substring(0, 150)}...`
			: step.description;

	return (
		<div
			className={cn(
				"flex items-start gap-2 py-1.5 px-2 rounded-md transition-colors",
				isPendingApproval &&
					"bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800",
				isCurrentStep &&
					!isPendingApproval &&
					"bg-blue-50 dark:bg-blue-900/20",
			)}
		>
			<div className="mt-0.5 shrink-0">{getStatusIcon()}</div>
			<div className="flex-1 min-w-0">
				<div className="flex items-start gap-2">
					<span
						className={cn(
							"text-sm leading-tight",
							getStatusColor(),
						)}
						title={step.description}
					>
						<span className="font-medium mr-1">{index + 1}.</span>
						{truncatedDescription}
					</span>
					{showApprovalBadge && (
						<Badge
							variant="outline"
							className="shrink-0 text-xs py-0 h-5"
						>
							<AlertTriangle className="size-3 mr-1" />
							Approval
						</Badge>
					)}
				</div>
				{!compact && step.executor && (
					<div className="flex items-center gap-2 mt-1">
						<span className="text-xs text-muted-foreground">
							via {step.executor}
						</span>
						{step.durationMs && (
							<span className="text-xs text-muted-foreground flex items-center gap-1">
								<Clock className="size-3" />
								{(step.durationMs / 1000).toFixed(1)}s
							</span>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
