import { redirect } from "next/navigation";

export async function generateMetadata() {
	return {
		title: "Integrations",
	};
}

export default async function OrgDataConnectionsSettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	redirect(`/app/${organizationSlug}/settings/integrations`);
}
