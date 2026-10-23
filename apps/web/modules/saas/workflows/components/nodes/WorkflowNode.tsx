"use client";

import { cn } from "@ui/lib";
import { Handle, Position } from "@xyflow/react";
import { formatDuration } from "../../lib/format-duration";
import { getNodeAppearance } from "../../lib/node-appearance";
import type { WorkflowNodeData } from "../../lib/types";
import { useWorkflowCanvas } from "../editor/canvas-context";
import { RunStatusIcon } from "../editor/RunStatusIcon";

const HANDLE_CLASS =
	"size-2! border-2! border-background! bg-muted-foreground!";

interface WorkflowNodeComponentProps {
	data: WorkflowNodeData;
	type?: string;
	selected?: boolean;
	id?: string;
}

/**
 * A step on the canvas: a tinted icon tile, the step's label and what kind
 * of step it is. Steps flow top to bottom, so edges enter at the top and
 * leave at the bottom; a condition leaves by its true (left) or false
 * (right) handle. While a run is viewed the card shows that step's result.
 */
export function WorkflowNodeComponent({
	id,
	data,
	type,
	selected,
}: WorkflowNodeComponentProps) {
	const nodeType = type || "trigger";
	const { Icon, tileClass, kind } = getNodeAppearance(nodeType, data);
	const { steps } = useWorkflowCanvas();
	const step = id ? steps?.get(id) : undefined;
	const label = data.label || "Untitled";

	return (
		<div
			data-testid={`workflow-node-${nodeType}`}
			className={cn(
				"relative flex w-[300px] items-center gap-3 rounded-[10px] border bg-card px-3.5 py-3 text-card-foreground",
				"motion-safe:transition-[border-color,box-shadow] motion-safe:duration-150",
				selected
					? "border-foreground ring-[3px] ring-foreground/10"
					: step?.status === "COMPLETED"
						? "border-success/40"
						: step?.status === "FAILED"
							? "border-destructive/50"
							: "border-border",
			)}
		>
			{nodeType !== "trigger" && (
				<Handle
					type="target"
					position={Position.Top}
					className={HANDLE_CLASS}
				/>
			)}

			<span
				className={cn(
					"flex size-[34px] shrink-0 items-center justify-center rounded-lg",
					tileClass,
				)}
			>
				<Icon className="size-[17px]" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-sm font-medium" title={label}>
					{label}
				</span>
				<span className="truncate text-xs text-muted-foreground">
					{kind}
				</span>
			</span>

			{step && (
				<span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
					<RunStatusIcon status={step.status} />
					{step.duration !== null && step.duration > 0
						? formatDuration(step.duration)
						: null}
				</span>
			)}

			{nodeType === "condition" ? (
				<>
					<Handle
						type="source"
						position={Position.Bottom}
						id="true"
						className="left-1/3! size-2! border-2! border-background! bg-success!"
						title="True"
					/>
					<Handle
						type="source"
						position={Position.Bottom}
						id="false"
						className="left-2/3! size-2! border-2! border-background! bg-destructive!"
						title="False"
					/>
				</>
			) : (
				<Handle
					type="source"
					position={Position.Bottom}
					className={HANDLE_CLASS}
				/>
			)}
		</div>
	);
}
