/**
 * Topic Item Page (personal / account context) — Fizzy #1851, Phase 2A-1.
 *
 * Thin server wrapper for `/projects/{id}/publishing/{topicId}`. Gates on the
 * SAME two flags as the sibling list route and in the same order: the
 * `FABRIC_FEATURE_PUBLISHING_SUITE` server flag plus the
 * `NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE` client UI-rollout flag, both
 * BEFORE any session or project access. A detail route that gated more loosely
 * than its list would be a way to reach Publishing Suite data by guessing a URL
 * while the UI is deliberately hidden.
 *
 * The topic itself is NOT fetched here. `TopicItemPage` reads it through
 * `publishingSuite.getTopic`, which re-scopes the read to `{ id, projectId }`
 * and answers NOT_FOUND for a topic in another project (DV16). Fetching it
 * server-side as well would duplicate that authorization in a second place.
 *
 * `canEdit` is `project.canPublish`, already resolved by `getProjectProcedure`
 * via `resolveEffectiveProjectPermissions` — never a raw `userRole` check.
 */

import { isPublishingSuiteEnabled } from "@repo/utils/feature-flag";
import { getSession } from "@saas/auth/lib/server";
import { TopicItemPage } from "@saas/projects/components/publishing-suite";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string; topicId: string }>;
};

export default async function PersonalPublishingTopicPage({ params }: Props) {
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

	const { id, topicId } = await params;

	let projectResult: Awaited<ReturnType<typeof orpcClient.projects.get>>;
	try {
		projectResult = await orpcClient.projects.get({
			id,
			organizationId: null,
		});
	} catch {
		notFound();
	}

	return (
		<TopicItemPage
			projectId={id}
			topicId={topicId}
			organizationId={null}
			canEdit={projectResult.project.canPublish ?? false}
		/>
	);
}
