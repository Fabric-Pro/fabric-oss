"use client";

import { cn } from "@ui/lib";
import {
	CheckCircle2Icon,
	ChevronDownIcon,
	CircleIcon,
	FileTextIcon,
	LoaderIcon,
	XCircleIcon,
} from "lucide-react";
import * as React from "react";

export type PlanStepStatus = "pending" | "in-progress" | "completed" | "failed";

export interface PlanStep {
	id: string;
	title: string;
	description?: string;
	status: PlanStepStatus;
	substeps?: PlanStep[];
}

interface PlanProps extends React.HTMLAttributes<HTMLDivElement> {
	steps: PlanStep[];
	title?: string;
	description?: string;
	/** Whether the plan is collapsed by default (default: true) */
	defaultCollapsed?: boolean;
	/** Whether the plan is currently streaming/being generated */
	isStreaming?: boolean;
}

export function Plan({
	steps,
	title = "Execution Plan",
	description,
	defaultCollapsed = true,
	isStreaming = false,
	className,
	...props
}: PlanProps) {
	const [isCollapsed, setIsCollapsed] = React.useState(defaultCollapsed);

	if (!steps || steps.length === 0) {
		return null;
	}

	const completedSteps = steps.filter((s) => s.status === "completed").length;
	const inProgressSteps = steps.filter(
		(s) => s.status === "in-progress",
	).length;
	const totalSteps = steps.length;

	return (
		<div
			className={cn(
				"rounded-xl border bg-card shadow-sm overflow-hidden",
				className,
			)}
			{...props}
		>
			{/* Collapsible Header */}
			<button
				type="button"
				onClick={() => setIsCollapsed(!isCollapsed)}
				className="w-full flex items-start gap-3 p-4 text-left hover:bg-muted/50 transition-colors"
			>
				{/* Document Icon */}
				<div className="shrink-0 mt-0.5">
					<FileTextIcon className="h-5 w-5 text-muted-foreground" />
				</div>

				{/* Title and Description */}
				<div className="flex-1 min-w-0 space-y-1">
					<div className="flex items-center gap-2">
						<h3 className="font-semibold text-sm leading-tight">
							{title}
						</h3>
						{/* Progress badge */}
						<span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
							{completedSteps}/{totalSteps}
						</span>
						{inProgressSteps > 0 && (
							<LoaderIcon className="h-3 w-3 text-blue-500 animate-spin" />
						)}
					</div>
					{description && (
						<p
							className="text-sm text-muted-foreground leading-relaxed truncate"
							title={description}
						>
							{description.length > 200
								? `${description.substring(0, 200)}...`
								: description}
						</p>
					)}
				</div>

				{/* Collapse Toggle */}
				<div className="shrink-0">
					<ChevronDownIcon
						className={cn(
							"h-5 w-5 text-muted-foreground transition-transform duration-200",
							isCollapsed && "-rotate-90",
						)}
					/>
				</div>
			</button>

			{/* Collapsible Content */}
			{!isCollapsed && (
				<div className="px-4 pb-4 pt-0 border-t">
					{/* Progress bar */}
					{totalSteps > 1 && (
						<div className="mb-4 pt-4">
							<div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
								<span>Progress</span>
								<span className="font-medium">
									{Math.round(
										(completedSteps / totalSteps) * 100,
									)}
									%
								</span>
							</div>
							<div className="h-1.5 bg-muted rounded-full overflow-hidden">
								<div
									className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 transition-all duration-500 ease-out"
									style={{
										width: `${(completedSteps / totalSteps) * 100}%`,
									}}
								/>
							</div>
						</div>
					)}

					{/* Steps List */}
					<div className={cn("space-y-2", totalSteps <= 1 && "pt-4")}>
						{steps.map((step, index) => (
							<PlanStepItem
								key={step.id}
								step={step}
								index={index}
							/>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

interface PlanStepItemProps {
	step: PlanStep;
	index: number;
	level?: number;
}

function PlanStepItem({ step, index, level = 0 }: PlanStepItemProps) {
	const getStatusIcon = () => {
		switch (step.status) {
			case "completed":
				return <CheckCircle2Icon className="size-4 text-green-500" />;
			case "in-progress":
				return (
					<LoaderIcon className="size-4 text-blue-500 animate-spin" />
				);
			case "failed":
				return <XCircleIcon className="size-4 text-red-500" />;
			default:
				return <CircleIcon className="size-4 text-muted-foreground" />;
		}
	};

	const getStatusColor = () => {
		switch (step.status) {
			case "completed":
				return "text-foreground";
			case "in-progress":
				return "text-foreground font-medium";
			case "failed":
				return "text-red-500";
			default:
				return "text-muted-foreground";
		}
	};

	// Truncate long titles for display
	const truncatedTitle =
		step.title.length > 150
			? `${step.title.substring(0, 150)}...`
			: step.title;

	return (
		<div className={cn("space-y-2", level > 0 && "ml-6")}>
			<div className="flex items-start gap-3 group">
				<div className="mt-0.5">{getStatusIcon()}</div>
				<div className="flex-1 min-w-0 space-y-1">
					<div className="flex items-start gap-2">
						<span
							className={cn(
								"text-sm leading-tight",
								getStatusColor(),
							)}
							title={step.title}
						>
							{level === 0 && (
								<span className="font-medium mr-1">
									{index + 1}.
								</span>
							)}
							{truncatedTitle}
						</span>
					</div>
					{step.description && (
						<p className="text-xs text-muted-foreground leading-relaxed">
							{step.description}
						</p>
					)}
				</div>
			</div>
			{step.substeps && step.substeps.length > 0 && (
				<div className="space-y-2">
					{step.substeps.map((substep, subIndex) => (
						<PlanStepItem
							key={substep.id}
							step={substep}
							index={subIndex}
							level={level + 1}
						/>
					))}
				</div>
			)}
		</div>
	);
}
