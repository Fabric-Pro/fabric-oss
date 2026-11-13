import { ORPCError } from "@orpc/server";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../lib/missing-organization-context";
import { resolveOrganizationIdForCaller } from "../../../orpc/procedures";

type NotificationOrganizationContext = {
	session: { activeOrganizationId?: string | null };
	user: { id: string };
};

export async function resolveNotificationOrganization(
	inputOrganizationId: string | null | undefined,
	context: NotificationOrganizationContext,
): Promise<string> {
	const organizationId = await resolveOrganizationIdForCaller(
		inputOrganizationId,
		context.session,
		context.user.id,
	);
	if (!organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "This operation requires an organization context",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
	}
	return organizationId;
}
