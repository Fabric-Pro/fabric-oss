import { ORPCError } from "@orpc/server";
import {
	db,
	isShareableIntegrationProvider,
	recordAuditTx,
} from "@repo/database";
import { OAUTH_APP_ROW_NAMES } from "@repo/database/prisma/queries/lib/oauth-app-row";

export async function setIntegrationUsageScope(
	input: {
		integrationId: string;
		organizationId: string;
		usageScope: "OWNER_ONLY" | "ORGANIZATION_SHARED";
	},
	actor: { id: string; email: string; name?: string | null },
) {
	return db.$transaction(async (tx) => {
		const member = await tx.member.findFirst({
			where: { userId: actor.id, organizationId: input.organizationId },
			select: { id: true, role: true },
		});
		if (!member) {
			throw new ORPCError("FORBIDDEN", {
				message: "Organization membership is required",
			});
		}
		const connection = await tx.workflowIntegration.findFirst({
			where: {
				id: input.integrationId,
				organizationId: input.organizationId,
				NOT: { name: { in: OAUTH_APP_ROW_NAMES } },
			},
		});
		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}
		// A personal-only connection (GitLab) stays personal: it can be
		// withdrawn from sharing but never shared.
		if (
			input.usageScope === "ORGANIZATION_SHARED" &&
			!isShareableIntegrationProvider(connection.provider)
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"This connection is personal to its owner and cannot be shared with the organization",
			});
		}
		const ownsConnection = connection.userId === actor.id;
		const administersOrganization =
			member.role === "owner" || member.role === "admin";
		// An administrator may withdraw sharing, but cannot consent for someone else.
		if (
			input.usageScope === "ORGANIZATION_SHARED"
				? !ownsConnection ||
					!administersOrganization ||
					!connection.isActive
				: !ownsConnection &&
					!(
						administersOrganization &&
						connection.usageScope === "ORGANIZATION_SHARED"
					)
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only the connection owner with an organization owner or admin role can share this connection",
			});
		}
		if (connection.usageScope === input.usageScope) {
			return { success: true };
		}
		const result = await tx.workflowIntegration.updateMany({
			where: {
				id: connection.id,
				organizationId: input.organizationId,
				userId: connection.userId,
				usageScope: connection.usageScope,
				isActive: connection.isActive,
			},
			data: { usageScope: input.usageScope },
		});
		if (result.count !== 1) {
			throw new ORPCError("CONFLICT", {
				message: "Connection changed; refresh and try again",
			});
		}
		await recordAuditTx(tx, {
			action: "org.integration.config_updated",
			actor: {
				type: "user",
				userId: actor.id,
				emailSnapshot: actor.email,
				nameSnapshot: actor.name ?? null,
			},
			organizationId: input.organizationId,
			resource: { type: "workflow_integration", id: connection.id },
			metadata: {
				previousUsageScope: connection.usageScope,
				usageScope: input.usageScope,
				provider: connection.provider,
			},
		});
		return { success: true };
	});
}
