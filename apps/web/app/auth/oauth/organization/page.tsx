import { getSession } from "@saas/auth/lib/server";
import { OAuthOrganizationPicker } from "@saas/oauth/components/OAuthOrganizationPicker";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations("auth.oauth.organization");

	return { title: t("title") };
}

export default async function OAuthOrganizationPage() {
	const session = await getSession();
	if (session?.user.mustChangePassword) {
		redirect("/change-password");
	}

	return <OAuthOrganizationPicker />;
}
