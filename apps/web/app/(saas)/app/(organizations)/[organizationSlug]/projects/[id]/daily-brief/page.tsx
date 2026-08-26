/**
 * Daily Brief page (organization context)
 *
 * Thin server wrapper. Resolves auth + active organization + params, fetches
 * the latest brief via oRPC, and hands off to the client `DailyBriefPage`.
 */

import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { DailyBriefPage } from "@saas/daily-brief/components";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound, redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string; organizationSlug: string }>;
	searchParams?: Promise<{ window?: string }>;
};

type TimeWindow = "LAST_24H" | "LAST_7D" | "LAST_2W" | "CUSTOM";

function coerceWindow(raw: string | undefined): TimeWindow {
	if (raw === "LAST_7D" || raw === "LAST_2W" || raw === "CUSTOM") {
		return raw;
	}
	return "LAST_24H";
}

export default async function ProjectDailyBriefPage({
	params,
	searchParams,
}: Props) {
	const session = await getSession();
	const { id, organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
		notFound();
	}

	const timeWindow = coerceWindow((await searchParams)?.window);
	const [result, projectResult] = await Promise.all([
		orpcClient.dailyBrief.get({
			projectId: id,
			organizationId: organization.id,
			timeWindow,
		}),
		orpcClient.projects.get({ id, organizationId: organization.id }),
	]);

	// Mirrors ReleaseNotesList's editor gate: capability first (covers org
	// admins without an explicit project role), role as fallback.
	const canEditExclusions =
		projectResult.project.canEditSettings === true ||
		projectResult.project.userRole === "owner" ||
		projectResult.project.userRole === "project_admin";
	// The exclusion list is editor-only server-side (PROJECT_SETTINGS_EDIT) —
	// skip the call entirely for readers rather than relying on the server to
	// reject it.
	const exclusions = canEditExclusions
		? await orpcClient.dailyBrief.exclusions.list({
				projectId: id,
				organizationId: organization.id,
			})
		: [];

	return (
		<DailyBriefPage
			projectId={id}
			organizationId={organization.id}
			timeWindow={timeWindow}
			brief={result.brief?.content ?? null}
			status={result.brief?.status ?? null}
			briefId={result.brief?.id ?? null}
			generatedAt={result.brief?.generatedAt ?? null}
			cursor={result.cursor}
			progress={result.progress}
			errorMessage={result.brief?.errorMessage ?? null}
			canEditExclusions={canEditExclusions}
			exclusions={exclusions}
		/>
	);
}
