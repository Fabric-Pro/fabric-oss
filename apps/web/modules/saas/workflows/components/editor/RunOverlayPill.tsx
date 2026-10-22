"use client";

import { formatDistanceToNow } from "date-fns";
import { formatDuration } from "../../lib/format-duration";
import { formatTriggerType } from "../../lib/run-steps";
import { RunStatusIcon } from "./RunStatusIcon";

interface ViewedExecution {
	status: string;
	triggerType?: string | null;
	startedAt?: Date | string | null;
	duration?: number | null;
}

/**
 * Centred over the top of the canvas while a run is being viewed: which run
 * it is, a way to its full execution details, and the way back to editing.
 */
export function RunOverlayPill({
	shortId,
	execution,
	onShowDetails,
	onExit,
}: {
	shortId: string;
	execution: ViewedExecution | undefined;
	/** Absent while the execution details are already open. */
	onShowDetails?: () => void;
	onExit: () => void;
}) {
	const facts = execution
		? [
				formatTriggerType(execution.triggerType),
				execution.startedAt
					? formatDistanceToNow(new Date(execution.startedAt), {
							addSuffix: true,
						})
					: null,
				execution.duration && execution.duration > 0
					? formatDuration(execution.duration)
					: null,
			].filter((fact): fact is string => Boolean(fact))
		: [];

	return (
		<div className="pointer-events-auto absolute left-1/2 top-3 z-20 flex h-[34px] -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-full border bg-card pl-3 pr-1.5 text-xs">
			<RunStatusIcon
				status={execution?.status ?? "PENDING"}
				className="size-3"
			/>
			<output className="flex items-center gap-2.5">
				<span>
					Viewing run <span className="font-mono">{shortId}</span>
				</span>
				{facts.length > 0 ? (
					<span className="text-muted-foreground">
						{facts.join(" · ")}
					</span>
				) : null}
			</output>
			{onShowDetails ? (
				<button
					type="button"
					onClick={onShowDetails}
					className="h-6 rounded-full px-2.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
				>
					Details
				</button>
			) : null}
			<button
				type="button"
				onClick={onExit}
				className="h-6 rounded-full bg-accent px-2.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
			>
				Back to editing
			</button>
		</div>
	);
}
