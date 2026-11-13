/**
 * Loads the names the web-research endpoint must keep out of outbound
 * requests: the organization's name and slug, the project's name, the
 * project's client (its recipient brand) and the email domains of the
 * organization's members.
 *
 * Called only after the caller's access to the project in the token's
 * organization was confirmed. A missing row or a failed query throws, so the
 * endpoint answers with an error rather than searching without its filter.
 */

import { db } from "@repo/database";
import {
	buildConfidentialMatcher,
	type ConfidentialMatcher,
} from "./confidential-terms";

export async function loadConfidentialMatcher({
	organizationId,
	projectId,
}: {
	organizationId: string;
	projectId: string;
}): Promise<ConfidentialMatcher> {
	const [organization, project, members] = await Promise.all([
		db.organization.findUnique({
			where: { id: organizationId },
			select: { name: true, slug: true },
		}),
		db.project.findUnique({
			where: { id: projectId },
			select: {
				name: true,
				recipientBrand: { select: { name: true, website: true } },
			},
		}),
		db.member.findMany({
			where: { organizationId },
			select: { user: { select: { email: true } } },
		}),
	]);

	if (!organization || !project) {
		throw new Error("Confidential terms unavailable: row not found");
	}

	return buildConfidentialMatcher({
		organizationName: organization.name,
		organizationSlug: organization.slug,
		projectName: project.name,
		clientName: project.recipientBrand?.name,
		clientWebsite: project.recipientBrand?.website,
		memberEmails: members.map((member) => member.user.email),
	});
}
