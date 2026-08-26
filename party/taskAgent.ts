import type * as Party from "partykit/server";
import { requireServiceAuth, verifyWithFabric } from "./auth";

/**
 * Task Agent Party Server
 *
 * Real-time streaming of task agent execution updates.
 * Each room corresponds to a plan ID (e.g., "plan-xxx-xxx").
 *
 * Message Types:
 * - agent_started: Agent workflow started
 * - step_added: New step added to execution
 * - step_updated: Step status changed
 * - tool_start: Tool execution started
 * - tool_complete: Tool execution completed
 * - checkpoint: Waiting for user approval
 * - checkpoint_resolved: User responded to checkpoint
 * - agent_thinking: Agent is processing (with partial text)
 * - agent_response: Agent turn complete with response
 * - agent_completed: Workflow completed successfully
 * - agent_failed: Workflow failed
 * - agent_cancelled: Workflow cancelled
 */

export interface TaskAgentMessage {
	type:
		| "agent_started"
		| "step_added"
		| "step_updated"
		| "tool_start"
		| "tool_complete"
		| "checkpoint"
		| "checkpoint_resolved"
		| "agent_thinking"
		| "agent_response"
		| "agent_completed"
		| "agent_failed"
		| "agent_cancelled";
	planId: string;
	timestamp: number;
	data: Record<string, unknown>;
}

interface AuthResult {
	valid: boolean;
	userId?: string;
}

export default class TaskAgentServer implements Party.Server {
	constructor(readonly room: Party.Room) {}

	async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
		const url = new URL(ctx.request.url);
		const token = url.searchParams.get("token");
		const userId = url.searchParams.get("userId");

		// Verify access
		const authResult = await this.verifyAccess(token, userId);
		if (!authResult.valid) {
			conn.close(4001, "Unauthorized");
			return;
		}

		conn.setState({ userId: authResult.userId });

		// Send current state for late joiners
		const currentState =
			await this.room.storage.get<TaskAgentMessage[]>("messages");
		if (currentState && currentState.length > 0) {
			// Send last 100 messages to catch up
			const recentMessages = currentState.slice(-100);
			for (const msg of recentMessages) {
				conn.send(JSON.stringify(msg));
			}
		}

		console.log(
			`[TaskAgentServer] Client connected to ${this.room.id}, userId: ${authResult.userId}`,
		);
	}

	async onMessage(_message: string, sender: Party.Connection) {
		// Clients don't send messages in this implementation
		console.log(
			`[TaskAgentServer] Unexpected client message from ${sender.id}`,
		);
	}

	async onRequest(req: Party.Request) {
		// POST: Publish event from temporal worker
		if (req.method === "POST") {
			return this.handlePublish(req);
		}

		// GET (room status) and DELETE (wipe the replay buffer) are management
		// endpoints, not client surface — without this gate anyone who knew a
		// room id could read its metadata or drop the messages a reconnecting
		// client replays. Mirrors party-cf/src/taskAgent.ts.
		if (req.method === "GET" || req.method === "DELETE") {
			const unauthorized = await requireServiceAuth(
				this.room.env,
				req.headers.get("Authorization"),
			);
			if (unauthorized) {
				return unauthorized;
			}
		}

		// GET: Health check / room status
		if (req.method === "GET") {
			const connections = [...this.room.getConnections()];
			const messageCount =
				(await this.room.storage.get<TaskAgentMessage[]>("messages"))
					?.length || 0;

			return new Response(
				JSON.stringify({
					status: "ok",
					room: this.room.id,
					connections: connections.length,
					messageCount,
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		}

		// DELETE: Clean up room
		if (req.method === "DELETE") {
			await this.room.storage.delete("messages");
			console.log(`[TaskAgentServer] Room ${this.room.id} cleaned up`);
			return new Response(JSON.stringify({ status: "cleaned" }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response("Method not allowed", { status: 405 });
	}

	private async handlePublish(req: Party.Request): Promise<Response> {
		try {
			// Verify server secret for publish requests. In production an unset
			// secret denies; dev stays permissive (see ./auth.ts).
			const unauthorized = await requireServiceAuth(
				this.room.env,
				req.headers.get("Authorization"),
			);
			if (unauthorized) {
				return unauthorized;
			}

			const message = (await req.json()) as TaskAgentMessage;

			// Validate message
			if (!message.type || !message.planId) {
				return new Response(
					JSON.stringify({ error: "Invalid message format" }),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			// Bind the payload to this room so a publish can never be stored in
			// or broadcast to a room it does not belong to. Publishers are
			// fire-and-forget (partykit-publisher only console.warns on a
			// non-2xx), so the distinct error body is the only breadcrumb.
			if (message.planId !== this.room.id) {
				return new Response(
					JSON.stringify({ error: "room mismatch" }),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			// Add timestamp if not present
			if (!message.timestamp) {
				message.timestamp = Date.now();
			}

			// Store message for late joiners (keep last 200 messages)
			const messages =
				(await this.room.storage.get<TaskAgentMessage[]>("messages")) ||
				[];
			messages.push(message);
			if (messages.length > 200) {
				messages.splice(0, messages.length - 200);
			}
			await this.room.storage.put("messages", messages);

			// Broadcast to all connected clients
			const payload = JSON.stringify(message);
			this.room.broadcast(payload);

			console.log(
				`[TaskAgentServer] Broadcast ${message.type} to ${this.room.id}`,
			);

			return new Response(
				JSON.stringify({ status: "published", type: message.type }),
				{ headers: { "Content-Type": "application/json" } },
			);
		} catch (error) {
			console.error("[TaskAgentServer] Publish error:", error);
			return new Response(
				JSON.stringify({
					error:
						error instanceof Error
							? error.message
							: "Publish failed",
				}),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	}

	private async verifyAccess(
		token: string | null,
		userId: string | null,
	): Promise<AuthResult> {
		const isDev = this.room.env.PARTYKIT_ENV !== "production";

		// In dev mode, allow connection with userId param
		if (isDev) {
			return { valid: true, userId: userId || "dev-user" };
		}

		// In production, verify JWT token. The shared helper accepts only an
		// explicit { valid: true, userId } — a 2xx with any other shape (a
		// proxy's HTML error page, a partial payload) must not open the room.
		// Mirrors party-cf/src/taskAgent.ts.
		if (!token) {
			return { valid: false };
		}

		const verified = await verifyWithFabric(this.room.env, {
			token,
			path: "/api/task-agent/verify",
			body: { planId: this.room.id },
			logTag: "[TaskAgentServer]",
		});

		return verified
			? { valid: true, userId: verified.userId }
			: { valid: false };
	}
}
