import { getSession } from "@saas/auth/lib/server";
import { OAuthConsent } from "@saas/oauth/components/OAuthConsent";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations("auth.oauth.consent");

	return { title: t("label") };
}

export default async function OAuthConsentPage() {
	const session = await getSession();
	if (session?.user.mustChangePassword) {
		redirect("/change-password");
	}

	return <OAuthConsent />;
}
