import { getOrganizationBySlug, isFeatureEnabled } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { TodoListPage } from "@saas/todos/components/TodoListPage";
import { notFound, redirect } from "next/navigation";

/**
 * The consolidated To Do page (Fizzy #2340).
 *
 * Deliberately the same thin shape as the neighbouring Workspaces page: resolve
 * the session and the organization named in the URL, then hand a real
 * organization id to the client component.
 *
 * The `TODO_LIST` rollout gate is re-checked here even though `todos.list`
 * already refuses the read and the sidebar entry is absent. A rollout gate off
 * means the capability is ABSENT, not present-and-explaining — a page that
 * renders a shell saying "not turned on yet" to a hand-typed URL is the shape
 * of a disabled feature, and CONCEPTS.md reserves that shape for a Kill switch.
 * Absent is a 404.
 */
interface OrganizationTodosPageProps {
	params: Promise<{ organizationSlug: string }>;
}

export default async function OrganizationTodosPage({
	params,
}: OrganizationTodosPageProps) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { organizationSlug } = await params;

	const organization = await getOrganizationBySlug(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	if (!(await isFeatureEnabled("TODO_LIST", organization.id))) {
		notFound();
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs items={[{ label: "To Do" }]} />

			<TodoListPage organizationId={organization.id} />
		</div>
	);
}
