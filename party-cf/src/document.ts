import type { Connection, ConnectionContext } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { verifyWithFabric } from "./auth";
import type { Env } from "./env";

interface AuthResult {
	valid: boolean;
	userId?: string;
	userName?: string;
	userColor?: string;
	canEdit?: boolean;
}

const STORAGE_KEY = "ydoc";

export class Document extends YServer<Env> {
	static options = { hibernate: true };

	static callbackOptions = {
		debounceWait: 2000,
		debounceMaxWait: 10000,
	};

	async onLoad() {
		const stored = await this.ctx.storage.get<Uint8Array>(STORAGE_KEY);
		if (stored) {
			Y.applyUpdate(this.document, stored);
		}
	}

	async onSave() {
		const update = Y.encodeStateAsUpdate(this.document);
		await this.ctx.storage.put(STORAGE_KEY, update);
	}

	async onConnect(conn: Connection, ctx: ConnectionContext) {
		const url = new URL(ctx.request.url);
		const token = url.searchParams.get("token");

		const auth = await this.verifyAccess(token, this.name);
		if (!auth.valid) {
			conn.close(4001, "Unauthorized");
			return;
		}

		conn.setState({
			userId: auth.userId,
			userName: auth.userName,
			userColor: auth.userColor,
			canEdit: auth.canEdit,
		});

		// Run YServer's onConnect: writes initial SyncStep1 and replays
		// existing awareness states so late joiners see other users' cursors
		// without waiting for them to emit another awareness update.
		await super.onConnect(conn, ctx);
	}

	// Gate Yjs sync writes on canEdit. y-partyserver's readSyncMessage
	// applies updates only when this returns false (see y-partyserver
	// dist/server/index.js readSyncMessage / messageYjsUpdate). Awareness
	// messages are not gated — read-only viewers can still publish cursor
	// position and presence, which matches the intended UX.
	isReadOnly(connection: Connection): boolean {
		const state = connection.state as { canEdit?: boolean } | undefined;
		return !state?.canEdit;
	}

	async onRequest(req: Request) {
		if (req.method === "GET") {
			const connections = [...this.getConnections()];
			return Response.json({
				status: "ok",
				room: this.name,
				connections: connections.length,
			});
		}
		return new Response("Method not allowed", { status: 405 });
	}

	private async verifyAccess(
		token: string | null,
		documentId: string,
	): Promise<AuthResult> {
		const isDev = this.env.PARTYKIT_ENV !== "production";

		if (isDev) {
			let userId = "dev-user";
			let userName = "Developer";
			if (token) {
				try {
					const payloadBase64 = token.split(".")[1];
					if (payloadBase64) {
						const payload = JSON.parse(atob(payloadBase64));
						userId = payload.userId || userId;
						userName = payload.userName || userName;
					}
				} catch {
					// ignore parse errors, use defaults
				}
			}
			return {
				valid: true,
				userId,
				userName,
				userColor: generateUserColor(userId),
				canEdit: true,
			};
		}

		if (!token) {
			console.warn("[Document] No token provided");
			return { valid: false };
		}

		const verified = await verifyWithFabric(this.env, {
			token,
			path: "/api/collab/verify",
			body: { documentId },
			logTag: "[Document]",
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
}

function generateUserColor(userId: string): string {
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
