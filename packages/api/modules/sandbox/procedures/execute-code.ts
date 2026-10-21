/**
 * Execute Code in Sandbox
 *
 * Executes code in a Dynamic Worker isolate.
 */

import { ORPCError } from "@orpc/client";
import {
	ExecuteCodePublicRequestSchema,
	ExecuteCodeResponseSchema,
} from "@repo/sandbox/dynamic-worker";
import { z } from "zod";
import { checkRateLimit } from "../../../lib/rate-limit";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { executeDynamicWorkerCode } from "../lib/dynamic-worker-client";

/**
 * A run holds a sandbox request open for as long as its script waits, and
 * waiting costs no CPU, so a caller is held to a short wall clock (the
 * workflow script step's own cap) and to a few runs a minute.
 */
const EXECUTE_CODE_MAX_TIMEOUT_MS = 10_000;
const EXECUTE_CODE_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

const ExecuteCodeInputSchema = ExecuteCodePublicRequestSchema.extend({
	language:
		ExecuteCodePublicRequestSchema.shape.language.default("javascript"),
	timeout: z
		.number()
		.int()
		.min(1000)
		.max(EXECUTE_CODE_MAX_TIMEOUT_MS)
		.default(EXECUTE_CODE_MAX_TIMEOUT_MS),
});

/**
 * Execute code in a Dynamic Worker isolate.
 *
 * This is a stateless JS/TS-only execution path intended for short-lived
 * code snippets. It is distinct from the repo/shell sandbox worker used by
 * coding agents for git and filesystem workflows.
 */
export const executeCode = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_EXECUTE))
	.route({
		method: "POST",
		path: "/sandbox/execute",
		tags: ["Sandbox"],
		summary: "Execute code in sandbox",
		description:
			"Execute JavaScript or TypeScript in a Dynamic Worker isolate",
	})
	.input(ExecuteCodeInputSchema)
	.output(ExecuteCodeResponseSchema)
	.handler(async ({ input, context }) => {
		const rate = await checkRateLimit(
			`sandbox-execute:${context.user.id}`,
			EXECUTE_CODE_RATE_LIMIT.limit,
			EXECUTE_CODE_RATE_LIMIT.windowMs,
		);
		if (!rate.allowed) {
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Too many sandbox runs. Try again in ${rate.resetInSeconds} seconds.`,
			});
		}
		return executeDynamicWorkerCode({
			userId: context.user.id,
			organizationId: context.session.activeOrganizationId ?? undefined,
			code: input.code,
			language: input.language,
			inputs: input.inputs,
			timeout: input.timeout,
		});
	});
