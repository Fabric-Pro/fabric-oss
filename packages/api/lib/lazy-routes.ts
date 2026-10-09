import type {
	ErrorHandler,
	ExecutionContext,
	Hono,
	MiddlewareHandler,
} from "hono";

const UNMATCHED_HEADER = "x-lazy-routes-unmatched";

/**
 * Serves a group of Hono routes that is built on the first request that
 * reaches it, instead of when the API module is imported.
 *
 * The REST surfaces (`/v1/*`) import most of the monorepo (Temporal, RAG, AI,
 * MCP, ...). Registering them with `.route()` evaluates all of that on every
 * cold start, including the requests that only call oRPC procedures. Behind
 * this middleware a request pays for them only when it is addressed to them.
 *
 * `load` must return an app whose paths are complete (including the `/api`
 * base path). A request the routes do not match falls through to the next
 * handler, as it would with `.route()`. Errors use the parent's `onError`, so
 * they keep the same JSON shape.
 */
export function lazyRoutes(
	load: () => Promise<Hono>,
	onError: ErrorHandler,
): MiddlewareHandler {
	let routes: Promise<Hono> | undefined;

	const getRoutes = () => {
		routes ??= load()
			.then((app) =>
				app.onError(onError).notFound(
					() =>
						new Response(null, {
							status: 404,
							headers: { [UNMATCHED_HEADER]: "1" },
						}),
				),
			)
			.catch((error: unknown) => {
				routes = undefined;
				throw error;
			});
		return routes;
	};

	return async (c, next) => {
		const app = await getRoutes();
		let executionCtx: ExecutionContext | undefined;
		try {
			executionCtx = c.executionCtx;
		} catch {
			// No execution context outside of workers runtimes.
		}
		const response = await app.fetch(c.req.raw, c.env, executionCtx);
		if (response.headers.has(UNMATCHED_HEADER)) {
			await next();
			return;
		}
		// Assigning the response merges the parent's headers over it. Mounted
		// eagerly the sub-app's later `c.header()` calls win, so give its own
		// headers precedence again.
		c.res = response;
		for (const [name, value] of response.headers) {
			if (name !== "set-cookie") {
				c.res.headers.set(name, value);
			}
		}
	};
}
