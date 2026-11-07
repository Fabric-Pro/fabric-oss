import { ORPCError } from "@orpc/client";
import { getCodingRun, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	type CodingRunActor,
	requireCodingRunProject,
} from "../lib/commands-access";
import {
	remoteServerConnectionId,
	requireRemoteServerAccess,
} from "../lib/remote-server-access";

export const codingRunMessagesInput = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const sessionMessagesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/coding-runs/{id}/messages",
		tags: ["CodingRuns"],
	})
	.input(codingRunMessagesInput)
	.handler(async ({ input, context }) =>
		readCodingRunMessages(
			{
				userId: context.user.id,
				organizationId: resolveOrganizationId(
					input.organizationId,
					context.session,
				),
			},
			input,
		),
	);

export async function readCodingRunMessages(
	actor: CodingRunActor,
	input: z.infer<typeof codingRunMessagesInput>,
) {
	const organizationId = actor.organizationId ?? undefined;
	const run = await getCodingRun(input.id, actor.userId, organizationId);
	if (!run || !(await hasProjectAccess(run.projectId, actor.userId))) {
		throw new ORPCError("NOT_FOUND");
	}
	await requireCodingRunProject(actor, run.projectId, Permissions.AGENT_READ);
	const connectionId = remoteServerConnectionId(run.providerMetadata);
	if (!connectionId || !run.providerSessionId) {
		return { available: false, messages: [], webUrl: null };
	}
	await requireRemoteServerAccess({
		id: connectionId,
		projectId: run.projectId,
		userId: actor.userId,
		allowDisabled: true,
	});
	const { getCodingExecutionProvider } = await import(
		"@repo/temporal/coding-execution"
	);
	const provider = getCodingExecutionProvider(
		run.provider,
		run.providerMetadata,
	);
	if (!provider.getSessionMessages) {
		return { available: false, messages: [], webUrl: null };
	}
	try {
		const result = await provider.getSessionMessages(run.providerSessionId);
		return {
			available: true,
			messages: result.messages,
			webUrl: result.webUrl ?? null,
		};
	} catch {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message:
				"The remote conversation is unavailable. Check the server connection and matching server version.",
		});
	}
}
