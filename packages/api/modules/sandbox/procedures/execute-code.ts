/**
 * Execute Code in Sandbox
 *
 * Executes code in a Dynamic Worker isolate.
 */

import {
	ExecuteCodePublicRequestSchema,
	ExecuteCodeResponseSchema,
} from "@repo/sandbox/dynamic-worker";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { executeDynamicWorkerCode } from "../lib/dynamic-worker-client";

const ExecuteCodeInputSchema = ExecuteCodePublicRequestSchema.extend({
	language:
		ExecuteCodePublicRequestSchema.shape.language.default("javascript"),
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
		return executeDynamicWorkerCode({
			userId: context.user.id,
			organizationId: context.session.activeOrganizationId ?? undefined,
			code: input.code,
			language: input.language,
			inputs: input.inputs,
			timeout: input.timeout,
		});
	});
