import type * as Party from "partykit/server";
import { requireServiceAuth, verifyWithFabric } from "./auth";

/**
 * Orchestrator Party Server
 *
 * Real-time streaming of orchestrator execution updates.
 * Each room corresponds to an execution ID (e.g., "orch-xxx-xxx").
 *
 * Message Types:
 * - tool_start: Tool execution started
 * - tool_complete: Tool execution completed
 * - step_progress: Step progress update with tool calls
 * - step_complete: Step completed
 * - phase_change: Workflow phase changed
 * - heartbeat: Activity heartbeat with current state
 */

interface OrchestratorMessage {
	type:
		| "tool_start"
		| "tool_input"
		| "tool_complete"
		| "step_progress"
		| "step_complete"
		| "phase_change"
		| "heartbeat"
		| "error"
		| "completed";
	executionId: string;
	timestamp: number;
	data: Record<string, unknown>;
}

interface AuthResult {
	valid: boolean;
	userId?: string;
}

export default class OrchestratorServer implements Party.Server {
	constructor(readonly room: Party.Room) {}

	async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
		const url = new URL(ctx.request.url);
		const token = url.searchParams.get("token");
		const userId = url.searchParams.get("userId");

		// Verify access - in dev mode, allow with userId param
		const authResult = await this.verifyAccess(token, userId);
		if (!authResult.valid) {
			conn.close(4001, "Unauthorized");
			return;
		}

		conn.setState({ userId: authResult.userId });

		// Send current state if available (for late joiners)
		const currentState =
			await this.room.storage.get<OrchestratorMessage[]>("messages");
		if (currentState && currentState.length > 0) {
			// Send last 50 messages to catch up
			const recentMessages = currentState.slice(-50);
			for (const msg of recentMessages) {
				conn.send(JSON.stringify(msg));
			}
		}

		console.log(
			`[OrchestratorServer] Client connected to ${this.room.id}, userId: ${authResult.userId}`,
		);
	}

	async onMessage(_message: string, sender: Party.Connection) {
		// Clients don't send messages in this implementation
		// All messages come from the server via HTTP POST
		console.log(
			`[OrchestratorServer] Unexpected client message from ${sender.id}`,
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
		// client replays. Mirrors party-cf/src/orchestrator.ts.
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
				(await this.room.storage.get<OrchestratorMessage[]>("messages"))
					?.length || 0;

			return new Response(
				JSON.stringify({
					status: "ok",
					room: this.room.id,
					connections: connections.length,
					messageCount,
				}),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// DELETE: Clean up room (called when execution completes)
		if (req.method === "DELETE") {
			await this.room.storage.delete("messages");
			console.log(`[OrchestratorServer] Room ${this.room.id} cleaned up`);
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

			const message = (await req.json()) as OrchestratorMessage;

			// Validate message
			if (!message.type || !message.executionId) {
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
			if (message.executionId !== this.room.id) {
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

			// Store message for late joiners (keep last 100 messages)
			const messages =
				(await this.room.storage.get<OrchestratorMessage[]>(
					"messages",
				)) || [];
			messages.push(message);
			if (messages.length > 100) {
				messages.splice(0, messages.length - 100);
			}
			await this.room.storage.put("messages", messages);

			// Broadcast to all connected clients
			const payload = JSON.stringify(message);
			this.room.broadcast(payload);

			console.log(
				`[OrchestratorServer] Broadcast ${message.type} to ${this.room.id}`,
			);

			return new Response(
				JSON.stringify({ status: "published", type: message.type }),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			console.error("[OrchestratorServer] Publish error:", error);
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
			return {
				valid: true,
				userId: userId || "dev-user",
			};
		}

		// In production, verify JWT token. The shared helper accepts only an
		// explicit { valid: true, userId } — a 2xx with any other shape (a
		// proxy's HTML error page, a partial payload) must not open the room.
		// Mirrors party-cf/src/orchestrator.ts.
		if (!token) {
			return { valid: false };
		}

		const verified = await verifyWithFabric(this.room.env, {
			token,
			path: "/api/orchestrator/verify",
			body: { executionId: this.room.id },
			logTag: "[OrchestratorServer]",
		});

		return verified
			? { valid: true, userId: verified.userId }
			: { valid: false };
	}
}
