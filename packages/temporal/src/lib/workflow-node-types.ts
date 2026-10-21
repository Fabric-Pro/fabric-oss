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
export const SCRIPT_TRANSFORM_NODE_TYPE = "script-transform";
export const WORKSPACE_DATA_READ_NODE_TYPE = "workspace-data-read";
export const WORKSPACE_DATA_WRITE_NODE_TYPE = "workspace-data-write";
export const NATIVE_PLATFORM_READ_NODE_TYPE = "native-platform-read";
