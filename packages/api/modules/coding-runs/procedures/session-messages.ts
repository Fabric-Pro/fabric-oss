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
	remoteServerConnectionId,
	requireRemoteServerAccess,
} from "../lib/remote-server-access";

export const sessionMessagesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/coding-runs/{id}/messages",
		tags: ["CodingRuns"],
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const run = await getCodingRun(
			input.id,
			context.user.id,
			organizationId,
		);
		if (!run || !(await hasProjectAccess(run.projectId, context.user.id))) {
			throw new ORPCError("NOT_FOUND");
		}
		const connectionId = remoteServerConnectionId(run.providerMetadata);
		if (!connectionId || !run.providerSessionId) {
			return { available: false, messages: [], webUrl: null };
		}
		await requireRemoteServerAccess({
			id: connectionId,
			projectId: run.projectId,
			userId: context.user.id,
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
			const result = await provider.getSessionMessages(
				run.providerSessionId,
			);
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
	});
