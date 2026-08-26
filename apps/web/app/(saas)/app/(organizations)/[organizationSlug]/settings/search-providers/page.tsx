import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { SearchProvidersSettingsForm } from "@saas/organizations/components/SearchProvidersSettingsForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

export async function generateMetadata() {
	return {
		title: "Search Providers",
	};
}

export default async function SearchProvidersSettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const session = await getSession();
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	const isAdmin = isOrganizationAdmin(organization, session?.user);

	return (
		<>
			<SettingsHero
				title="Search Providers"
				label="Configuration"
				description="Connect web search capabilities to enhance your agents with live data."
			/>
			<SettingsList>
				<SearchProvidersSettingsForm readOnly={!isAdmin} />
			</SettingsList>
		</>
	);
}
