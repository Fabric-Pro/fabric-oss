import { redirect } from "next/navigation";

/**
 * Back-compat redirect (unified-project-setup spec §4.1, §13). The old
 * New-vs-Existing fork is removed; the `projects/new/existing` route now
 * redirects to the unified wizard at `projects/new`. Any `?step` / `?projectId`
 * is preserved so a stale bookmark still resumes (no 404). 302 via Next
 * `redirect()`.
 */
export default async function NewProjectExistingRedirectPage({
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
