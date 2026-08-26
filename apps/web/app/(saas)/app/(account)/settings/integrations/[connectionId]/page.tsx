import { getSession } from "@saas/auth/lib/server";
import { ConnectionDetailPageContent } from "@saas/data-connections/components/ConnectionDetailPageContent";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ connectionId: string }>;
};

export default async function IntegrationConnectionDetailPage({
	params,
}: Props) {
	const session = await getSession();
	const { connectionId } = await params;
	if (!session) {
		redirect("/auth/login");
	}

	return (
		<>
			<SettingsHero
				title="Integration Details"
				label="Integrations"
				description="Review sync health, freshness, and indexed resources for this integration."
			/>
			<SettingsList>
				<ConnectionDetailPageContent connectionId={connectionId} />
			</SettingsList>
		</>
	);
}
