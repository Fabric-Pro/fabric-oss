"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	type FitViewOptions,
	MiniMap,
	Panel,
	useEdges,
	useNodes,
	useReactFlow,
	useViewport,
	ViewportPortal,
} from "@xyflow/react";
import { MapIcon, MinusIcon, PlusIcon, ScanIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { lastStep } from "../../lib/graph-edits";

/**
 * Fitting the graph leaves room for what floats over the canvas: the run pill
 * at the top, the Add step button and the Ask AI bar at the bottom. Steps are
 * never blown up past their natural size.
 */
export const FIT_VIEW_OPTIONS: FitViewOptions = {
	padding: { top: "72px", bottom: "120px", x: "48px" },
	maxZoom: 1,
};

function PillButton({
	label,
	onClick,
	pressed,
	children,
}: {
	label: string;
	onClick: () => void;
	pressed?: boolean;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					aria-pressed={pressed}
					onClick={onClick}
					className={cn(
						"flex size-7 items-center justify-center rounded-md text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring motion-safe:transition-colors",
						pressed && "bg-accent",
					)}
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Zoom, fit and minimap in one pill at the bottom left of the canvas. Must be
 * rendered inside `<ReactFlow>`, whose viewport it reads and drives.
 */
export function CanvasControls() {
	const { zoomIn, zoomOut, fitView } = useReactFlow();
	const { zoom } = useViewport();
	const [showMiniMap, setShowMiniMap] = useState(false);

	return (
		<>
			<Panel
				position="bottom-left"
				className="flex items-center gap-0.5 rounded-lg border bg-card p-0.5"
			>
				<PillButton label="Zoom out" onClick={() => zoomOut()}>
					<MinusIcon className="size-3.5" aria-hidden="true" />
				</PillButton>
				<span
					className="w-[38px] text-center font-mono text-xs text-muted-foreground"
					aria-live="polite"
				>
					{Math.round(zoom * 100)}%
				</span>
				<PillButton label="Zoom in" onClick={() => zoomIn()}>
					<PlusIcon className="size-3.5" aria-hidden="true" />
				</PillButton>
				<span
					className="mx-0.5 h-4 w-px bg-border"
					aria-hidden="true"
				/>
				<PillButton
					label="Fit view"
					onClick={() => fitView(FIT_VIEW_OPTIONS)}
				>
					<ScanIcon className="size-3.5" aria-hidden="true" />
				</PillButton>
				<PillButton
					label={showMiniMap ? "Hide minimap" : "Show minimap"}
					pressed={showMiniMap}
					onClick={() => setShowMiniMap((shown) => !shown)}
				>
					<MapIcon className="size-3.5" aria-hidden="true" />
				</PillButton>
			</Panel>
			{showMiniMap && (
				<MiniMap
					nodeStrokeWidth={3}
					zoomable
					pannable
					bgColor="var(--card)"
					maskColor="color-mix(in srgb, var(--background) 70%, transparent)"
					nodeColor="var(--muted)"
					nodeStrokeColor="var(--border)"
					className="rounded-lg border"
				/>
			)}
		</>
	);
}

/** Gap between the last step and the "Add step" button below it. */
const ANCHOR_GAP = 28;

/**
 * The dashed "Add step" button under the last step, drawn in flow
 * coordinates so it pans and zooms with the canvas. Hidden on an empty
 * canvas, which has its own "Add a Step" placeholder.
 */
export function AddStepAnchor({ onAddStep }: { onAddStep: () => void }) {
	const nodes = useNodes();
	const edges = useEdges();
	// The same step `appendStep` will continue from.
	const last = lastStep({ nodes, edges });
	if (!last) {
		return null;
	}

	const width = last.measured?.width ?? 0;
	const height = last.measured?.height ?? 0;

	return (
		<ViewportPortal>
			<div
				className="absolute flex flex-col items-center"
				style={{
					transform: `translate(-50%, 0) translate(${last.position.x + width / 2}px, ${last.position.y + height}px)`,
				}}
			>
				<span
					className="w-px bg-input"
					style={{ height: ANCHOR_GAP }}
					aria-hidden="true"
				/>
				<button
					type="button"
					onClick={onAddStep}
					className="nodrag nopan pointer-events-auto flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-input bg-background px-3 text-sm text-muted-foreground hover:border-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring motion-safe:transition-colors"
				>
					<PlusIcon className="size-3.5" aria-hidden="true" />
					Add step
				</button>
			</div>
		</ViewportPortal>
	);
}
