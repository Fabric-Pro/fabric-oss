import { unlazyRouter } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { router } from "./router";
import {
	createRpcErrorCaptureInterceptor,
	createRpcErrorLoggingInterceptor,
	createRpcRouteTemplateCaptureInterceptor,
} from "./rpc-error-logging";

// `ResponseHeadersPlugin` injects `context.resHeaders` and merges it into
// whatever response the procedure produces, including error responses. The
// global request limiter (`orpc/middleware/rpc-rate-limit-middleware.ts`)
// writes `Retry-After` through it; without the plugin a 429 would carry the
// oRPC error body but no header, and `Retry-After` is already on the CORS
// expose list in `index.ts` for exactly this purpose.
//
// Logs every error response exactly once, including input-decode failures
// that never reach the procedure client, from the FINAL response status —
// never guessed from the raw thrown error. See the doc comment on
// `createRpcErrorLoggingInterceptor` for why that needs two interceptor
// levels (`interceptors` to capture the error, `rootInterceptors` to log it
// once the status is decided), not `clientInterceptors`.
export const rpcHandler = new RPCHandler(router, {
	plugins: [new ResponseHeadersPlugin()],
	interceptors: [createRpcErrorCaptureInterceptor()],
	clientInterceptors: [createRpcRouteTemplateCaptureInterceptor()],
	rootInterceptors: [createRpcErrorLoggingInterceptor()],
});

// The REST (OpenAPI) handler is built on the first non-RPC request, from the
// fully resolved router: the OpenAPI matcher only resolves a lazy module
// router whose path prefix matches the request, and explicit `route.path`s do
// not always start with the module key. Resolving everything keeps every REST
// route reachable, and keeps the OpenAPI/zod/json-schema packages off the
// RPC cold path.
export const openApiHandler = {
	async handle(
		...args: Parameters<
			Awaited<ReturnType<typeof loadOpenApiHandler>>["handle"]
		>
	) {
		return (await loadOpenApiHandler()).handle(...args);
	},
};

let openApiHandlerPromise: ReturnType<typeof createOpenApiHandler> | undefined;

function loadOpenApiHandler() {
	openApiHandlerPromise ??= createOpenApiHandler().catch((error: unknown) => {
		openApiHandlerPromise = undefined;
		throw error;
	});
	return openApiHandlerPromise;
}

async function createOpenApiHandler() {
	const [
		{ SmartCoercionPlugin },
		{ OpenAPIHandler },
		{ ZodToJsonSchemaConverter },
		resolvedRouter,
	] = await Promise.all([
		import("@orpc/json-schema"),
		import("@orpc/openapi/fetch"),
		import("@orpc/zod/zod4"),
		unlazyRouter(router),
	]);

	return new OpenAPIHandler(resolvedRouter, {
		plugins: [
			new ResponseHeadersPlugin(),
			new SmartCoercionPlugin({
				schemaConverters: [new ZodToJsonSchemaConverter()],
			}),
		],
		interceptors: [createRpcErrorCaptureInterceptor()],
		clientInterceptors: [createRpcRouteTemplateCaptureInterceptor()],
		rootInterceptors: [createRpcErrorLoggingInterceptor()],
	});
}
