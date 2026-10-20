/**
 * The workflow tools' definitions are Fabric's one list
 * (`@repo/temporal/fabric-workflow-tool-definitions`), which the gateway
 * registers beside the handlers in `platform-tools` and the Orchestrator's
 * catalogue indexes. What the handlers need from it is the status names and the
 * numeric bounds the list advertises, so what they accept is what clients are
 * told.
 */

export {
	WORKFLOW_GRAPH_LIMITS,
	WORKFLOW_LIST_LIMIT,
	WORKFLOW_RUNS_LIMIT,
	WORKFLOW_STATUSES,
} from "@repo/temporal/fabric-workflow-tool-definitions";
