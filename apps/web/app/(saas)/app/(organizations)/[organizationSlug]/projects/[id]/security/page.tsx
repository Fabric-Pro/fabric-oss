import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { SecurityAccessibilityPage } from "@saas/projects/components/security";
import { redirect } from "next/navigation";

interface Props {
	params: Promise<{ id: string; organizationSlug: string }>;
}

export default async function OrganizationProjectSecurityPage({
	params,
}: Props) {
	const session = await getSession();
	if (!session?.user) {
		redirect("/auth/login");
	}

	const { id, organizationSlug } = await params;
	const activeOrganization = await getActiveOrganization(organizationSlug);
	if (!activeOrganization || activeOrganization.slug !== organizationSlug) {
		redirect(`/app/${organizationSlug}`);
	}

	return (
		<div className="container mx-auto py-8 px-4">
			<SecurityAccessibilityPage
				projectId={id}
				organizationId={activeOrganization.id}
			/>
		</div>
	);
}
