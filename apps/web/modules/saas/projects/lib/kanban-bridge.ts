"use client";

// Message types matching kanban's postmessage-protocol.ts
const FabricToKanbanMessageType = {
	HANDSHAKE: "fabric:handshake",
	LOAD_WORKSPACE: "fabric:load-workspace",
	SELECT_TASK: "fabric:select-task",
	CREATE_TASK: "fabric:create-task",
	UPDATE_TASK: "fabric:update-task",
	DELETE_TASK: "fabric:delete-task",
	UPDATE_CONFIG: "fabric:update-config",
	REFRESH: "fabric:refresh",
	PULL_FROM_FABRIC: "fabric:pull",
} as const;

const KanbanToFabricMessageType = {
	READY: "kanban:ready",
	DISCOVER: "kanban:discover",
	TASK_CREATED: "kanban:task-created",
	TASK_UPDATED: "kanban:task-updated",
	TASK_STARTED: "kanban:task-started",
	TASK_COMPLETED: "kanban:task-completed",
	ERROR: "kanban:error",
	CLOSE: "kanban:close",
	STATUS_CHANGED: "kanban:status-changed",
	PULL_COMPLETE: "kanban:pull-complete",
} as const;

interface FabricKanbanMessage {
	type: string;
	payload?: unknown;
	id?: string;
	timestamp: number;
}

interface KanbanBridgeOptions {
	onTaskCreated?: (taskId: string, taskData: unknown) => void;
	onTaskUpdated?: (taskId: string, taskData: unknown) => void;
	onTaskStarted?: (taskId: string) => void;
	onTaskCompleted?: (taskId: string, result?: unknown) => void;
	onError?: (error: string) => void;
	onClose?: () => void;
	onReady?: () => void;
	onPullComplete?: (pulled: number) => void;
}

/**
 * Singleton service for managing PostMessage communication with kanban iframe.
 * Handles message queuing, handshake protocol, and bidirectional communication.
 */
class KanbanBridgeService {
	private iframe: HTMLIFrameElement | null = null;
	private messageQueue: FabricKanbanMessage[] = [];
	private isReady = false;
	private listeners: Set<(message: FabricKanbanMessage) => void> = new Set();
	private options: KanbanBridgeOptions = {};

	/**
	 * Connect to a kanban iframe
	 */
	connect(
		iframe: HTMLIFrameElement,
		options: KanbanBridgeOptions = {},
	): void {
		this.iframe = iframe;
		this.options = options;

		// Set up message listener
		window.addEventListener("message", this.handleMessage);

		// Flush any queued messages once connected
		this.flushQueue();
	}

	/**
	 * Disconnect from the iframe and clean up
	 */
	disconnect(): void {
		window.removeEventListener("message", this.handleMessage);
		this.iframe = null;
		this.isReady = false;
		this.messageQueue = [];
		this.listeners.clear();
	}

	/**
	 * Send a message to the kanban iframe
	 */
	sendMessage(type: string, payload?: unknown): void {
		const message: FabricKanbanMessage = {
			type,
			payload,
			id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
			timestamp: Date.now(),
		};

		if (!this.isReady || !this.iframe?.contentWindow) {
			// Queue message until kanban is ready
			this.messageQueue.push(message);
			return;
		}

		this.postMessage(message);
	}

	/**
	 * Load a specific workspace in kanban
	 */
	loadWorkspace(workspaceId: string, projectId?: string): void {
		this.sendMessage(FabricToKanbanMessageType.LOAD_WORKSPACE, {
			workspaceId,
			projectId,
		});
	}

	/**
	 * Select a specific task in kanban
	 */
	selectTask(taskId: string): void {
		this.sendMessage(FabricToKanbanMessageType.SELECT_TASK, { taskId });
	}

	/**
	 * Create a new task in kanban
	 */
	createTask(title: string, description?: string, prompt?: string): void {
		this.sendMessage(FabricToKanbanMessageType.CREATE_TASK, {
			title,
			description,
			prompt,
		});
	}

	/**
	 * Update a task in kanban
	 */
	updateTask(taskId: string, updates: Record<string, unknown>): void {
		this.sendMessage(FabricToKanbanMessageType.UPDATE_TASK, {
			taskId,
			updates,
		});
	}

	/**
	 * Delete a task in kanban
	 */
	deleteTask(taskId: string): void {
		this.sendMessage(FabricToKanbanMessageType.DELETE_TASK, { taskId });
	}

	/**
	 * Request kanban to refresh its data
	 */
	refresh(): void {
		this.sendMessage(FabricToKanbanMessageType.REFRESH);
	}

	/**
	 * Trigger a pull from Fabric portal (syncs queued features into kanban)
	 */
	pullFromFabric(): void {
		this.sendMessage(FabricToKanbanMessageType.PULL_FROM_FABRIC);
	}

	/**
	 * Update embedded mode configuration
	 */
	updateConfig(config: {
		allowedActions?: string[];
		readOnly?: boolean;
		/** Sidebar display mode: false = hidden, "collapsed" = collapsed, "expanded" = expanded */
		sidebar?: false | "collapsed" | "expanded";
		/** Whether to show the TopBar in embed mode */
		showTopBar?: boolean;
	}): void {
		this.sendMessage(FabricToKanbanMessageType.UPDATE_CONFIG, config);
	}

	/**
	 * Subscribe to messages from kanban
	 */
	subscribe(listener: (message: FabricKanbanMessage) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Get current connection status
	 */
	getStatus(): { isReady: boolean; queueLength: number } {
		return {
			isReady: this.isReady,
			queueLength: this.messageQueue.length,
		};
	}

	/**
	 * Handle incoming messages from kanban
	 */
	private handleMessage = (event: MessageEvent): void => {
		// Validate origin - must be from kanban localhost
		if (event.origin !== "http://localhost:3484") {
			return;
		}

		const message = event.data as FabricKanbanMessage;

		// Validate message structure
		if (!message || typeof message.type !== "string") {
			return;
		}

		// Notify all subscribers
		this.listeners.forEach((listener) => {
			listener(message);
		});

		// Handle specific message types
		switch (message.type) {
			case KanbanToFabricMessageType.READY:
				this.isReady = true;
				this.flushQueue();
				this.options.onReady?.();
				break;

			case KanbanToFabricMessageType.TASK_CREATED:
				if (message.payload && typeof message.payload === "object") {
					const { taskId, taskData } = message.payload as {
						taskId: string;
						taskData: unknown;
					};
					this.options.onTaskCreated?.(taskId, taskData);
				}
				break;

			case KanbanToFabricMessageType.TASK_UPDATED:
				if (message.payload && typeof message.payload === "object") {
					const { taskId, taskData } = message.payload as {
						taskId: string;
						taskData: unknown;
					};
					this.options.onTaskUpdated?.(taskId, taskData);
				}
				break;

			case KanbanToFabricMessageType.TASK_STARTED:
				if (message.payload && typeof message.payload === "object") {
					const { taskId } = message.payload as { taskId: string };
					this.options.onTaskStarted?.(taskId);
				}
				break;

			case KanbanToFabricMessageType.TASK_COMPLETED:
				if (message.payload && typeof message.payload === "object") {
					const { taskId, result } = message.payload as {
						taskId: string;
						result?: unknown;
					};
					this.options.onTaskCompleted?.(taskId, result);
				}
				break;

			case KanbanToFabricMessageType.ERROR:
				if (message.payload && typeof message.payload === "object") {
					const { error } = message.payload as { error: string };
					this.options.onError?.(error);
				}
				break;

			case KanbanToFabricMessageType.CLOSE:
				this.options.onClose?.();
				break;

			case KanbanToFabricMessageType.PULL_COMPLETE:
				if (message.payload && typeof message.payload === "object") {
					const { pulled } = message.payload as { pulled: number };
					this.options.onPullComplete?.(pulled);
				}
				break;
		}
	};

	/**
	 * Post a message to the kanban iframe
	 */
	private postMessage(message: FabricKanbanMessage): void {
		if (this.iframe?.contentWindow) {
			this.iframe.contentWindow.postMessage(
				message,
				"http://localhost:3484",
			);
		}
	}

	/**
	 * Flush queued messages once kanban is ready
	 */
	private flushQueue(): void {
		if (!this.isReady || this.messageQueue.length === 0) {
			return;
		}

		while (this.messageQueue.length > 0) {
			const message = this.messageQueue.shift();
			if (message) {
				this.postMessage(message);
			}
		}
	}
}

// Singleton instance
export const kanbanBridge = new KanbanBridgeService();
