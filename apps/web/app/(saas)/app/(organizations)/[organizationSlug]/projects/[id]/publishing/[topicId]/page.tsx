/**
 * Topic Item Page (organization context) — Fizzy #1851, Phase 2A-1.
 *
 * Thin server wrapper for `/projects/{id}/publishing/{topicId}`. Gates exactly
 * as the sibling list route (`.../publishing/page.tsx`) does, in the same
 * order: session, then the active organization from the `[organizationSlug]`
 * segment, then the single availability gate
 * `isFeatureEnabled("PUBLISHING_SUITE", organization.id)` — off →
 * `notFound()`, still before any project access. A detail route that gated
 * more loosely than its list would be a way to reach Publishing Suite data by
 * guessing a URL while the feature is deliberately unavailable to that
 * organization.
 *
 * The two routes now have exactly one gate to keep in step. The build-time
 * `NEXT_PUBLIC_*` guard that used to run above the pair was removed from both
 * together when the flag became org-scoped: a build-time value carries one
 * answer for every organization, so all it could still do was refuse an
 * enrolled one.
 *
 * Resolves the project with the ACTIVE org id, never `null`: passing `null`
 * searches personal projects only and would 404 an org member authorized
 * through their org role rather than an explicit `ProjectMember` row (F2) —
 * the same trap the list route documents.
 *
 * The topic itself is NOT fetched here; `TopicItemPage` reads it through
 * `publishingSuite.getTopic`, which re-scopes to `{ id, projectId }` (DV16).
 */

import { isFeatureEnabled } from "@repo/database";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { TopicItemPage } from "@saas/projects/components/publishing-suite";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

type Props = {
	params: Promise<{
		id: string;
		topicId: string;
		organizationSlug: string;
	}>;
};

export default async function OrganizationPublishingTopicPage({
	params,
}: Props) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const { id, topicId, organizationSlug } = await params;

	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
		notFound();
	}

	// The only availability gate, resolved against THIS organization, so it
	// cannot run before the organization is resolved — mirrors the list route.
	if (!(await isFeatureEnabled("PUBLISHING_SUITE", organization.id))) {
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
		<TopicItemPage
			projectId={id}
			topicId={topicId}
			organizationId={organization.id}
			canEdit={projectResult.project.canPublish ?? false}
		/>
	);
}
