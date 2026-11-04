import { routePartykitRequest } from "partyserver";
import type { Env } from "./env";

export { Document } from "./document";
export { Health } from "./health";
export { Orchestrator } from "./orchestrator";
export { Parlume } from "./parlume";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Root health check (Cloudflare's default URL handling).
		if (url.pathname === "/" || url.pathname === "/health") {
			return Response.json({
				status: "healthy",
				timestamp: new Date().toISOString(),
			});
		}

		const routed = await routePartykitRequest(request, env);
		return routed ?? new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
