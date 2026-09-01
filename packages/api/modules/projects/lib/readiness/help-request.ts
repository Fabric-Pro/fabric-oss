/**
 * Delivering a readiness help request (Fizzy #2165, FR22).
 *
 * "Request help" already recorded a flag nobody outside the project could see,
 * which made it a button that filed a complaint into a drawer. The 31 August
 * direction is that it should reach the people who can answer: an email to a
 * monitored inbox, with the in-app flag kept as the record.
 *
 * The address comes from `SUPPORT_EMAIL` and is never a literal here: it is
 * published with the source, and the inbox that should answer differs between
 * deployments — which is what makes this usable by anyone running Fabric
 * outside ours. A deployment that has named no inbox still records the
 * request, and the caller is told that no email went out rather than being
 * shown a confirmation that is not true.
 */

import { config } from "@repo/config";
import { db } from "@repo/database";
import { getMessagesForLocale } from "@repo/i18n";
import { logger } from "@repo/logs";
import { sendEmail } from "@repo/mail";
import { toAbsoluteUrl } from "@repo/utils";
import { READINESS_RULES_BY_KEY } from "./registry";

export type ReadinessHelpRequest = {
	projectId: string;
	itemKey: string;
	requesterName: string;
	requesterEmail: string;
	requestedAt: Date;
};

/**
 * The checklist item's own name, in the default locale.
 *
 * Resolved here rather than in the template because the mail i18n guard only
 * catches unresolved `mail.*` paths — a `readiness.items.*` key that failed to
 * resolve inside the template would render as literal text and pass CI. The
 * recipient is a shared inbox with no locale of its own, so the default locale
 * is the only sensible choice anyway.
 */
async function resolveItemName(itemKey: string): Promise<string> {
	const rule = READINESS_RULES_BY_KEY.get(itemKey);
	if (!rule) {
		return itemKey;
	}
	const messages = await getMessagesForLocale(config.i18n.defaultLocale);
	const name = `${rule.i18nKey}.name`
		.split(".")
		.reduce<unknown>(
			(node, segment) =>
				node && typeof node === "object"
					? (node as Record<string, unknown>)[segment]
					: undefined,
			messages,
		);
	return typeof name === "string" ? name : itemKey;
}

/**
 * Where the project lives, for the link in the email.
 *
 * Mirrors the panel's own construction: `/app/{slug}/projects/{id}` inside an
 * organization, `/app/projects/{id}` when the slug cannot be resolved, so a
 * missing slug still lands the reader on a page that can show the project.
 */
function projectPath(projectId: string, organizationSlug: string | null) {
	return organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}`
		: `/app/projects/${projectId}`;
}

/**
 * Mail the configured support inbox about one help request.
 *
 * Returns whether the request reached an inbox: `false` both when no address
 * is configured and when the send failed, because the caller only needs to
 * know whether it may promise that someone was told.
 *
 * Never throws. A help request that was recorded but could not be mailed is
 * still a help request, and failing the mutation would lose the record too.
 */
export async function deliverReadinessHelpRequest(
	request: ReadinessHelpRequest,
): Promise<boolean> {
	const supportEmail = config.support.email;
	if (!supportEmail) {
		return false;
	}

	try {
		const project = await db.project.findUnique({
			where: { id: request.projectId },
			select: {
				name: true,
				organization: { select: { slug: true } },
			},
		});
		if (!project) {
			return false;
		}

		const itemName = await resolveItemName(request.itemKey);

		return await sendEmail({
			to: supportEmail,
			templateId: "readinessHelpRequested",
			// Two people clicking at once — or one person clicking twice —
			// resolve to the same key, so the provider collapses them. Bucketed
			// by day rather than pinned forever: asking again a week later is a
			// renewed request, not a duplicate.
			idempotencyKey: `readiness-help-${request.projectId}-${request.itemKey}-${request.requestedAt.toISOString().slice(0, 10)}`,
			context: {
				projectName: project.name,
				itemName,
				requesterName: request.requesterName,
				requesterEmail: request.requesterEmail,
				url: toAbsoluteUrl(
					projectPath(
						request.projectId,
						project.organization?.slug ?? null,
					),
				),
			},
		});
	} catch (error) {
		logger.error(
			{
				error,
				projectId: request.projectId,
				itemKey: request.itemKey,
			},
			"[readiness] help request email failed",
		);
		return false;
	}
}
