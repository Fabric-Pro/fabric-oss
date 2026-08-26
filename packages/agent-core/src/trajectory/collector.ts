/**
 * Trajectory Collector
 *
 * Collects and manages execution trajectories for visualization.
 * Provides methods to:
 * - Start/end trajectories
 * - Add nodes and edges
 * - Update node status
 * - Subscribe to trajectory events
 * - Stream events via AG-UI protocol
 */

import type {
	AddNodeOptions,
	AgentTrajectory,
	CreateTrajectoryOptions,
	TrajectoryEdge,
	TrajectoryEvent,
	TrajectoryNode,
	TrajectoryNodeStatus,
	TrajectoryNodeType,
} from "./types";

type TrajectoryEventHandler = (event: TrajectoryEvent) => void;

/**
 * Stream handler interface for AG-UI compatible streaming
 */
interface StreamHandler {
	handleTrajectoryEvent(
		event: TrajectoryEvent,
		trajectory?: AgentTrajectory,
	): void;
	emitHITLRequest(
		trajectoryId: string,
		requestId: string,
		requestType: "approval" | "input" | "choice",
		prompt: string,
		options?: Array<{ value: string; label: string }>,
	): void;
	emitHITLResponse(
		trajectoryId: string,
		requestId: string,
		approved: boolean,
		value?: unknown,
	): void;
}

/**
 * Collector for tracking agent execution trajectories
 */
export class TrajectoryCollector {
	private trajectories: Map<string, AgentTrajectory> = new Map();
	private eventHandlers: Set<TrajectoryEventHandler> = new Set();
	private nodeIdCounter = 0;
	private streamHandler: StreamHandler | null = null;

	/**
	 * Generate a unique ID
	 */
	private generateId(prefix: string): string {
		return `${prefix}_${Date.now()}_${++this.nodeIdCounter}`;
	}

	/**
	 * Set the stream handler for AG-UI compatible streaming
	 */
	setStreamHandler(handler: StreamHandler): void {
		this.streamHandler = handler;
	}

	/**
	 * Get the current stream handler
	 */
	getStreamHandler(): StreamHandler | null {
		return this.streamHandler;
	}

	/**
	 * Emit a trajectory event
	 */
	private emit(event: TrajectoryEvent): void {
		for (const handler of this.eventHandlers) {
			try {
				handler(event);
			} catch (error) {
				console.error(
					"[TrajectoryCollector] Event handler error:",
					error,
				);
			}
		}

		// Also emit to stream handler if connected
		if (this.streamHandler) {
			try {
				const trajectory = this.trajectories.get(
					event.data.trajectoryId,
				);
				this.streamHandler.handleTrajectoryEvent(event, trajectory);
			} catch (error) {
				console.error(
					"[TrajectoryCollector] Stream handler error:",
					error,
				);
			}
		}
	}

	/**
	 * Subscribe to trajectory events
	 */
	subscribe(handler: TrajectoryEventHandler): () => void {
		this.eventHandlers.add(handler);
		return () => {
			this.eventHandlers.delete(handler);
		};
	}

	/**
	 * Start a new trajectory
	 */
	startTrajectory(options: CreateTrajectoryOptions = {}): string {
		const id = this.generateId("traj");
		const now = new Date().toISOString();

		// Create root node
		const rootNode: TrajectoryNode = {
			id: this.generateId("node"),
			type: "start",
			label: "Execution Started",
			status: "success",
			timestamp: now,
			children: [],
			metadata: options.metadata,
		};

		const trajectory: AgentTrajectory = {
			id,
			conversationId: options.conversationId,
			nodes: [rootNode],
			edges: [],
			startTime: now,
			status: "running",
			rootNodeId: rootNode.id,
			metadata: options.metadata,
		};

		this.trajectories.set(id, trajectory);

		this.emit({
			type: "trajectory_started",
			timestamp: now,
			data: { trajectoryId: id },
		});

		return id;
	}

	/**
	 * Add a node to a trajectory
	 */
	addNode(
		trajectoryId: string,
		type: TrajectoryNodeType,
		label: string,
		options: AddNodeOptions = {},
	): string {
		const trajectory = this.trajectories.get(trajectoryId);
		if (!trajectory) {
			throw new Error(`Trajectory ${trajectoryId} not found`);
		}

		const nodeId = this.generateId("node");
		const now = new Date().toISOString();

		const node: TrajectoryNode = {
			id: nodeId,
			type,
			label,
			status: "pending",
			timestamp: now,
			parentId: options.parentId,
			children: [],
			metadata: options.metadata,
		};

		trajectory.nodes.push(node);

		// Update parent's children
		if (options.parentId) {
			const parent = trajectory.nodes.find(
				(n) => n.id === options.parentId,
			);
			if (parent) {
				parent.children.push(nodeId);
			}
		}

		// Add edge from parent or root
		const sourceId = options.parentId || trajectory.rootNodeId;
		if (sourceId && sourceId !== nodeId) {
			const edge: TrajectoryEdge = {
				source: sourceId,
				target: nodeId,
				type: "default",
			};
			trajectory.edges.push(edge);

			this.emit({
				type: "edge_added",
				timestamp: now,
				data: { trajectoryId, edge },
			});
		}

		this.emit({
			type: "node_added",
			timestamp: now,
			data: { trajectoryId, node },
		});

		return nodeId;
	}

	/**
	 * Update a node's status and data
	 */
	updateNode(
		trajectoryId: string,
		nodeId: string,
		updates: Partial<
			Pick<
				TrajectoryNode,
				"status" | "output" | "error" | "duration" | "metadata"
			>
		>,
	): void {
		const trajectory = this.trajectories.get(trajectoryId);
		if (!trajectory) {
			throw new Error(`Trajectory ${trajectoryId} not found`);
		}

		const node = trajectory.nodes.find((n) => n.id === nodeId);
		if (!node) {
			throw new Error(
				`Node ${nodeId} not found in trajectory ${trajectoryId}`,
			);
		}

		Object.assign(node, updates);

		this.emit({
			type: "node_updated",
			timestamp: new Date().toISOString(),
			data: { trajectoryId, node },
		});
	}

	/**
	 * Start a node (set status to running)
	 */
	startNode(
		trajectoryId: string,
		nodeId: string,
		input?: Record<string, unknown>,
	): void {
		this.updateNode(trajectoryId, nodeId, {
			status: "running" as TrajectoryNodeStatus,
		});

		const trajectory = this.trajectories.get(trajectoryId);
		const node = trajectory?.nodes.find((n) => n.id === nodeId);
		if (node && input) {
			node.input = input;
		}
	}

	/**
	 * Complete a node successfully
	 */
	completeNode(
		trajectoryId: string,
		nodeId: string,
		output?: Record<string, unknown>,
	): void {
		const trajectory = this.trajectories.get(trajectoryId);
		const node = trajectory?.nodes.find((n) => n.id === nodeId);

		let duration: number | undefined;
		if (node) {
			const startTime = new Date(node.timestamp).getTime();
			duration = Date.now() - startTime;
		}

		this.updateNode(trajectoryId, nodeId, {
			status: "success" as TrajectoryNodeStatus,
			output,
			duration,
		});
	}

	/**
	 * Mark a node as failed
	 */
	failNode(trajectoryId: string, nodeId: string, error: string): void {
		const trajectory = this.trajectories.get(trajectoryId);
		const node = trajectory?.nodes.find((n) => n.id === nodeId);

		let duration: number | undefined;
		if (node) {
			const startTime = new Date(node.timestamp).getTime();
			duration = Date.now() - startTime;
		}

		this.updateNode(trajectoryId, nodeId, {
			status: "error" as TrajectoryNodeStatus,
			error,
			duration,
		});
	}

	/**
	 * Add an agent invocation node
	 */
	addAgentNode(
		trajectoryId: string,
		agentId: string,
		agentName: string,
		parentId?: string,
	): string {
		const nodeId = this.addNode(
			trajectoryId,
			"agent",
			`Agent: ${agentName}`,
			{
				parentId,
			},
		);

		const trajectory = this.trajectories.get(trajectoryId);
		const node = trajectory?.nodes.find((n) => n.id === nodeId);
		if (node) {
			node.agentId = agentId;
			node.agentName = agentName;
		}

		return nodeId;
	}

	/**
	 * Add a tool call node
	 */
	addToolCallNode(
		trajectoryId: string,
		toolName: string,
		args: Record<string, unknown>,
		parentId?: string,
	): string {
		const nodeId = this.addNode(
			trajectoryId,
			"tool_call",
			`Tool: ${toolName}`,
			{
				parentId,
				metadata: { toolName },
			},
		);

		const trajectory = this.trajectories.get(trajectoryId);
		const node = trajectory?.nodes.find((n) => n.id === nodeId);
		if (node) {
			node.toolName = toolName;
			node.input = args;
		}

		return nodeId;
	}

	/**
	 * Add a tool result node
	 */
	addToolResultNode(
		trajectoryId: string,
		toolName: string,
		result: unknown,
		parentId: string,
	): string {
		const nodeId = this.addNode(
			trajectoryId,
			"tool_result",
			`Result: ${toolName}`,
			{
				parentId,
			},
		);

		const trajectory = this.trajectories.get(trajectoryId);
		const node = trajectory?.nodes.find((n) => n.id === nodeId);
		if (node) {
			node.toolName = toolName;
			node.output = { result };
			node.status = "success";
		}

		return nodeId;
	}

	/**
	 * Add a decision/routing node
	 */
	addDecisionNode(
		trajectoryId: string,
		label: string,
		decision: string,
		parentId?: string,
	): string {
		const nodeId = this.addNode(trajectoryId, "decision", label, {
			parentId,
		});

		const trajectory = this.trajectories.get(trajectoryId);
		const node = trajectory?.nodes.find((n) => n.id === nodeId);
		if (node) {
			node.output = { decision };
			node.status = "success";
		}

		return nodeId;
	}

	/**
	 * Add a HITL (Human-in-the-Loop) node
	 */
	addHITLNode(
		trajectoryId: string,
		prompt: string,
		requestType: "approval" | "input" | "choice",
		parentId?: string,
		options?: {
			requestId?: string;
			choices?: Array<{ value: string; label: string }>;
		},
	): string {
		const nodeId = this.addNode(
			trajectoryId,
			"hitl",
			`Waiting for: ${requestType}`,
			{
				parentId,
			},
		);

		const trajectory = this.trajectories.get(trajectoryId);
		const node = trajectory?.nodes.find((n) => n.id === nodeId);
		if (node) {
			node.status = "waiting";
			node.input = { prompt, requestType };
		}

		// Emit HITL request to stream handler
		if (this.streamHandler && options?.requestId) {
			this.streamHandler.emitHITLRequest(
				trajectoryId,
				options.requestId,
				requestType,
				prompt,
				options.choices,
			);
		}

		return nodeId;
	}

	/**
	 * Complete a HITL node with user response
	 */
	completeHITLNode(
		trajectoryId: string,
		nodeId: string,
		approved: boolean,
		value?: unknown,
		requestId?: string,
	): void {
		const trajectory = this.trajectories.get(trajectoryId);
		const node = trajectory?.nodes.find((n) => n.id === nodeId);

		if (node) {
			const startTime = new Date(node.timestamp).getTime();
			const duration = Date.now() - startTime;

			this.updateNode(trajectoryId, nodeId, {
				status: approved ? "success" : "error",
				output: { approved, value },
				duration,
			});

			// Emit HITL response to stream handler
			if (this.streamHandler && requestId) {
				this.streamHandler.emitHITLResponse(
					trajectoryId,
					requestId,
					approved,
					value,
				);
			}
		}
	}

	/**
	 * Complete the trajectory successfully
	 */
	completeTrajectory(trajectoryId: string): void {
		const trajectory = this.trajectories.get(trajectoryId);
		if (!trajectory) {
			throw new Error(`Trajectory ${trajectoryId} not found`);
		}

		const now = new Date().toISOString();

		// Add end node
		const endNodeId = this.generateId("node");
		const endNode: TrajectoryNode = {
			id: endNodeId,
			type: "end",
			label: "Execution Completed",
			status: "success",
			timestamp: now,
			children: [],
		};
		trajectory.nodes.push(endNode);

		// Update trajectory
		trajectory.endTime = now;
		trajectory.status = "completed";
		trajectory.totalDuration =
			new Date(now).getTime() - new Date(trajectory.startTime).getTime();

		// Calculate summary
		trajectory.summary = {
			totalNodes: trajectory.nodes.length,
			successfulNodes: trajectory.nodes.filter(
				(n) => n.status === "success",
			).length,
			failedNodes: trajectory.nodes.filter((n) => n.status === "error")
				.length,
			toolCallsCount: trajectory.nodes.filter(
				(n) => n.type === "tool_call",
			).length,
			agentsInvoked: [
				...new Set(
					trajectory.nodes
						.filter((n) => n.agentId)
						// biome-ignore lint/style/noNonNullAssertion: filter above guarantees agentId is defined
						.map((n) => n.agentId!),
				),
			],
		};

		this.emit({
			type: "trajectory_completed",
			timestamp: now,
			data: { trajectoryId, status: "completed" },
		});
	}

	/**
	 * Mark the trajectory as failed
	 */
	failTrajectory(trajectoryId: string, error: string): void {
		const trajectory = this.trajectories.get(trajectoryId);
		if (!trajectory) {
			throw new Error(`Trajectory ${trajectoryId} not found`);
		}

		const now = new Date().toISOString();

		// Add error node
		const errorNodeId = this.generateId("node");
		const errorNode: TrajectoryNode = {
			id: errorNodeId,
			type: "error",
			label: "Execution Failed",
			status: "error",
			timestamp: now,
			error,
			children: [],
		};
		trajectory.nodes.push(errorNode);

		// Update trajectory
		trajectory.endTime = now;
		trajectory.status = "failed";
		trajectory.totalDuration =
			new Date(now).getTime() - new Date(trajectory.startTime).getTime();

		this.emit({
			type: "trajectory_failed",
			timestamp: now,
			data: { trajectoryId, status: "failed" },
		});
	}

	/**
	 * Get a trajectory by ID
	 */
	getTrajectory(trajectoryId: string): AgentTrajectory | undefined {
		return this.trajectories.get(trajectoryId);
	}

	/**
	 * Get all trajectories
	 */
	getAllTrajectories(): AgentTrajectory[] {
		return Array.from(this.trajectories.values());
	}

	/**
	 * Clear a trajectory
	 */
	clearTrajectory(trajectoryId: string): void {
		this.trajectories.delete(trajectoryId);
	}

	/**
	 * Clear all trajectories
	 */
	clearAll(): void {
		this.trajectories.clear();
	}

	/**
	 * Export trajectory as JSON for persistence
	 */
	exportTrajectory(trajectoryId: string): string {
		const trajectory = this.trajectories.get(trajectoryId);
		if (!trajectory) {
			throw new Error(`Trajectory ${trajectoryId} not found`);
		}
		return JSON.stringify(trajectory, null, 2);
	}

	/**
	 * Import a trajectory from JSON
	 */
	importTrajectory(json: string): string {
		const trajectory: AgentTrajectory = JSON.parse(json);
		this.trajectories.set(trajectory.id, trajectory);
		return trajectory.id;
	}
}

/**
 * Singleton instance for global trajectory collection
 */
export const globalTrajectoryCollector = new TrajectoryCollector();
