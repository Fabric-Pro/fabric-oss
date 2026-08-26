import type * as Party from "partykit/server";
import { onConnect } from "y-partykit";
import { verifyWithFabric } from "./auth";

interface AuthResult {
	valid: boolean;
	userId?: string;
	userName?: string;
	userColor?: string;
	canEdit?: boolean;
}

export default class DocumentServer implements Party.Server {
	constructor(readonly room: Party.Room) {}

	async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
		// Extract auth token from query params
		const url = new URL(ctx.request.url);
		const token = url.searchParams.get("token");

		// Verify token with our API
		const authResult = await this.verifyAccess(token, this.room.id);
		if (!authResult.valid) {
			conn.close(4001, "Unauthorized");
			return;
		}

		// Store user info for cursor display
		conn.setState({
			userId: authResult.userId,
			userName: authResult.userName,
			userColor: authResult.userColor,
			canEdit: authResult.canEdit,
		});

		// Handle Yjs sync with persistence
		return onConnect(conn, this.room, {
			persist: { mode: "snapshot" },

			// Load document from PartyKit storage
			// Returns null to allow client-side initialization
			load: async () => {
				// PartyKit storage handles persistence automatically
				// Return null for new documents - client will initialize
				return null;
			},

			// Callback when document changes (for logging/analytics)
			callback: {
				handler: async (_yDoc) => {
					// Document persistence is handled by PartyKit storage
					// and client-side saves via API
					console.log(
						`[DocumentServer] Document ${this.room.id} updated`,
					);
				},
				debounceWait: 2000,
				debounceMaxWait: 10000,
			},
		});
	}

	async verifyAccess(
		token: string | null,
		roomId: string,
	): Promise<AuthResult> {
		// In development mode, skip verification and allow all connections
		// PartyKit's workerd runtime has trouble making outbound requests to localhost
		const isDev = this.room.env.PARTYKIT_ENV !== "production";

		if (isDev) {
			console.log(
				"[DocumentServer] Dev mode - skipping token verification",
			);
			// Parse basic info from token if available (JWT payload is base64)
			let userId = "dev-user";
			let userName = "Developer";

			if (token) {
				try {
					// JWT format: header.payload.signature - decode payload
					const payloadBase64 = token.split(".")[1];
					if (payloadBase64) {
						const payload = JSON.parse(atob(payloadBase64));
						userId = payload.userId || userId;
						userName = payload.userName || userName;
					}
				} catch {
					// Ignore parse errors, use defaults
				}
			}

			return {
				valid: true,
				userId,
				userName,
				userColor: this.generateUserColor(userId),
				canEdit: true,
			};
		}

		if (!token) {
			console.warn("[DocumentServer] No token provided");
			return { valid: false };
		}

		// Call our API to verify the token and check project access. The shared
		// helper accepts only an explicit { valid: true, userId } — a 2xx with
		// any other shape (a proxy's HTML error page, a partial payload) must
		// not open the room. Mirrors party-cf/src/document.ts.
		const verified = await verifyWithFabric(this.room.env, {
			token,
			path: "/api/collab/verify",
			body: { documentId: roomId },
			logTag: "[DocumentServer]",
		});
		if (!verified) {
			return { valid: false };
		}

		// /api/collab/verify layers presence fields on top of the shared
		// { valid: true, userId } contract the helper enforces. They are read
		// defensively so a payload that drops one costs a cursor colour or
		// degrades the session to read-only, never edit rights.
		return {
			valid: true,
			userId: verified.userId,
			userName:
				typeof verified.userName === "string"
					? verified.userName
					: undefined,
			userColor:
				typeof verified.userColor === "string"
					? verified.userColor
					: undefined,
			canEdit: verified.canEdit === true,
		};
	}

	private generateUserColor(userId: string): string {
		const colors = [
			"#FF6B6B",
			"#4ECDC4",
			"#45B7D1",
			"#96CEB4",
			"#FFEAA7",
			"#DDA0DD",
			"#98D8C8",
			"#F7DC6F",
		];
		const hash = userId.split("").reduce((a, b) => a + b.charCodeAt(0), 0);
		return colors[hash % colors.length] as string;
	}

	// Handle HTTP requests to the party (for health checks)
	async onRequest(req: Party.Request) {
		if (req.method === "GET") {
			// Convert iterable to array to get count
			const connections = [...this.room.getConnections()];
			return new Response(
				JSON.stringify({
					status: "ok",
					room: this.room.id,
					connections: connections.length,
				}),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		return new Response("Method not allowed", { status: 405 });
	}
}
