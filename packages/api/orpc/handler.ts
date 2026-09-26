import { SmartCoercionPlugin } from "@orpc/json-schema";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { router } from "./router";
import {
	createRpcErrorCaptureInterceptor,
	createRpcErrorLoggingInterceptor,
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
	rootInterceptors: [createRpcErrorLoggingInterceptor()],
});

export const openApiHandler = new OpenAPIHandler(router, {
	plugins: [
		new ResponseHeadersPlugin(),
		new SmartCoercionPlugin({
			schemaConverters: [new ZodToJsonSchemaConverter()],
		}),
	],
	interceptors: [createRpcErrorCaptureInterceptor()],
	rootInterceptors: [createRpcErrorLoggingInterceptor()],
});
