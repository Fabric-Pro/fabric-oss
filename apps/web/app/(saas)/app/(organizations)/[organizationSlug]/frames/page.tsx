import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { FramesList } from "@saas/frames/components/FramesList";
import { PageHeader } from "@saas/shared/components/PageHeader";
import { notFound, redirect } from "next/navigation";

export const metadata = {
	title: "Frames",
	description: "Manage organization frames",
};

interface OrganizationFramesPageProps {
	params: Promise<{
		organizationSlug: string;
	}>;
}

export default async function OrganizationFramesPage({
	params,
}: OrganizationFramesPageProps) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		return notFound();
	}

	return (
		<div className="container max-w-6xl py-6">
			<PageHeader
				title="Frames"
				subtitle={`Interactive visual artifacts for ${organization.name}`}
			/>
			<div className="mt-6">
				<FramesList
					organizationId={organization.id}
					organizationSlug={organizationSlug}
				/>
			</div>
		</div>
	);
}
