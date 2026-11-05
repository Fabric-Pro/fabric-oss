import type { Hono } from "hono";
import { z } from "zod";
import { executionRequestKey } from "../external-api/lib/execution-request-key";
import { requireScope } from "../external-api/middleware/api-key-auth";
import { executeAgent } from "../external-api/procedures/execute-agent";
import type { ExternalApiVariables } from "../external-api/types";
import { registerAgentPreviewRoutes } from "./agent-previews";
import { registerAgentRunRoutes } from "./agent-runs";
import { registerAgentTestRoutes } from "./agent-tests";
import { ok, resolveV1Context } from "./helpers";

const invokeInput = z
	.object({
		input: z.record(z.string(), z.unknown()).default({}),
		priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).optional(),
		idempotencyKey: z
			.string()
			.regex(/^[\x21-\x7e]{1,200}$/)
			.optional(),
	})
	.strict();
export function registerAgentInstanceRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.post(
		"/agent-instances/:id/invoke",
		requireScope("agents:execute"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const targetId = c.req.param("id");
			if (!targetId || targetId.length > 200) {
				return c.json(
					{
						error: {
							code: "INVALID_EXECUTION_REQUEST",
							message: "Invalid agent identity",
						},
					},
					400,
				);
			}
			const context = await resolveV1Context(apiCtx, c.req.query("org"));
			if ("error" in context) {
				return c.json(
					{
						error: {
							code: "ORGANIZATION_REQUIRED",
							message: context.error,
						},
					},
					context.status,
				);
			}
			if (!context.organizationId) {
				return c.json(
					{
						error: {
							code: "ORGANIZATION_REQUIRED",
							message: "An organization is required",
						},
					},
					403,
				);
			}
			const parsed = invokeInput.safeParse(
				await c.req.json().catch(() => null),
			);
			if (!parsed.success) {
				return c.json(
					{
						error: {
							code: "INVALID_EXECUTION_REQUEST",
							message: "Invalid invocation input",
						},
					},
					400,
				);
			}
			let requestKey: string | undefined;
			try {
				requestKey = executionRequestKey(
					parsed.data.idempotencyKey,
					c.req.header("Idempotency-Key"),
				);
			} catch {
				return c.json(
					{
						error: {
							code: "INVALID_EXECUTION_REQUEST",
							message: "Invalid or conflicting request keys",
						},
					},
					400,
				);
			}

			const result = await executeAgent(
				targetId,
				{ ...parsed.data, idempotencyKey: requestKey },
				{
					...apiCtx,
					userId: context.userId,
					organizationId: context.organizationId,
				},
			);
			return "error" in result
				? c.json(
						{
							error:
								typeof result.error === "string"
									? {
											code: "EXECUTION_REFUSED",
											message: result.error,
										}
									: result.error,
						},
						result.status,
					)
				: c.json(ok(result.data), result.status);
		},
	);
	registerAgentRunRoutes(app);
	registerAgentPreviewRoutes(app);
	registerAgentTestRoutes(app);
}
