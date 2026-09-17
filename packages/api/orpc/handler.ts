import { onError } from "@orpc/client";
import { SmartCoercionPlugin } from "@orpc/json-schema";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { logger } from "@repo/logs";
import { router } from "./router";

// `ResponseHeadersPlugin` injects `context.resHeaders` and merges it into
// whatever response the procedure produces, including error responses. The
// global request limiter (`orpc/middleware/rpc-rate-limit-middleware.ts`)
// writes `Retry-After` through it; without the plugin a 429 would carry the
// oRPC error body but no header, and `Retry-After` is already on the CORS
// expose list in `index.ts` for exactly this purpose.
export const rpcHandler = new RPCHandler(router, {
	plugins: [new ResponseHeadersPlugin()],
	clientInterceptors: [
		onError((error) => {
			logger.error(error);
		}),
	],
});

export const openApiHandler = new OpenAPIHandler(router, {
	plugins: [
		new ResponseHeadersPlugin(),
		new SmartCoercionPlugin({
			schemaConverters: [new ZodToJsonSchemaConverter()],
		}),
	],
	clientInterceptors: [
		onError((error) => {
			logger.error(error);
		}),
	],
});
