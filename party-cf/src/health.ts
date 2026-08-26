import { Server } from "partyserver";
import type { Env } from "./env";

export class Health extends Server<Env> {
	async onRequest(req: Request) {
		if (req.method === "GET") {
			return Response.json({
				status: "healthy",
				timestamp: new Date().toISOString(),
			});
		}
		return new Response("Method not allowed", { status: 405 });
	}
}
