"use client";

/**
 * CugaSubtaskTree
 *
 * Displays the task decomposition tree from CUGA's Task Analyzer.
 * Shows subtasks with their status, dependencies, and execution progress.
 */

import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib";
import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Circle,
	Loader2,
	SkipForward,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import type { CugaSubtask, CugaSubtaskStatus } from "./types";

interface CugaSubtaskTreeProps {
	subtasks: CugaSubtask[];
	currentSubtaskId?: string;
	thoughts?: string;
	className?: string;
}

const STATUS_ICONS: Record<CugaSubtaskStatus, React.ReactNode> = {
	pending: <Circle className="h-4 w-4 text-muted-foreground" />,
	running: <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />,
	complete: <CheckCircle2 className="h-4 w-4 text-success" />,
	failed: <XCircle className="h-4 w-4 text-destructive" />,
	skipped: <SkipForward className="h-4 w-4 text-muted-foreground" />,
};

const STATUS_COLORS: Record<CugaSubtaskStatus, string> = {
	pending: "bg-muted text-muted-foreground",
	running: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
	complete:
		"bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
	failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
	skipped: "bg-muted text-muted-foreground",
};

function getAppIcon(app?: string): string {
	switch (app?.toLowerCase()) {
		case "gmail":
			return "📧";
		case "browser":
			return "🌐";
		case "api":
			return "🔌";
		case "code":
			return "💻";
		case "file":
			return "📁";
		case "calendar":
			return "📅";
		case "slack":
			return "💬";
		default:
			return "🔧";
	}
}

function SubtaskItem({
	subtask,
	index,
	isCurrent,
	depth = 0,
}: {
	subtask: CugaSubtask;
	index: number;
	isCurrent: boolean;
	depth?: number;
}) {
	const [isExpanded, setIsExpanded] = useState(true);
	const hasChildren = subtask.children && subtask.children.length > 0;

	return (
		<div className={cn("relative", depth > 0 && "ml-6")}>
			<div
				className={cn(
					"flex items-start gap-3 p-2 rounded-lg transition-colors",
					isCurrent &&
						"bg-blue-50 dark:bg-blue-900/20 ring-1 ring-blue-200 dark:ring-blue-800",
				)}
			>
				{/* Step Number */}
				<div
					className={cn(
						"flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold",
						subtask.status === "complete"
							? "bg-green-500 text-white"
							: subtask.status === "running"
								? "bg-blue-500 text-white"
								: subtask.status === "failed"
									? "bg-red-500 text-white"
									: "bg-muted text-muted-foreground",
					)}
				>
					{String(index + 1).padStart(2, "0")}
				</div>

				{/* Content */}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 mb-1">
						{subtask.app && (
							<Badge
								variant="outline"
								className={cn(
									"text-xs",
									STATUS_COLORS[subtask.status],
								)}
							>
								{getAppIcon(subtask.app)} {subtask.app}
							</Badge>
						)}
						{subtask.type && (
							<Badge variant="secondary" className="text-xs">
								{subtask.type}
							</Badge>
						)}
						{STATUS_ICONS[subtask.status]}
					</div>
					<p className="text-sm text-foreground">
						{subtask.description}
					</p>
					{subtask.error && (
						<p className="text-xs text-destructive mt-1">
							{subtask.error}
						</p>
					)}
				</div>

				{/* Expand/Collapse for children */}
				{hasChildren && (
					<button
						type="button"
						onClick={() => setIsExpanded(!isExpanded)}
						className="p-1 hover:bg-muted rounded"
					>
						{isExpanded ? (
							<ChevronDown className="h-4 w-4" />
						) : (
							<ChevronRight className="h-4 w-4" />
						)}
					</button>
				)}
			</div>

			{/* Children */}
			{hasChildren && isExpanded && (
				<div className="mt-1 space-y-1 border-l-2 border-muted">
					{subtask.children?.map((child, childIndex) => (
						<SubtaskItem
							key={child.id}
							subtask={child}
							index={childIndex}
							isCurrent={false}
							depth={depth + 1}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function CugaSubtaskTree({
	subtasks,
	currentSubtaskId,
	thoughts: _thoughts,
	className,
}: CugaSubtaskTreeProps) {
	const [_showThoughts, _setShowThoughts] = useState(false);
	const completedCount = subtasks.filter(
		(s) => s.status === "complete",
	).length;

	if (subtasks.length === 0) {
		return null;
	}

	return (
		<div className={cn("rounded-lg border bg-card p-4", className)}>
			{/* Header */}
			<div className="flex items-center justify-between mb-3">
				<h3 className="text-sm font-medium flex items-center gap-2">
					<span>📋</span> Task Breakdown
				</h3>
				<Badge variant="secondary">
					{completedCount}/{subtasks.length} complete
				</Badge>
			</div>

			{/* Subtasks */}
			<div className="space-y-2">
				{subtasks.map((subtask, index) => (
					<SubtaskItem
						key={subtask.id}
						subtask={subtask}
						index={index}
						isCurrent={subtask.id === currentSubtaskId}
					/>
				))}
			</div>
		</div>
	);
}
