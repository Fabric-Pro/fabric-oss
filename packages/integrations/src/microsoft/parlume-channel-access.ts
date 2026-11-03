import {
	canUseWorkflowIntegrations,
	db,
	getProjectAccessContext,
	workflowIntegrationAccessWhere,
} from "@repo/database";
import { parlumeChannelOperationSchema } from "./parlume-channel";

/** Recheck immediately before the single external dispatch, after token work. */
export async function assertParlumeChannelSendAccess(
	args: unknown,
	userId: string,
	organizationId: string | undefined,
	integrationId: string,
): Promise<void> {
	const operation = parlumeChannelOperationSchema.parse(args);
	if (operation.kind !== "send" || !organizationId) {
		throw new Error("Invalid Parlume channel send scope.");
	}
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: operation.sessionId,
			userId,
			organizationId,
			status: "ACTIVE",
			channelChatStatus: "READY",
			channelIntegrationId: integrationId,
			channelTeamId: operation.destination.teamId,
			channelId: operation.destination.channelId,
			channelRootMessageId: operation.destination.rootMessageId,
			channelTenantId: operation.destination.tenantId,
			leaveRequestedAt: null,
			captureStoppedAt: null,
			endedAt: null,
			hardStopAt: { gt: new Date() },
			channelSubscriptionExpiresAt: { gt: new Date() },
		},
		select: { projectId: true },
	});
	if (
		!session ||
		(await getProjectAccessContext(session.projectId, userId))
			?.organizationId !== organizationId
	) {
		throw new Error("Parlume channel session is no longer authorized.");
	}
	const integration = (await canUseWorkflowIntegrations(
		userId,
		organizationId,
	))
		? await db.workflowIntegration.findFirst({
				where: {
					...workflowIntegrationAccessWhere(userId, organizationId),
					id: integrationId,
					provider: "MICROSOFT_GRAPH",
					isActive: true,
				},
				select: { id: true },
			})
		: null;
	if (!integration) {
		throw new Error(
			"Parlume's Microsoft connection is no longer authorized.",
		);
	}
}
