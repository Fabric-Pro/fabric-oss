import { OAuthConsent } from "@saas/oauth/components/OAuthConsent";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations("auth.oauth.consent");

	return { title: t("label") };
}

export default function OAuthConsentPage() {
	return <OAuthConsent />;
}
