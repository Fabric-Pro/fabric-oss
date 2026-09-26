import { app } from "@repo/api";
import { flushAppInsights } from "@repo/observability";
import { handle } from "hono/vercel";
import { after } from "next/server";

const handler = handle(app);

/**
 * Wrap handler to ensure RPC requests always get JSON responses on error.
 * Prevents "Cannot parse response body" when Next.js/Vercel returns HTML.
 *
 * Also flushes App Insights' batched log/trace telemetry on every request,
 * scheduled via `after()` so it runs once the response has been sent rather
 * than adding latency to it (Next 16, `next/server`, stable — no experimental
 * flag needed: node_modules/next/dist/server/after/after.d.ts). Necessary
 * because Vercel's Fluid Compute can freeze the process between requests, and
 * a frozen process never gets to flush what it already batched.
 */
function withJsonErrorFallback<
	T extends (...args: never[]) => Response | Promise<Response>,
>(fn: T): T {
	return (async (...args: Parameters<T>) => {
		after(() => flushAppInsights());
		try {
			return await fn(...args);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return new Response(
				JSON.stringify({
					error: "Internal Server Error",
					message,
				}),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	}) as T;
}

const wrappedHandler = withJsonErrorFallback(handler);

export const GET = wrappedHandler;
export const POST = wrappedHandler;
export const PUT = wrappedHandler;
export const PATCH = wrappedHandler;
export const DELETE = wrappedHandler;
export const OPTIONS = wrappedHandler;

// Document-editor flows like "Update using context" run RAG + generateObject
// synchronously on the server and can exceed Vercel's default 300 s Fluid
// Compute timeout. Match the CopilotKit route's budget.
export const maxDuration = 800;
