/**
 * Topic Item Page (organization context) — Fizzy #1851, Phase 2A-1.
 *
 * Thin server wrapper for `/projects/{id}/publishing/{topicId}`. Gates on the
 * SAME two flags as the sibling list route and in the same order, BEFORE any
 * session, org or project access — a detail route that gated more loosely than
 * its list would be a way to reach Publishing Suite data by guessing a URL
 * while the UI is deliberately hidden.
 *
 * Resolves the project with the ACTIVE org id, never `null`: passing `null`
 * searches personal projects only and would 404 an org member authorized
 * through their org role rather than an explicit `ProjectMember` row (F2) —
 * the same trap the list route documents.
 *
 * The topic itself is NOT fetched here; `TopicItemPage` reads it through
 * `publishingSuite.getTopic`, which re-scopes to `{ id, projectId }` (DV16).
 */

import { isPublishingSuiteEnabled } from "@repo/utils/feature-flag";
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
	if (
		!isPublishingSuiteEnabled() ||
		process.env.NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE !== "true"
	) {
		notFound();
	}

	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const { id, topicId, organizationSlug } = await params;

	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
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
