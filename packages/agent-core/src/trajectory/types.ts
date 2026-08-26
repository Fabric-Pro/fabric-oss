/**
 * Trajectory Types
 *
 * Types for tracking agent execution trajectories for visualization.
 * Trajectories capture the flow of agent execution including:
 * - Agent routing decisions
 * - Tool calls and results
 * - Human-in-the-loop interactions
 * - State changes
 */

/**
 * Types of nodes in a trajectory
 */
export type TrajectoryNodeType =
	| "start" // Beginning of execution
	| "agent" // Agent invocation
	| "tool_call" // Tool being called
	| "tool_result" // Result from tool
	| "decision" // Routing or conditional decision
	| "hitl" // Human-in-the-loop interaction
	| "state_update" // State change
	| "reflection" // Reflection/self-evaluation step
	| "error" // Error occurred
	| "end"; // End of execution

/**
 * Status of a trajectory node
 */
export type TrajectoryNodeStatus =
	| "pending" // Not yet started
	| "running" // Currently executing
	| "success" // Completed successfully
	| "error" // Failed with error
	| "skipped" // Skipped due to conditional
	| "waiting"; // Waiting for input (e.g., HITL)

/**
 * A single node in the execution trajectory
 */
export interface TrajectoryNode {
	/** Unique identifier for this node */
	id: string;

	/** Type of node */
	type: TrajectoryNodeType;

	/** Human-readable label */
	label: string;

	/** Current status */
	status: TrajectoryNodeStatus;

	/** When this node was created */
	timestamp: string;

	/** Duration in milliseconds (if completed) */
	duration?: number;

	/** Agent ID if this is an agent node */
	agentId?: string;

	/** Agent display name */
	agentName?: string;

	/** Tool name if this is a tool node */
	toolName?: string;

	/** Input data for this node */
	input?: Record<string, unknown>;

	/** Output data from this node */
	output?: Record<string, unknown>;

	/** Error message if status is error */
	error?: string;

	/** Child node IDs (for hierarchical display) */
	children: string[];

	/** Parent node ID */
	parentId?: string;

	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * An edge connecting two nodes in the trajectory
 */
export interface TrajectoryEdge {
	/** Source node ID */
	source: string;

	/** Target node ID */
	target: string;

	/** Edge label (optional) */
	label?: string;

	/** Edge type for styling */
	type?: "default" | "conditional" | "error" | "async";
}

/**
 * Overall status of a trajectory
 */
export type TrajectoryStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Complete execution trajectory
 */
export interface AgentTrajectory {
	/** Unique identifier for this trajectory */
	id: string;

	/** Associated conversation ID */
	conversationId?: string;

	/** All nodes in the trajectory */
	nodes: TrajectoryNode[];

	/** Edges connecting nodes */
	edges: TrajectoryEdge[];

	/** When execution started */
	startTime: string;

	/** When execution ended (if completed) */
	endTime?: string;

	/** Total duration in milliseconds */
	totalDuration?: number;

	/** Overall status */
	status: TrajectoryStatus;

	/** Root node ID */
	rootNodeId?: string;

	/** Summary of execution */
	summary?: {
		totalNodes: number;
		successfulNodes: number;
		failedNodes: number;
		toolCallsCount: number;
		agentsInvoked: string[];
	};

	/** Metadata about the execution */
	metadata?: Record<string, unknown>;
}

/**
 * Event emitted during trajectory updates
 */
export interface TrajectoryEvent {
	type:
		| "node_added"
		| "node_updated"
		| "edge_added"
		| "trajectory_started"
		| "trajectory_completed"
		| "trajectory_failed";
	timestamp: string;
	data: {
		trajectoryId: string;
		node?: TrajectoryNode;
		edge?: TrajectoryEdge;
		status?: TrajectoryStatus;
	};
}

/**
 * Options for creating a new trajectory
 */
export interface CreateTrajectoryOptions {
	conversationId?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Options for adding a node
 */
export interface AddNodeOptions {
	parentId?: string;
	metadata?: Record<string, unknown>;
}
