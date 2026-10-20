/**
 * Node-type names of the unattended agent steps.
 *
 * Reachable from the workflow bundle (`workflows/lib/workflow-builder-nodes.ts`),
 * so this module MUST stay pure: no `zod`, no I/O, no `@repo/*` imports.
 * `agentic-workflow-preset.ts` (which pulls `zod`) and the step registry read
 * the same constants from here.
 */
export const AGENT_TASK_NODE_TYPE = "agent-task";
export const PUBLISH_FRAME_NODE_TYPE = "publish-frame";
export const ADO_STORY_REVIEW_NODE_TYPE = "mcp-review-ado-stories";
