import type * as Party from "partykit/server";

/**
 * Health Check Party
 * Responds to health check requests from Aspire at the root path
 */
export default class HealthServer implements Party.Server {
	constructor(readonly room: Party.Room) {}

	async onRequest(req: Party.Request) {
		if (req.method === "GET") {
			return new Response(
				JSON.stringify({
					status: "healthy",
					timestamp: new Date().toISOString(),
					uptime: process.uptime?.() || 0,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		return new Response("Method not allowed", { status: 405 });
	}
}
