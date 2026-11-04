import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { recordAuditFromRequest } from "../../lib/audit";
import { resolveBoundOrganization } from "../../lib/authorized-project-binding";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../orpc/procedures";
import { contextQualityIdSchema } from "./contracts";
import {
	configureSavedEvaluationBinding,
	deleteSavedEvaluationBinding,
	disableSavedEvaluationBinding,
	getSavedEvaluationBinding,
} from "./lib/saved-bindings";
import {
	cancelContextQualityRun,
	compareContextQualityRuns,
	createContextQualityRun,
	getContextQualityRun,
	getContextQualityRunCapabilities,
	listContextQualityRuns,
} from "./lib/saved-commands";
import { contextQualityError } from "./lib/transport-errors";
import {
	createSavedEvaluationSchema,
	savedEvaluationBindingSchema,
	savedEvaluationListSchema,
	savedEvaluationScopeSchema,
} from "./saved-contracts";

function organizationId() {
	const bound = resolveBoundOrganization(undefined);
	if (!bound.bound)
		throw new ORPCError("FORBIDDEN", {
			message: "An authorized organization project is required.",
		});
	return bound.organizationId;
}
async function present<T>(fn: () => Promise<T>) {
	try {
		return await fn();
	} catch (error) {
		const safe = contextQualityError(error);
		if (safe) throw new ORPCError(safe.code, { message: safe.message });
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Saved evaluation request could not be completed.",
		});
	}
}
const procedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.use(async ({ context, next }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		return next();
	});
const runId = savedEvaluationScopeSchema.extend({
	runId: contextQualityIdSchema,
});
const privateCreate = z.custom<z.infer<typeof createSavedEvaluationSchema>>(
	(value) => createSavedEvaluationSchema.safeParse(value).success,
	{ message: "Use a valid bounded saved evaluation request." },
);
// Keep the whole confidential request opaque to framework diagnostics.
const createInput = z.custom<
	z.infer<typeof savedEvaluationScopeSchema> &
		z.infer<typeof createSavedEvaluationSchema>
>(
	(value) =>
		savedEvaluationScopeSchema
			.extend(createSavedEvaluationSchema.shape)
			.safeParse(value).success,
	{ message: "Use a valid bounded saved evaluation request." },
);

export const savedContextQualityRunsRouter = {
	capabilities: procedure
		.input(savedEvaluationScopeSchema)
		.handler(({ input, context }) =>
			present(() =>
				getContextQualityRunCapabilities({
					...input,
					organizationId: organizationId(),
					userId: context.user.id,
				}),
			),
		),
	create: procedure
		.meta({ auditActivity: "never" })
		.input(createInput)
		.handler(({ input, context }) =>
			present(async () => {
				const { projectId, organizationId: _ignored, ...raw } = input;
				privateCreate.parse(raw);
				return createContextQualityRun(
					{
						projectId,
						organizationId: organizationId(),
						userId: context.user.id,
					},
					raw,
					(event) => recordAuditFromRequest(context, event),
				);
			}),
		),
	list: procedure
		.input(
			savedEvaluationScopeSchema.extend(savedEvaluationListSchema.shape),
		)
		.handler(({ input, context }) =>
			present(() =>
				listContextQualityRuns(
					{
						projectId: input.projectId,
						organizationId: organizationId(),
						userId: context.user.id,
					},
					{ limit: input.limit, cursor: input.cursor },
				),
			),
		),
	get: procedure.input(runId).handler(({ input, context }) =>
		present(() =>
			getContextQualityRun(
				{
					projectId: input.projectId,
					organizationId: organizationId(),
					userId: context.user.id,
				},
				input,
			),
		),
	),
	cancel: procedure
		.meta({ auditActivity: "never" })
		.input(runId)
		.handler(({ input, context }) =>
			present(() =>
				cancelContextQualityRun(
					{
						projectId: input.projectId,
						organizationId: organizationId(),
						userId: context.user.id,
					},
					input,
					(event) => recordAuditFromRequest(context, event),
				),
			),
		),
	compare: procedure
		.input(
			savedEvaluationScopeSchema.extend({
				baselineId: contextQualityIdSchema,
				candidateId: contextQualityIdSchema,
			}),
		)
		.handler(({ input, context }) =>
			present(() =>
				compareContextQualityRuns(
					{
						projectId: input.projectId,
						organizationId: organizationId(),
						userId: context.user.id,
					},
					input,
				),
			),
		),
};
export const savedContextQualityBindingsRouter = {
	disable: procedure
		.meta({ auditActivity: "never" })
		.input(savedEvaluationScopeSchema)
		.handler(({ input, context }) =>
			present(async () => {
				const actor = {
					projectId: input.projectId,
					organizationId: organizationId(),
					userId: context.user.id,
				};
				const result = await disableSavedEvaluationBinding(actor);
				recordAuditFromRequest(context, {
					action: "project.context_quality.binding_disabled",
					organizationId: actor.organizationId,
					projectId: actor.projectId,
					resource: {
						type: "context_quality_binding",
						id: result.binding?.id,
					},
				});
				return result;
			}),
		),
	delete: procedure
		.meta({ auditActivity: "never" })
		.input(
			savedEvaluationScopeSchema.extend({
				confirmHistoryDeletion: z.literal(true),
			}),
		)
		.handler(({ input, context }) =>
			present(async () => {
				const actor = {
					projectId: input.projectId,
					organizationId: organizationId(),
					userId: context.user.id,
				};
				const result = await deleteSavedEvaluationBinding(actor);
				recordAuditFromRequest(context, {
					action: "project.context_quality.binding_deleted",
					organizationId: actor.organizationId,
					projectId: actor.projectId,
					resource: { type: "context_quality_binding" },
				});
				return result;
			}),
		),
	get: procedure
		.input(savedEvaluationScopeSchema)
		.handler(({ input, context }) =>
			present(() =>
				getSavedEvaluationBinding({
					projectId: input.projectId,
					organizationId: organizationId(),
					userId: context.user.id,
				}),
			),
		),
	save: procedure
		.meta({ auditActivity: "never" })
		.input(
			savedEvaluationScopeSchema.extend(
				savedEvaluationBindingSchema.shape,
			),
		)
		.handler(({ input, context }) =>
			present(async () => {
				const { projectId, organizationId: _ignored, ...raw } = input;
				const actor = {
					projectId,
					organizationId: organizationId(),
					userId: context.user.id,
				};
				const result = await configureSavedEvaluationBinding(
					actor,
					raw,
				);
				recordAuditFromRequest(context, {
					action: "project.context_quality.binding_configured",
					organizationId: actor.organizationId,
					projectId,
					resource: {
						type: "context_quality_binding",
						id: result.binding?.id,
					},
					metadata: { enabled: raw.enabled },
				});
				return result;
			}),
		),
};
