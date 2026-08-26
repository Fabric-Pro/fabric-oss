import { redirect } from "next/navigation";

/**
 * Back-compat redirect (unified-project-setup spec §4.1, §13). The old
 * `projects/new/create` route is collapsed into the unified wizard at
 * `projects/new`. Preserve `?step` / `?projectId` so in-flight DRAFT resume /
 * edit links keep working (no 404). 302 via Next `redirect()`.
 */
export default async function NewProjectCreateRedirectPage({
	searchParams,
}: {
	searchParams: Promise<{ step?: string; projectId?: string }>;
}) {
	const { step, projectId } = await searchParams;

	const query = new URLSearchParams();
	if (step) {
		query.set("step", step);
	}
	if (projectId) {
		query.set("projectId", projectId);
	}
	const qs = query.toString();

	redirect(`/app/projects/new${qs ? `?${qs}` : ""}`);
}
