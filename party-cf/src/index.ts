import { routePartykitRequest } from "partyserver";
import type { Env } from "./env";

export { Document } from "./document";
export { Orchestrator } from "./orchestrator";
export { TaskAgent } from "./taskAgent";
export { Health } from "./health";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Backwards-compat: the temporal publisher posts to /parties/taskagent/<id>
		// (no hyphen) while the web client uses /parties/task-agent/<id>. Rewrite
		// the legacy form so both route to the same TaskAgent Durable Object.
		const url = new URL(request.url);
		if (url.pathname.startsWith("/parties/taskagent/")) {
			url.pathname = url.pathname.replace(
				"/parties/taskagent/",
				"/parties/task-agent/",
			);
			request = new Request(url, request);
		}

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
