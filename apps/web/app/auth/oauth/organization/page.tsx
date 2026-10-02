import { OAuthOrganizationPicker } from "@saas/oauth/components/OAuthOrganizationPicker";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations("auth.oauth.organization");

	return { title: t("title") };
}

export default function OAuthOrganizationPage() {
	return <OAuthOrganizationPicker />;
}
