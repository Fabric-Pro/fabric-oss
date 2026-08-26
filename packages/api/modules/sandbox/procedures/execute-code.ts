/**
 * Execute Code in Sandbox
 *
 * Executes code in a Dynamic Worker isolate.
 */

import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { executeDynamicWorkerCode } from "../lib/dynamic-worker-client";
import { ExecutionResultSchema, LanguageSchema } from "../types";

const ExecuteCodeInputSchema = z.object({
	code: z.string().min(1, "Code cannot be empty"),
	language: LanguageSchema.default("javascript"),
	timeout: z.number().min(1000).max(60000).default(30000), // 1s to 60s
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
	.output(ExecutionResultSchema)
	.handler(async ({ input, context }) => {
		return executeDynamicWorkerCode({
			userId: context.user.id,
			organizationId: context.session.activeOrganizationId ?? undefined,
			code: input.code,
			language: input.language,
			timeout: input.timeout,
		});
	});
