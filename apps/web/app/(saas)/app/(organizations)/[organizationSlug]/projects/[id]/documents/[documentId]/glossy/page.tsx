/**
 * Glossy page of one document (organization context; Fizzy #2589, U14).
 *
 * Thin server wrapper, gated like the Publishing Suite route: session first,
 * then the organization from the `[organizationSlug]` segment, then the
 * `GLOSSY_EDITION` rollout gate resolved for THAT organization — off →
 * `notFound()`, before any project access (R40, KTD20). The API refuses every
 * Glossy procedure with NOT_FOUND on its own when the gate is off for the
 * project's organization; this route only keeps the page from existing.
 *
 * The project is read through the same `projects.get` path the Publishing
 * Suite route uses, with the RESOLVED organization id, both for the
 * breadcrumb and so a caller with no tie to the project gets a 404 here.
 * Everything else — the document, the edition, `canEdit`, the brands — comes
 * from `projects.glossy.get` in the client, which enforces project access
 * and returns a guest's view too (R4).
 */

import { isFeatureEnabled } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { GlossyEditionPage } from "@saas/projects/components/glossy/GlossyEditionPage";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

type Props = {
	params: Promise<{
		id: string;
		documentId: string;
		organizationSlug: string;
	}>;
};

export default async function OrganizationGlossyEditionPage({ params }: Props) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const { id, documentId, organizationSlug } = await params;

	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
		notFound();
	}

	if (!(await isFeatureEnabled("GLOSSY_EDITION", organization.id))) {
		notFound();
	}

	let projectResult: Awaited<ReturnType<typeof orpcClient.projects.get>>;
	try {
		projectResult = await orpcClient.projects.get({
			id,
			organizationId: organization.id,
		});
	} catch {
		notFound();
	}

	return (
		<GlossyEditionPage
			projectId={id}
			documentId={documentId}
			organizationSlug={organizationSlug}
			projectName={projectResult.project.name}
		/>
	);
}
