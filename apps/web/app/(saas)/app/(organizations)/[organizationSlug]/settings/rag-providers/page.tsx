import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { RagProvidersSettingsForm } from "@saas/organizations/components/RagProvidersSettingsForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

export async function generateMetadata() {
	return {
		title: "RAG Extraction Providers",
	};
}

export default async function RagProvidersSettingsPage({
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
				title="RAG Providers"
				label="Configuration"
				description="Set up document embedding and extraction providers for knowledge retrieval."
			/>
			<SettingsList>
				<RagProvidersSettingsForm readOnly={!isAdmin} />
			</SettingsList>
		</>
	);
}
