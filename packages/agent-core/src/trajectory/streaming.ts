/**
 * Trajectory Streaming Utilities
 *
 * Provides AG-UI compatible streaming for trajectory events.
 * This bridges the internal trajectory collector events to the
 * AG-UI protocol for real-time UI updates.
 */

import type { AGUIEvent } from "../ag-ui-protocol";
import type { AgentTrajectory, TrajectoryEvent, TrajectoryNode } from "./types";

/**
 * Event types for trajectory streaming
 */
export type TrajectoryStreamEventType =
	| "TRAJECTORY_STARTED"
	| "TRAJECTORY_NODE_ADDED"
	| "TRAJECTORY_NODE_UPDATED"
	| "TRAJECTORY_EDGE_ADDED"
	| "TRAJECTORY_COMPLETED"
	| "TRAJECTORY_FAILED"
	| "HITL_REQUEST"
	| "HITL_RESPONSE";

/**
 * Extended AG-UI event for trajectory streaming
 */
export interface TrajectoryStreamEvent extends AGUIEvent {
	type: "STATE_DELTA";
	payload: {
		state_key: "trajectory";
		value: {
			eventType: TrajectoryStreamEventType;
			trajectoryId: string;
			node?: TrajectoryNode;
			edge?: { source: string; target: string; type: string };
			status?: string;
			trajectory?: AgentTrajectory;
			hitlRequest?: {
				requestId: string;
				requestType: "approval" | "input" | "choice";
				prompt: string;
				options?: Array<{ value: string; label: string }>;
			};
			hitlResponse?: {
				requestId: string;
				approved: boolean;
				value?: unknown;
			};
		};
		predictive: boolean;
		merge_strategy: "merge";
	};
}

/**
 * Create an AG-UI event from a trajectory event
 */
export function trajectoryEventToAGUI(
	trajectoryEvent: TrajectoryEvent,
	trajectory?: AgentTrajectory,
): TrajectoryStreamEvent {
	const eventTypeMap: Record<
		TrajectoryEvent["type"],
		TrajectoryStreamEventType
	> = {
		trajectory_started: "TRAJECTORY_STARTED",
		trajectory_completed: "TRAJECTORY_COMPLETED",
		trajectory_failed: "TRAJECTORY_FAILED",
		node_added: "TRAJECTORY_NODE_ADDED",
		node_updated: "TRAJECTORY_NODE_UPDATED",
		edge_added: "TRAJECTORY_EDGE_ADDED",
	};

	// Normalize edge to match expected type (with required type field)
	const normalizedEdge = trajectoryEvent.data.edge
		? {
				source: trajectoryEvent.data.edge.source,
				target: trajectoryEvent.data.edge.target,
				type: (trajectoryEvent.data.edge.type ?? "flow") as string,
			}
		: undefined;

	return {
		type: "STATE_DELTA",
		payload: {
			state_key: "trajectory",
			value: {
				eventType: eventTypeMap[trajectoryEvent.type],
				trajectoryId: trajectoryEvent.data.trajectoryId,
				node: trajectoryEvent.data.node,
				edge: normalizedEdge,
				status: trajectoryEvent.data.status,
				trajectory,
			},
			predictive: false,
			merge_strategy: "merge",
		},
		timestamp: new Date(trajectoryEvent.timestamp),
	};
}

/**
 * Create a HITL request event for trajectory
 */
export function createHITLRequestTrajectoryEvent(
	trajectoryId: string,
	requestId: string,
	requestType: "approval" | "input" | "choice",
	prompt: string,
	options?: Array<{ value: string; label: string }>,
): TrajectoryStreamEvent {
	return {
		type: "STATE_DELTA",
		payload: {
			state_key: "trajectory",
			value: {
				eventType: "HITL_REQUEST",
				trajectoryId,
				hitlRequest: {
					requestId,
					requestType,
					prompt,
					options,
				},
			},
			predictive: false,
			merge_strategy: "merge",
		},
		timestamp: new Date(),
	};
}

/**
 * Create a HITL response event for trajectory
 */
export function createHITLResponseTrajectoryEvent(
	trajectoryId: string,
	requestId: string,
	approved: boolean,
	value?: unknown,
): TrajectoryStreamEvent {
	return {
		type: "STATE_DELTA",
		payload: {
			state_key: "trajectory",
			value: {
				eventType: "HITL_RESPONSE",
				trajectoryId,
				hitlResponse: {
					requestId,
					approved,
					value,
				},
			},
			predictive: false,
			merge_strategy: "merge",
		},
		timestamp: new Date(),
	};
}

/**
 * Trajectory Stream Handler
 *
 * Manages streaming trajectory events to connected clients
 */
export class TrajectoryStreamHandler {
	private listeners: Map<
		string,
		Set<(event: TrajectoryStreamEvent) => void>
	> = new Map();

	/**
	 * Subscribe to trajectory events for a specific trajectory
	 */
	subscribe(
		trajectoryId: string,
		callback: (event: TrajectoryStreamEvent) => void,
	): () => void {
		if (!this.listeners.has(trajectoryId)) {
			this.listeners.set(trajectoryId, new Set());
		}
		this.listeners.get(trajectoryId)?.add(callback);

		return () => {
			this.listeners.get(trajectoryId)?.delete(callback);
			if (this.listeners.get(trajectoryId)?.size === 0) {
				this.listeners.delete(trajectoryId);
			}
		};
	}

	/**
	 * Subscribe to all trajectory events
	 */
	subscribeAll(callback: (event: TrajectoryStreamEvent) => void): () => void {
		const globalKey = "__all__";
		if (!this.listeners.has(globalKey)) {
			this.listeners.set(globalKey, new Set());
		}
		this.listeners.get(globalKey)?.add(callback);

		return () => {
			this.listeners.get(globalKey)?.delete(callback);
		};
	}

	/**
	 * Emit an event to all subscribers
	 */
	emit(event: TrajectoryStreamEvent): void {
		const trajectoryId = event.payload.value.trajectoryId;

		// Notify specific trajectory subscribers
		const specificListeners = this.listeners.get(trajectoryId);
		if (specificListeners) {
			for (const listener of specificListeners) {
				try {
					listener(event);
				} catch (error) {
					console.error(
						"[TrajectoryStreamHandler] Listener error:",
						error,
					);
				}
			}
		}

		// Notify global subscribers
		const globalListeners = this.listeners.get("__all__");
		if (globalListeners) {
			for (const listener of globalListeners) {
				try {
					listener(event);
				} catch (error) {
					console.error(
						"[TrajectoryStreamHandler] Global listener error:",
						error,
					);
				}
			}
		}
	}

	/**
	 * Handle a trajectory event from the collector
	 */
	handleTrajectoryEvent(
		event: TrajectoryEvent,
		trajectory?: AgentTrajectory,
	): void {
		const aguiEvent = trajectoryEventToAGUI(event, trajectory);
		this.emit(aguiEvent);
	}

	/**
	 * Emit HITL request event
	 */
	emitHITLRequest(
		trajectoryId: string,
		requestId: string,
		requestType: "approval" | "input" | "choice",
		prompt: string,
		options?: Array<{ value: string; label: string }>,
	): void {
		const event = createHITLRequestTrajectoryEvent(
			trajectoryId,
			requestId,
			requestType,
			prompt,
			options,
		);
		this.emit(event);
	}

	/**
	 * Emit HITL response event
	 */
	emitHITLResponse(
		trajectoryId: string,
		requestId: string,
		approved: boolean,
		value?: unknown,
	): void {
		const event = createHITLResponseTrajectoryEvent(
			trajectoryId,
			requestId,
			approved,
			value,
		);
		this.emit(event);
	}

	/**
	 * Clear all listeners
	 */
	clear(): void {
		this.listeners.clear();
	}
}

/**
 * Global trajectory stream handler instance
 */
export const globalTrajectoryStreamHandler = new TrajectoryStreamHandler();
