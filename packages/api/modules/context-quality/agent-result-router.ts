import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { resolveBoundOrganization } from "../../lib/authorized-project-binding";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../orpc/procedures";
import {
	evaluateAgentResultSchema,
	inspectAgentResultSchema,
} from "./agent-run-contracts";
import { contextQualityIdSchema } from "./contracts";
import { agentResultCommands } from "./lib/agent-result";
import { contextQualityError } from "./lib/transport-errors";

const procedure = tenantProtectedProcedure.use(async ({ context, next }) => {
	context.resHeaders?.set("Cache-Control", "private, no-store");
	return next();
});
const scope = {
	projectId: contextQualityIdSchema,
	organizationId: contextQualityIdSchema.optional(),
};
/** Do not return strict-object diagnostic keys from confidential run-check input. */
function privateInput<S extends z.ZodType>(schema: S) {
	// oRPC attaches raw input to a ValidationError when a schema returns issues.
	// A fresh error from this transform carries neither input nor diagnostic keys.
	return z
		.custom<z.input<S>>(() => true)
		.transform((value): z.output<S> => {
			const parsed = schema.safeParse(value);
			if (!parsed.success) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Use valid bounded agent-result input.",
				});
			}
			return parsed.data;
		});
}
function actor(
	input: { projectId: string; organizationId?: string },
	userId: string,
) {
	const binding = resolveBoundOrganization(input.organizationId);
	if (!binding.bound) {
		throw new ORPCError("FORBIDDEN", {
			message: "An authorized organization project is required.",
		});
	}
	return {
		projectId: input.projectId,
		organizationId: binding.organizationId,
		userId,
	};
}
async function present<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		const safe = contextQualityError(error);
		throw new ORPCError(safe?.code ?? "SERVICE_UNAVAILABLE", {
			message:
				safe?.message ??
				"This agent result could not be checked. Try again.",
		});
	}
}
export const agentResultQualityRouter = {
	inspect: procedure
		.input(privateInput(inspectAgentResultSchema.extend(scope)))
		.use(requireProjectPermission(Permissions.CONTEXT_READ))
		.handler(({ input, context }) =>
			present(async () =>
				(await agentResultCommands()).inspect(
					actor(input, context.user.id),
					{ executionId: input.executionId },
				),
			),
		),
	evaluate: procedure
		.meta({ auditActivity: "never" })
		.input(privateInput(evaluateAgentResultSchema.safeExtend(scope)))
		.use(requireProjectPermission(Permissions.CONTEXT_READ))
		.handler(({ input, context }) => {
			const { projectId: _, organizationId: __, ...command } = input;
			return present(async () =>
				(await agentResultCommands()).evaluate(
					actor(input, context.user.id),
					command,
				),
			);
		}),
};
