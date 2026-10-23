"use client";

import { cn } from "@ui/lib";
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { formatDuration } from "../../lib/format-duration";
import { getNodeAppearance } from "../../lib/node-appearance";
import type { ViewedRun } from "../../lib/run-steps";
import type { WorkflowNode, WorkflowNodeData } from "../../lib/types";
import { NodeConfigEditor } from "../NodeConfigEditor";
import { RunStatusIcon } from "./RunStatusIcon";

const STATUS_LABELS: Record<string, string> = {
	PENDING: "pending",
	RUNNING: "running",
	COMPLETED: "completed",
	FAILED: "failed",
	SKIPPED: "skipped",
};

function StepRunOutput({
	nodeId,
	viewedRun,
}: {
	nodeId: string;
	viewedRun: ViewedRun;
}) {
	const step = viewedRun.steps.get(nodeId);
	return (
		<div className="flex flex-col gap-1.5">
			<p className="text-xs text-muted-foreground">
				Output from run{" "}
				<span className="font-mono">{viewedRun.shortId}</span>
			</p>
			{step ? (
				<div className="rounded-lg border bg-muted p-2.5 font-mono text-[11px] leading-relaxed">
					<p className="flex items-center gap-1.5">
						<RunStatusIcon
							status={step.status}
							className="size-3"
						/>
						status: {STATUS_LABELS[step.status] ?? step.status}
						{step.duration !== null && step.duration > 0
							? ` · ${formatDuration(step.duration)}`
							: ""}
					</p>
					{step.error ? (
						<p className="mt-1.5 whitespace-pre-wrap break-all text-destructive">
							{step.error}
						</p>
					) : null}
					{step.output !== null ? (
						<pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all">
							{JSON.stringify(step.output, null, 2)}
						</pre>
					) : null}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					This step did not run.
				</p>
			)}
		</div>
	);
}

/**
 * The inspector's "Step" view: which step this is, its configuration, its
 * result in the run being viewed, and the way to delete it.
 */
export function StepInspector({
	node,
	onBack,
	onUpdate,
	onDelete,
	viewedRun,
}: {
	node: WorkflowNode;
	onBack: () => void;
	onUpdate: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
	onDelete: (nodeId: string) => void;
	viewedRun: ViewedRun | null;
}) {
	const { Icon, tileClass, kind } = getNodeAppearance(
		node.type ?? "",
		node.data,
	);

	return (
		<div className="flex flex-1 flex-col gap-[18px] p-4">
			<div className="flex items-center gap-2.5">
				<button
					type="button"
					onClick={onBack}
					aria-label="Back to workflow"
					title="Back to workflow"
					className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
				>
					<ArrowLeftIcon className="size-3.5" aria-hidden="true" />
				</button>
				<span
					className={cn(
						"flex size-[30px] shrink-0 items-center justify-center rounded-[7px]",
						tileClass,
					)}
				>
					<Icon className="size-[15px]" />
				</span>
				<span className="flex min-w-0 flex-col">
					<span className="truncate text-sm font-medium">
						{node.data.label || "Untitled"}
					</span>
					<span className="truncate text-xs text-muted-foreground">
						{kind}
					</span>
				</span>
			</div>

			<NodeConfigEditor node={node} onUpdate={onUpdate} />

			{viewedRun ? (
				<StepRunOutput nodeId={node.id} viewedRun={viewedRun} />
			) : null}

			<div className="flex-1" />
			<button
				type="button"
				onClick={() => onDelete(node.id)}
				className="flex h-[30px] items-center gap-1.5 self-start rounded-lg border border-input px-2.5 text-xs text-destructive hover:border-destructive focus-visible:outline-2 focus-visible:outline-ring motion-safe:transition-colors"
			>
				<Trash2Icon className="size-3.5" aria-hidden="true" />
				Delete step
			</button>
		</div>
	);
}
