"use client";

import { createContext, useContext } from "react";
import type { StepRun } from "../../lib/run-steps";

/**
 * What the canvas's custom nodes and edges need from the builder. Passed by
 * context rather than through node and edge `data`, so the saved graph, the
 * undo history and its change detection never carry handlers or run results.
 */
interface WorkflowCanvasContextValue {
	/** Put a new, empty step on this edge, between its two ends. */
	onInsertOnEdge: (edgeId: string) => void;
	/** The viewed run's result per node id, or null when editing. */
	steps: ReadonlyMap<string, StepRun> | null;
}

const WorkflowCanvasContext = createContext<WorkflowCanvasContextValue>({
	onInsertOnEdge: () => {},
	steps: null,
});

export const WorkflowCanvasProvider = WorkflowCanvasContext.Provider;

export function useWorkflowCanvas() {
	return useContext(WorkflowCanvasContext);
}
