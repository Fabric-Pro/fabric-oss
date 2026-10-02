import { ConnectedAgentsSettings } from "@saas/settings/components/ConnectedAgentsSettings";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
	const t = await getTranslations("settings.connectedAgents");

	return { title: t("title") };
}

/**
 * The coding agents signed in as this account. Account-global, like its
 * siblings under `settings/account/*`: the organization in the URL is only
 * where the page is reached from, and each row names the organization its agent
 * was approved for.
 */
export default function OrganizationAccountConnectedAgentsPage() {
	return <ConnectedAgentsSettings />;
}
