/**
 * Publishing Suite deep-link page (personal / account context).
 *
 * Thin server wrapper for the design-locked `/projects/{id}/publishing`
 * route. Gates on the
 * `FABRIC_FEATURE_PUBLISHING_SUITE` server flag FIRST (off → `notFound()`,
 * before touching session/project data), then fetches the project through
 * the SAME `getProjectById(id, userId)` path `getProjectProcedure`
 * (`projects.get`) uses, with `organizationId` explicitly `null` — this
 * route is for personal projects only.
 *
 * `canEdit` is `project.canPublish`, already resolved by `getProjectProcedure`
 * via `resolveEffectiveProjectPermissions` (Task 4a) — never a raw
 * `project.userRole` string check.
 */

import { isPublishingSuiteEnabled } from "@repo/utils/feature-flag";
import { getSession } from "@saas/auth/lib/server";
import { PublishingSuiteList } from "@saas/projects/components/publishing-suite";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string }>;
};

export default async function PersonalPublishingSuitePage({ params }: Props) {
	// Gate on BOTH flags FIRST (before session/project access). The server flag
	// (`isPublishingSuiteEnabled()`) gates the backend; the client UI-rollout
	// flag (`NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE`) is what hides the tab
	// + onboarding. Honoring it here too means a guessed /publishing URL can't
	// render the full list while the UI is intentionally hidden (server-on /
	// client-off = "backend live, UI hidden"). NOTE: NEXT_PUBLIC_* vars are
	// inlined at build time, so toggling this flag takes effect on the next
	// rebuild/redeploy — same constraint as the ProjectDetails tab gate.
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

	const { id } = await params;

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
		<PublishingSuiteList
			projectId={id}
			organizationId={null}
			canEdit={projectResult.project.canPublish ?? false}
		/>
	);
}
