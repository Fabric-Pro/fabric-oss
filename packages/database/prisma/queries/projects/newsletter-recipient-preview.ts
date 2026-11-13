/**
 * How many people a "Send now" would email, before anything is sent.
 *
 * A send reconciles the subscriber list first (project members while the
 * newsletter is enabled, then the organization whenever "Send to entire
 * organization" is on) and then emails every ACTIVE, non-excluded row. The
 * preview applies the same rules to the current rows without writing anything:
 * see `enrollProjectMembersAsSubscribers` and `syncOrganizationSubscribers` in
 * `./newsletter`. Keep the two in step.
 */
import { db } from "../../client";
import { getProjectMembers } from "./members";
import {
	getNewsletterSettings,
	ORG_REMOVED_STATUS,
	ORG_SYNC_SOURCE,
} from "./newsletter";

export interface RecipientPreviewRow {
	email: string;
	status: string;
	source: string;
	excludedAt: Date | null;
}

/**
 * The emails a send would reach after reconciliation. `memberEmails` is null
 * when members are not added (newsletter disabled); `organizationEmails` is null
 * when the organization is not synced ("Send to entire organization" off).
 */
export function previewSendRecipients(input: {
	rows: RecipientPreviewRow[];
	memberEmails: string[] | null;
	organizationEmails: string[] | null;
}): string[] {
	const rows = new Map(
		input.rows.map((row) => [row.email.trim().toLowerCase(), { ...row }]),
	);
	const normalize = (emails: string[]) =>
		new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));

	if (input.memberEmails) {
		for (const email of normalize(input.memberEmails)) {
			const row = rows.get(email);
			if (!row) {
				rows.set(email, {
					email,
					status: "ACTIVE",
					source: "MANUAL",
					excludedAt: null,
				});
			} else if (row.status === ORG_REMOVED_STATUS) {
				row.status = "ACTIVE";
				row.source = "MANUAL";
			}
		}
	}

	if (input.organizationEmails) {
		const organization = normalize(input.organizationEmails);
		for (const email of organization) {
			const row = rows.get(email);
			if (!row) {
				rows.set(email, {
					email,
					status: "ACTIVE",
					source: ORG_SYNC_SOURCE,
					excludedAt: null,
				});
			} else if (row.status === ORG_REMOVED_STATUS) {
				row.status = "ACTIVE";
			}
		}
		for (const [email, row] of rows) {
			if (
				row.source === ORG_SYNC_SOURCE &&
				row.status === "ACTIVE" &&
				!organization.has(email)
			) {
				row.status = ORG_REMOVED_STATUS;
				row.excludedAt = null;
			}
		}
	}

	return [...rows.values()]
		.filter((row) => row.status === "ACTIVE" && row.excludedAt === null)
		.map((row) => row.email);
}

export async function previewNewsletterSendRecipientCount(
	projectId: string,
): Promise<{ recipientCount: number }> {
	const settings = await getNewsletterSettings(projectId);
	const rows = await db.newsletterSubscriber.findMany({
		where: { projectId },
		select: { email: true, status: true, source: true, excludedAt: true },
	});

	let memberEmails: string[] | null = null;
	let organizationEmails: string[] | null = null;
	if (settings.enabled) {
		memberEmails = (await getProjectMembers(projectId))
			.map((m) => m.user?.email)
			.filter((e): e is string => !!e);
	}
	if (settings.sendToOrganization) {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				organizationId: true,
				organization: { select: { deletedAt: true } },
			},
		});
		if (project?.organizationId && !project.organization?.deletedAt) {
			const members = await db.member.findMany({
				where: { organizationId: project.organizationId },
				select: { user: { select: { email: true } } },
			});
			// The sync refuses an empty roster and leaves the list as it is.
			organizationEmails =
				members.length > 0 ? members.map((m) => m.user.email) : null;
		}
	}

	return {
		recipientCount: previewSendRecipients({
			rows,
			memberEmails,
			organizationEmails,
		}).length,
	};
}
