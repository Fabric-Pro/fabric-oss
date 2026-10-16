/**
 * The workflow tools' definitions are Fabric's one list
 * (`@repo/temporal/fabric-workflow-tool-definitions`), which the gateway
 * registers beside the handlers in `platform-tools` and the Orchestrator's
 * catalogue indexes. What the handlers need from it is the status names.
 */

export { WORKFLOW_STATUSES } from "@repo/temporal/fabric-workflow-tool-definitions";
