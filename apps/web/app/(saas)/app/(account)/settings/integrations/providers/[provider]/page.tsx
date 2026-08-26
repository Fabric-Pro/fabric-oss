import { getSession } from "@saas/auth/lib/server";
import { IntegrationProviderPageContent } from "@saas/data-connections/components/IntegrationProviderPageContent";
import {
	type DataConnectionProvider,
	getProviderMetadata,
} from "@saas/data-connections/lib/providers";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ provider: string }>;
};

export default async function IntegrationProviderPage({ params }: Props) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const { provider } = await params;

	try {
		getProviderMetadata(provider as DataConnectionProvider);
	} catch {
		redirect("/app/settings/integrations");
	}

	return (
		<SettingsList>
			<IntegrationProviderPageContent
				provider={provider as DataConnectionProvider}
				settingsBasePath="/app/settings/integrations"
			/>
		</SettingsList>
	);
}
