"use client";

import {
	BaseEdge,
	EdgeLabelRenderer,
	type EdgeProps,
	getSmoothStepPath,
} from "@xyflow/react";
import { PlusIcon } from "lucide-react";
import { useWorkflowCanvas } from "./canvas-context";

/**
 * A thin connector with a "+" at its midpoint that inserts a step between
 * the two nodes it joins. While a run is being viewed, a connector the run
 * travelled (both ends completed) is tinted with the success colour.
 */
export function InsertableEdge({
	id,
	source,
	target,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	markerEnd,
	selected,
}: EdgeProps) {
	const { onInsertOnEdge, steps } = useWorkflowCanvas();
	const [path, labelX, labelY] = getSmoothStepPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
		borderRadius: 12,
	});

	const travelled =
		steps?.get(source)?.status === "COMPLETED" &&
		steps?.get(target)?.status === "COMPLETED";
	const stroke = travelled
		? "color-mix(in srgb, var(--success) 60%, transparent)"
		: selected
			? "var(--muted-foreground)"
			: "var(--input)";

	return (
		<>
			<BaseEdge
				id={id}
				path={path}
				markerEnd={markerEnd}
				style={{ stroke, strokeWidth: 1.5 }}
			/>
			<EdgeLabelRenderer>
				<button
					type="button"
					aria-label="Insert step here"
					title="Insert step"
					onClick={() => onInsertOnEdge(id)}
					className="nodrag nopan pointer-events-auto absolute flex size-[22px] items-center justify-center rounded-full border border-input bg-background text-muted-foreground hover:border-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring motion-safe:transition-colors"
					style={{
						transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
					}}
				>
					<PlusIcon className="size-3" aria-hidden="true" />
				</button>
			</EdgeLabelRenderer>
		</>
	);
}
