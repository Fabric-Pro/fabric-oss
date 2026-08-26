import { CreateTemplatePage } from "@saas/agent-templates/components/CreateTemplatePage";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		organizationSlug: string;
	}>;
};

export const metadata = {
	title: "Create Custom Template - Fabric",
	description: "Create a custom agent template",
};

export default async function NewAgentTemplatePage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	if (session.user?.role !== "admin") {
		redirect(`/app/${organizationSlug}/agent-templates`);
	}

	const organizationId = session.session.activeOrganizationId ?? undefined;
	const basePath = `/app/${organizationSlug}/agent-templates`;

	return (
		<div className="min-h-screen">
			<div className="w-full py-6 space-y-6">
				<TopRightControls />
				<PageBreadcrumbs
					items={[
						{ label: "Agent Templates", href: basePath },
						{ label: "Create Custom Template" },
					]}
				/>
			</div>
			<CreateTemplatePage
				organizationId={organizationId}
				basePath={basePath}
			/>
		</div>
	);
}
