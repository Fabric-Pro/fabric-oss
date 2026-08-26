/**
 * A2A Protocol Server
 *
 * A server wrapper that exposes any agent (LangGraph, custom, etc.) via A2A protocol.
 * This enables the orchestrator to communicate with agents using a unified protocol
 * regardless of the underlying agent framework.
 *
 * Endpoints exposed:
 * - GET /.well-known/agent-card.json - Agent card discovery (v0.3.0)
 * - GET /.well-known/agent.json - Agent card discovery (legacy)
 * - POST /a2a/send - Send message (synchronous)
 * - POST /a2a/send/stream - Send message (streaming SSE)
 * - GET /a2a/tasks/:taskId - Get task status
 * - POST /a2a/tasks/:taskId/cancel - Cancel task
 * - GET /health - Health check
 *
 * @see https://a2a-protocol.org/latest/specification/
 */

import { v4 as uuidv4 } from "uuid";
import type {
	A2AError,
	A2AMessage,
	A2ATask,
	AgentCard,
	AgentSkill,
	Artifact,
	TaskEvent,
	TaskStatus,
} from "./types";

/**
 * Agent executor function type
 * Implement this to connect your agent to A2A
 */
export interface A2AAgentExecutor {
	/**
	 * Execute a task with the given message
	 * @param message The user message
	 * @param contextId Optional context ID for multi-turn conversations
	 * @param metadata Optional metadata
	 * @returns The task result with artifacts
	 */
	execute(
		message: A2AMessage,
		contextId?: string,
		metadata?: Record<string, unknown>,
	): Promise<A2AExecutionResult>;

	/**
	 * Execute with streaming (optional)
	 * If not implemented, the server will use execute() and wrap the result
	 */
	executeStream?(
		message: A2AMessage,
		contextId?: string,
		metadata?: Record<string, unknown>,
	): AsyncGenerator<A2AStreamEvent>;

	/**
	 * Cancel a running task (optional)
	 */
	cancel?(taskId: string): Promise<void>;
}

export interface A2AExecutionResult {
	/** Response text from the agent */
	response: string;
	/** Structured artifacts (documents, data, etc.) */
	artifacts?: Artifact[];
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

export interface A2AStreamEvent {
	type: "text" | "artifact" | "status" | "error";
	/** Text chunk for streaming */
	text?: string;
	/** Artifact being produced */
	artifact?: Artifact;
	/** Status update */
	status?: TaskStatus;
	/** Error details */
	error?: A2AError;
}

/**
 * A2A Server configuration
 */
export interface A2AServerConfig {
	/** Agent name (unique identifier) */
	name: string;
	/** Human-readable description */
	description: string;
	/** Base URL where this agent is deployed */
	url: string;
	/** Agent skills/capabilities */
	skills: AgentSkill[];
	/** Protocol version (default: "0.3.0") */
	protocolVersion?: string;
	/** Whether streaming is supported */
	supportsStreaming?: boolean;
	/** Custom tags for discovery */
	tags?: string[];
	/** Port to listen on */
	port?: number;

	// =============================================================================
	// Generalist Agent Capabilities
	// =============================================================================

	/** Whether this agent can handle complete tasks autonomously */
	autonomousExecution?: boolean;
	/** Whether this agent has internal task decomposition and planning */
	taskDecomposition?: boolean;
	/** Whether this agent preserves context across subtasks/steps */
	contextPreservation?: boolean;
	/** Whether this agent can execute code */
	codeExecution?: boolean;
	/** Whether this agent can automate browser interactions */
	browserAutomation?: boolean;
	/** Whether this agent has persistent memory */
	memoryEnabled?: boolean;
	/** Whether this agent is aware of Fabric's multi-tenancy */
	multiTenancyAware?: boolean;
	/** Maximum autonomy level: 'step' | 'subtask' | 'task' | 'session' */
	maxAutonomyLevel?: "step" | "subtask" | "task" | "session";
}

/**
 * In-memory task store
 * For production, replace with a persistent store (Redis, database, etc.)
 */
interface TaskStore {
	tasks: Map<string, A2ATask>;
	get(taskId: string): A2ATask | undefined;
	set(task: A2ATask): void;
	update(taskId: string, updates: Partial<A2ATask>): A2ATask | undefined;
	delete(taskId: string): boolean;
}

function createTaskStore(): TaskStore {
	const tasks = new Map<string, A2ATask>();
	return {
		tasks,
		get: (taskId) => tasks.get(taskId),
		set: (task) => tasks.set(task.id, task),
		update: (taskId, updates) => {
			const task = tasks.get(taskId);
			if (task) {
				const updated = {
					...task,
					...updates,
					updatedAt: new Date().toISOString(),
				};
				tasks.set(taskId, updated);
				return updated;
			}
			return undefined;
		},
		delete: (taskId) => tasks.delete(taskId),
	};
}

/**
 * A2A Protocol Server
 *
 * Wraps any agent executor and exposes it via A2A protocol endpoints.
 */
export class A2AServer {
	private config: A2AServerConfig;
	private executor: A2AAgentExecutor;
	private taskStore: TaskStore;
	private agentCard: AgentCard;

	constructor(config: A2AServerConfig, executor: A2AAgentExecutor) {
		this.config = config;
		this.executor = executor;
		this.taskStore = createTaskStore();
		this.agentCard = this.buildAgentCard();
	}

	private buildAgentCard(): AgentCard {
		return {
			name: this.config.name,
			description: this.config.description,
			url: this.config.url,
			protocolVersion: this.config.protocolVersion || "0.3.0",
			capabilities: {
				streaming:
					this.config.supportsStreaming ??
					!!this.executor.executeStream,
				pushNotifications: false,
				stateTransitionHistory: true,
				// Generalist agent capabilities
				autonomousExecution: this.config.autonomousExecution,
				taskDecomposition: this.config.taskDecomposition,
				contextPreservation: this.config.contextPreservation,
				codeExecution: this.config.codeExecution,
				browserAutomation: this.config.browserAutomation,
				memoryEnabled: this.config.memoryEnabled,
				multiTenancyAware: this.config.multiTenancyAware,
				maxAutonomyLevel: this.config.maxAutonomyLevel,
			},
			skills: this.config.skills,
			defaultInputModes: ["text"],
			defaultOutputModes: ["text"],
		};
	}

	/**
	 * Get the agent card for discovery
	 */
	getAgentCard(): AgentCard {
		return this.agentCard;
	}

	/**
	 * Handle GET /.well-known/agent.json
	 */
	handleAgentCardRequest(): Response {
		return new Response(JSON.stringify(this.agentCard), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	/**
	 * Handle POST /a2a/send
	 */
	async handleSendMessage(
		message: A2AMessage,
		contextId?: string,
		metadata?: Record<string, unknown>,
	): Promise<A2ATask> {
		const taskId = uuidv4();
		const now = new Date().toISOString();

		// Create initial task
		const task: A2ATask = {
			id: taskId,
			contextId,
			status: "submitted",
			messages: [message],
			artifacts: [],
			metadata,
			createdAt: now,
			updatedAt: now,
		};
		this.taskStore.set(task);

		// Update to working
		this.taskStore.update(taskId, { status: "working" });

		try {
			// Execute the agent
			const result = await this.executor.execute(
				message,
				contextId,
				metadata,
			);

			// Build response message
			const responseMessage: A2AMessage = {
				role: "agent",
				parts: [{ type: "text", text: result.response }],
				metadata: result.metadata,
			};

			// Update task with result
			const completedTask = this.taskStore.update(taskId, {
				status: "completed",
				messages: [message, responseMessage],
				artifacts: result.artifacts || [],
			});

			return completedTask || task;
		} catch (error) {
			// Update task with error
			const failedTask = this.taskStore.update(taskId, {
				status: "failed",
				metadata: {
					...metadata,
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
			});
			return failedTask || task;
		}
	}

	/**
	 * Handle POST /a2a/send/stream
	 * Returns an SSE stream of TaskEvents
	 */
	async *handleSendMessageStream(
		message: A2AMessage,
		contextId?: string,
		metadata?: Record<string, unknown>,
	): AsyncGenerator<TaskEvent> {
		const taskId = uuidv4();
		const now = new Date().toISOString();

		// Create initial task
		const task: A2ATask = {
			id: taskId,
			contextId,
			status: "submitted",
			messages: [message],
			artifacts: [],
			metadata,
			createdAt: now,
			updatedAt: now,
		};
		this.taskStore.set(task);

		// Emit submitted status
		yield {
			type: "status",
			taskId,
			status: "submitted",
			timestamp: now,
		};

		// Update to working
		this.taskStore.update(taskId, { status: "working" });
		yield {
			type: "status",
			taskId,
			status: "working",
			timestamp: new Date().toISOString(),
		};

		try {
			// Check if streaming is supported
			if (this.executor.executeStream) {
				// Use streaming executor
				let fullText = "";
				const artifacts: Artifact[] = [];

				for await (const event of this.executor.executeStream(
					message,
					contextId,
					metadata,
				)) {
					if (event.type === "text" && event.text) {
						fullText += event.text;
						// Emit text as a message event
						yield {
							type: "message",
							taskId,
							message: {
								role: "agent",
								parts: [{ type: "text", text: event.text }],
							},
							timestamp: new Date().toISOString(),
						};
					} else if (event.type === "artifact" && event.artifact) {
						artifacts.push(event.artifact);
						yield {
							type: "artifact",
							taskId,
							artifact: event.artifact,
							timestamp: new Date().toISOString(),
						};
					} else if (event.type === "error" && event.error) {
						yield {
							type: "error",
							taskId,
							error: event.error,
							timestamp: new Date().toISOString(),
						};
					}
				}

				// Update task with final result
				const responseMessage: A2AMessage = {
					role: "agent",
					parts: [{ type: "text", text: fullText }],
				};
				this.taskStore.update(taskId, {
					status: "completed",
					messages: [message, responseMessage],
					artifacts,
				});
			} else {
				// Fall back to non-streaming
				const result = await this.executor.execute(
					message,
					contextId,
					metadata,
				);

				// Emit response as message
				yield {
					type: "message",
					taskId,
					message: {
						role: "agent",
						parts: [{ type: "text", text: result.response }],
						metadata: result.metadata,
					},
					timestamp: new Date().toISOString(),
				};

				// Emit artifacts
				for (const artifact of result.artifacts || []) {
					yield {
						type: "artifact",
						taskId,
						artifact,
						timestamp: new Date().toISOString(),
					};
				}

				// Update task
				this.taskStore.update(taskId, {
					status: "completed",
					messages: [
						message,
						{
							role: "agent",
							parts: [{ type: "text", text: result.response }],
							metadata: result.metadata,
						},
					],
					artifacts: result.artifacts || [],
				});
			}

			// Emit completed status
			yield {
				type: "status",
				taskId,
				status: "completed",
				timestamp: new Date().toISOString(),
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";

			// Update task with error
			this.taskStore.update(taskId, {
				status: "failed",
				metadata: { ...metadata, error: errorMessage },
			});

			// Emit error event
			yield {
				type: "error",
				taskId,
				error: {
					code: "EXECUTION_FAILED",
					message: errorMessage,
				},
				timestamp: new Date().toISOString(),
			};

			// Emit failed status
			yield {
				type: "status",
				taskId,
				status: "failed",
				timestamp: new Date().toISOString(),
			};
		}
	}

	/**
	 * Handle GET /a2a/tasks/:taskId
	 */
	getTask(taskId: string): A2ATask | undefined {
		return this.taskStore.get(taskId);
	}

	/**
	 * Handle POST /a2a/tasks/:taskId/cancel
	 */
	async cancelTask(taskId: string): Promise<boolean> {
		const task = this.taskStore.get(taskId);
		if (!task) {
			return false;
		}

		if (
			task.status === "completed" ||
			task.status === "failed" ||
			task.status === "canceled"
		) {
			return false; // Cannot cancel finished tasks
		}

		// Try to cancel via executor if supported
		if (this.executor.cancel) {
			try {
				await this.executor.cancel(taskId);
			} catch (error) {
				console.error(`Failed to cancel task ${taskId}:`, error);
			}
		}

		this.taskStore.update(taskId, { status: "canceled" });
		return true;
	}

	/**
	 * Create Express/Hono-compatible request handlers
	 * This returns an object with handler functions for each endpoint
	 */
	createHandlers() {
		return {
			// GET /.well-known/agent.json
			getAgentCard: () => this.handleAgentCardRequest(),

			// POST /a2a/send
			sendMessage: async (body: {
				message: A2AMessage;
				contextId?: string;
				metadata?: Record<string, unknown>;
			}) => {
				const task = await this.handleSendMessage(
					body.message,
					body.contextId,
					body.metadata,
				);
				return new Response(JSON.stringify({ task }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},

			// POST /a2a/send/stream
			sendMessageStream: (body: {
				message: A2AMessage;
				contextId?: string;
				metadata?: Record<string, unknown>;
			}) => {
				const encoder = new TextEncoder();
				const generator = this.handleSendMessageStream(
					body.message,
					body.contextId,
					body.metadata,
				);

				const stream = new ReadableStream({
					async start(controller) {
						try {
							for await (const event of generator) {
								const data = `data: ${JSON.stringify(event)}\n\n`;
								controller.enqueue(encoder.encode(data));
							}
							controller.enqueue(
								encoder.encode("data: [DONE]\n\n"),
							);
							controller.close();
						} catch (error) {
							controller.error(error);
						}
					},
				});

				return new Response(stream, {
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
				});
			},

			// GET /a2a/tasks/:taskId
			getTask: (taskId: string) => {
				const task = this.getTask(taskId);
				if (!task) {
					return new Response(
						JSON.stringify({ error: "Task not found" }),
						{
							status: 404,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				return new Response(JSON.stringify(task), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},

			// POST /a2a/tasks/:taskId/cancel
			cancelTask: async (taskId: string) => {
				const success = await this.cancelTask(taskId);
				if (!success) {
					return new Response(
						JSON.stringify({
							error: "Task not found or cannot be canceled",
						}),
						{
							status: 400,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				return new Response(null, { status: 204 });
			},

			// GET /health
			health: () => {
				return new Response(
					JSON.stringify({
						status: "healthy",
						agent: this.config.name,
						version: this.config.protocolVersion || "0.3.0",
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		};
	}
}

/**
 * Create an A2A executor that wraps a LangGraph graph
 */
export function createLangGraphA2AExecutor(
	graphInvoker: (
		input: Record<string, unknown>,
	) => Promise<Record<string, unknown>>,
	options?: {
		/** Field in the output that contains the response text */
		responseField?: string;
		/** Field in the output that contains artifacts */
		artifactsField?: string;
		/** Transform input message to graph input */
		inputTransform?: (message: A2AMessage) => Record<string, unknown>;
		/** Transform graph output to A2A result */
		outputTransform?: (
			output: Record<string, unknown>,
		) => A2AExecutionResult;
	},
): A2AAgentExecutor {
	const responseField = options?.responseField || "document";
	const artifactsField = options?.artifactsField || "artifacts";

	return {
		async execute(message, contextId, metadata) {
			// Default input transform: extract text from message parts
			let input: Record<string, unknown>;
			if (options?.inputTransform) {
				input = options.inputTransform(message);
			} else {
				const textPart = message.parts.find((p) => p.type === "text");
				const text =
					textPart && "text" in textPart ? textPart.text : "";
				input = {
					messages: [{ role: "user", content: text }],
					contextId,
					...metadata,
				};
			}

			// Invoke the graph
			const output = await graphInvoker(input);

			// Default output transform
			if (options?.outputTransform) {
				return options.outputTransform(output);
			}

			// Extract response from known fields
			let response = "";
			if (output[responseField]) {
				response = String(output[responseField]);
			} else if (
				output.messages &&
				Array.isArray(output.messages) &&
				output.messages.length > 0
			) {
				const lastMessage = output.messages[output.messages.length - 1];
				if (typeof lastMessage === "object" && lastMessage.content) {
					response = String(lastMessage.content);
				} else if (typeof lastMessage === "string") {
					response = lastMessage;
				}
			} else if (output.response) {
				response = String(output.response);
			} else if (output.output) {
				response = String(output.output);
			}

			// Extract artifacts
			const artifacts: Artifact[] = [];
			if (
				output[artifactsField] &&
				Array.isArray(output[artifactsField])
			) {
				for (const artifact of output[artifactsField]) {
					if (artifact && typeof artifact === "object") {
						artifacts.push(artifact as Artifact);
					}
				}
			}

			// If we have a document, create an artifact for it
			if (
				output.document &&
				typeof output.document === "string" &&
				response
			) {
				artifacts.push({
					id: uuidv4(),
					name: "document",
					mimeType: "text/markdown",
					parts: [{ type: "text", text: response }],
				});
			}

			return {
				response,
				artifacts,
				metadata: output.metadata as
					| Record<string, unknown>
					| undefined,
			};
		},
	};
}

/**
 * Create a streaming A2A executor that wraps a LangGraph stream
 */
export function createLangGraphStreamingA2AExecutor(
	graphStreamer: (
		input: Record<string, unknown>,
	) => AsyncGenerator<Record<string, unknown>>,
	options?: {
		/** Field in chunks that contains text */
		textField?: string;
		/** Field in final output that contains the document */
		documentField?: string;
		/** Transform input message to graph input */
		inputTransform?: (message: A2AMessage) => Record<string, unknown>;
	},
): A2AAgentExecutor {
	const textField = options?.textField || "chunk";
	const documentField = options?.documentField || "document";

	return {
		async execute(message, contextId, metadata) {
			// Collect all chunks for non-streaming execution
			let fullText = "";
			let finalOutput: Record<string, unknown> = {};

			const textPart = message.parts.find((p) => p.type === "text");
			const text = textPart && "text" in textPart ? textPart.text : "";
			const input = options?.inputTransform
				? options.inputTransform(message)
				: {
						messages: [{ role: "user", content: text }],
						contextId,
						...metadata,
					};

			for await (const chunk of graphStreamer(input)) {
				if (chunk[textField]) {
					fullText += String(chunk[textField]);
				}
				finalOutput = { ...finalOutput, ...chunk };
			}

			// Use document field if available
			const response = finalOutput[documentField]
				? String(finalOutput[documentField])
				: fullText;

			const artifacts: Artifact[] = [];
			if (response) {
				artifacts.push({
					id: uuidv4(),
					name: "document",
					mimeType: "text/markdown",
					parts: [{ type: "text", text: response }],
				});
			}

			return { response, artifacts };
		},

		async *executeStream(message, contextId, metadata) {
			const textPart = message.parts.find((p) => p.type === "text");
			const text = textPart && "text" in textPart ? textPart.text : "";
			const input = options?.inputTransform
				? options.inputTransform(message)
				: {
						messages: [{ role: "user", content: text }],
						contextId,
						...metadata,
					};

			let fullText = "";

			for await (const chunk of graphStreamer(input)) {
				if (chunk[textField]) {
					const chunkText = String(chunk[textField]);
					fullText += chunkText;
					yield { type: "text", text: chunkText };
				}
			}

			// Emit final document as artifact
			if (fullText) {
				yield {
					type: "artifact",
					artifact: {
						id: uuidv4(),
						name: "document",
						mimeType: "text/markdown",
						parts: [{ type: "text", text: fullText }],
					},
				};
			}
		},
	};
}

export type {
	AgentCard,
	AgentSkill,
	A2ATask,
	A2AMessage,
	TaskStatus,
	Artifact,
	TaskEvent,
};
