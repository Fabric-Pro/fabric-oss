import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { IntegrationProviderPageContent } from "@saas/data-connections/components/IntegrationProviderPageContent";
import {
	type DataConnectionProvider,
	getProviderMetadata,
} from "@saas/data-connections/lib/providers";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string; provider: string }>;
};

export default async function OrgIntegrationProviderPage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug, provider } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
		redirect("/app");
	}

	try {
		getProviderMetadata(provider as DataConnectionProvider);
	} catch {
		redirect(`/app/${organizationSlug}/settings/integrations`);
	}

	return (
		<SettingsList>
			<IntegrationProviderPageContent
				provider={provider as DataConnectionProvider}
				settingsBasePath={`/app/${organizationSlug}/settings/integrations`}
			/>
		</SettingsList>
	);
}
