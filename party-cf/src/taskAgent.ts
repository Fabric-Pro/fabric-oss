import { type Connection, type ConnectionContext, Server } from "partyserver";
import { requireServiceAuth, verifyWithFabric } from "./auth";
import type { Env } from "./env";

interface TaskAgentMessage {
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

const MESSAGES_KEY = "messages";
const REPLAY_LIMIT = 100;
const STORAGE_LIMIT = 200;

export class TaskAgent extends Server<Env> {
	static options = { hibernate: true };

	async onConnect(conn: Connection, ctx: ConnectionContext) {
		const url = new URL(ctx.request.url);
		const token = url.searchParams.get("token");
		const userId = url.searchParams.get("userId");

		const auth = await this.verifyAccess(token, userId);
		if (!auth.valid) {
			conn.close(4001, "Unauthorized");
			return;
		}

		conn.setState({ userId: auth.userId });

		const stored =
			await this.ctx.storage.get<TaskAgentMessage[]>(MESSAGES_KEY);
		if (stored && stored.length > 0) {
			for (const msg of stored.slice(-REPLAY_LIMIT)) {
				conn.send(JSON.stringify(msg));
			}
		}

		console.log(
			`[TaskAgent] Client connected to ${this.name}, userId: ${auth.userId}`,
		);
	}

	async onMessage(_conn: Connection, _message: string) {
		// Clients don't send messages — broadcasts come from temporal via HTTP POST
	}

	async onRequest(req: Request) {
		if (req.method === "POST") {
			return this.handlePublish(req);
		}

		// GET (room metadata) and DELETE (wipe the replay buffer) are management
		// endpoints, not client surface — without this gate anyone who knew a
		// room id could read its metadata or drop the messages a reconnecting
		// client replays.
		if (req.method === "GET" || req.method === "DELETE") {
			const unauthorized = await requireServiceAuth(
				this.env,
				req.headers.get("Authorization"),
			);
			if (unauthorized) {
				return unauthorized;
			}
		}

		if (req.method === "GET") {
			const connections = [...this.getConnections()];
			const stored =
				(await this.ctx.storage.get<TaskAgentMessage[]>(
					MESSAGES_KEY,
				)) ?? [];
			return Response.json({
				status: "ok",
				room: this.name,
				connections: connections.length,
				messageCount: stored.length,
			});
		}

		if (req.method === "DELETE") {
			await this.ctx.storage.delete(MESSAGES_KEY);
			console.log(`[TaskAgent] Room ${this.name} cleaned up`);
			return Response.json({ status: "cleaned" });
		}

		return new Response("Method not allowed", { status: 405 });
	}

	private async handlePublish(req: Request): Promise<Response> {
		try {
			// Publish is the Temporal activities' surface: an unset secret
			// denies in production, dev stays permissive (see ./auth.ts).
			const unauthorized = await requireServiceAuth(
				this.env,
				req.headers.get("Authorization"),
			);
			if (unauthorized) {
				return unauthorized;
			}

			const message = (await req.json()) as TaskAgentMessage;
			if (!message.type || !message.planId) {
				return Response.json(
					{ error: "Invalid message format" },
					{ status: 400 },
				);
			}
			// Bind the payload to this room so a publish can never be stored in
			// or broadcast to a room it does not belong to. Publishers are
			// fire-and-forget (partykit-publisher only console.warns on a
			// non-2xx), so the distinct error body is the only breadcrumb.
			if (message.planId !== this.name) {
				return Response.json(
					{ error: "room mismatch" },
					{ status: 400 },
				);
			}
			if (!message.timestamp) {
				message.timestamp = Date.now();
			}

			const messages =
				(await this.ctx.storage.get<TaskAgentMessage[]>(
					MESSAGES_KEY,
				)) ?? [];
			messages.push(message);
			if (messages.length > STORAGE_LIMIT) {
				messages.splice(0, messages.length - STORAGE_LIMIT);
			}
			await this.ctx.storage.put(MESSAGES_KEY, messages);

			this.broadcast(JSON.stringify(message));

			console.log(
				`[TaskAgent] Broadcast ${message.type} to ${this.name}`,
			);
			return Response.json({ status: "published", type: message.type });
		} catch (error) {
			console.error("[TaskAgent] Publish error:", error);
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Publish failed",
				},
				{ status: 500 },
			);
		}
	}

	private async verifyAccess(
		token: string | null,
		userId: string | null,
	): Promise<AuthResult> {
		const isDev = this.env.PARTYKIT_ENV !== "production";

		// Dev/staging: trust the userId param so local development and the
		// existing PartyKit-hosted staging continue to work.
		if (isDev) {
			return { valid: true, userId: userId ?? "dev-user" };
		}

		// Production: the scoped JWT minted by /api/task-agent/token is the only
		// credential. Task-agent broadcasts include tool args/results,
		// checkpoints, agent thinking, responses, summaries, and artifacts (see
		// packages/temporal/src/activities/task-agent/partykit-publisher.ts),
		// so the unauthenticated userId query param is never trusted here — it
		// is carried only for dev and for connection logging. Fabric re-checks
		// project access against the plan's project on every verify call.
		if (!token) {
			console.warn("[TaskAgent] No token provided");
			return { valid: false };
		}

		const verified = await verifyWithFabric(this.env, {
			token,
			path: "/api/task-agent/verify",
			body: { planId: this.name },
			logTag: "[TaskAgent]",
		});

		return verified
			? { valid: true, userId: verified.userId }
			: { valid: false };
	}
}
