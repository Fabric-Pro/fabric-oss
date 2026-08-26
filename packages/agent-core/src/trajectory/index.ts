/**
 * Trajectory Module
 *
 * Provides types and utilities for tracking agent execution trajectories.
 * Used for visualizing agent behavior and debugging.
 *
 * @example
 * ```typescript
 * import {
 *   TrajectoryCollector,
 *   globalTrajectoryCollector,
 *   type AgentTrajectory,
 *   type TrajectoryNode,
 * } from "@repo/agent-core/trajectory";
 *
 * // Create a new trajectory
 * const trajectoryId = globalTrajectoryCollector.startTrajectory({
 *   conversationId: "conv_123",
 * });
 *
 * // Add agent node
 * const agentNodeId = globalTrajectoryCollector.addAgentNode(
 *   trajectoryId,
 *   "orchestrator",
 *   "Fabric AI"
 * );
 *
 * // Start the node
 * globalTrajectoryCollector.startNode(trajectoryId, agentNodeId, { task: "..." });
 *
 * // Add tool call
 * const toolNodeId = globalTrajectoryCollector.addToolCallNode(
 *   trajectoryId,
 *   "code_executor",
 *   { code: "..." },
 *   agentNodeId
 * );
 *
 * // Complete the trajectory
 * globalTrajectoryCollector.completeTrajectory(trajectoryId);
 *
 * // Get the trajectory for visualization
 * const trajectory = globalTrajectoryCollector.getTrajectory(trajectoryId);
 * ```
 */

// Collector
export {
	globalTrajectoryCollector,
	TrajectoryCollector,
} from "./collector";
// Streaming (AG-UI compatible)
export type {
	TrajectoryStreamEvent,
	TrajectoryStreamEventType,
} from "./streaming";
export {
	createHITLRequestTrajectoryEvent,
	createHITLResponseTrajectoryEvent,
	globalTrajectoryStreamHandler,
	TrajectoryStreamHandler,
	trajectoryEventToAGUI,
} from "./streaming";
// Types
export type {
	AddNodeOptions,
	AgentTrajectory,
	CreateTrajectoryOptions,
	TrajectoryEdge,
	TrajectoryEvent,
	TrajectoryNode,
	TrajectoryNodeStatus,
	TrajectoryNodeType,
	TrajectoryStatus,
} from "./types";
