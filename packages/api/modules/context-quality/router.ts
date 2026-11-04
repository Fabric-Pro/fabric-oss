import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { resolveBoundOrganization } from "../../lib/authorized-project-binding";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../orpc/procedures";
import { agentResultQualityRouter } from "./agent-result-router";
import {
	contextQualityIdSchema,
	type ProjectContextEvaluationInput,
	projectContextEvaluationSchema,
} from "./contracts";
import {
	evaluateProjectContext,
	inspectContextQualitySource,
} from "./lib/commands";
import { contextQualityError } from "./lib/transport-errors";
import {
	savedContextQualityBindingsRouter,
	savedContextQualityRunsRouter,
} from "./saved-router";

const scopeSchema = z.strictObject({
	projectId: contextQualityIdSchema,
	organizationId: contextQualityIdSchema.optional(),
});

// Framework validation happens before the handler's safe error boundary. Keep
// its issue generic: strict-object diagnostics would echo submitted field names
// from confidential/malformed evaluations into responses and error telemetry.
const privateEvaluationSchema = z.custom<ProjectContextEvaluationInput>(
	(value) => projectContextEvaluationSchema.safeParse(value).success,
	{ message: "Use a valid bounded context evaluation." },
);

function authorizedOrganization(): string {
	// requireProjectPermission has already rejected any mismatched input tenant.
	// Consume only its request-local binding, never a caller-selected fallback.
	const binding = resolveBoundOrganization(undefined);
	if (!binding.bound) {
		throw new ORPCError("FORBIDDEN", {
			message: "An authorized organization project is required.",
		});
	}
	return binding.organizationId;
}

async function present<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		const refusal = contextQualityError(error);
		if (refusal) {
			throw new ORPCError(refusal.code, { message: refusal.message });
		}
		throw error;
	}
}

const procedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.use(async ({ context, next }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		return next();
	});

export const contextQualityRouter = {
	agentResults: agentResultQualityRouter,
	runs: savedContextQualityRunsRouter,
	bindings: savedContextQualityBindingsRouter,
	inspect: procedure
		.route({
			method: "GET",
			path: "/context-quality/{projectId}/sources/{sourceId}",
			tags: ["Context quality"],
			summary: "Inspect an authorized current context revision",
		})
		.input(scopeSchema.extend({ sourceId: contextQualityIdSchema }))
		.handler(({ input, context }) =>
			present(() =>
				inspectContextQualitySource(
					{
						projectId: input.projectId,
						userId: context.user.id,
						organizationId: authorizedOrganization(),
					},
					input.sourceId,
				),
			),
		),
	evaluate: procedure
		.meta({ auditActivity: "never" })
		.route({
			method: "POST",
			path: "/context-quality/{projectId}/evaluate",
			tags: ["Context quality"],
			summary: "Score recorded outputs against current pinned context",
		})
		.input(scopeSchema.extend({ evaluation: privateEvaluationSchema }))
		.handler(({ input, context }) =>
			present(() =>
				evaluateProjectContext(
					{
						projectId: input.projectId,
						userId: context.user.id,
						organizationId: authorizedOrganization(),
					},
					input.evaluation,
				),
			),
		),
};
