import { getUserByEmail } from "@repo/database";
import { logger } from "@repo/logs";
import { sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { buildInvitationToken } from "./invitation-token";

/**
 * Sends an organization invitation, and fails if the email was not sent:
 * `sendEmail` reports a provider or rendering failure by returning false, and
 * ignoring that told the caller the invitation had gone out.
 */
export async function sendOrganizationInvitationEmail(
	{
		id,
		email,
		organization,
	}: { id: string; email: string; organization: { name: string } },
	locale: Parameters<typeof sendEmail>[0]["locale"],
): Promise<void> {
	const existingUser = await getUserByEmail(email);

	const token = buildInvitationToken({ invitationId: id, email });
	const path = existingUser ? "/auth/login" : "/auth/signup";
	const url = `${getBaseUrl()}${path}/invite/${encodeURIComponent(token)}`;

	const sent = await sendEmail({
		to: email,
		templateId: "organizationInvitation",
		locale,
		context: {
			organizationName: organization.name,
			url,
		},
	});
	if (!sent) {
		logger.error(`[Auth] Invitation email not sent for ${id}`);
		throw new Error(`Invitation email not sent for ${id}`);
	}
}
