import { LoginForm } from "@saas/auth/components/LoginForm";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("auth.login.title"),
	};
}

// TODO(B5-post-deploy): once legacy invitation emails (pre-HMAC) have expired
// (7-day window), remove the invitationId/email searchParams reading from
// LoginForm entirely and delete this legacy-warn path.
export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
	const params = await searchParams;
	if (params.invitationId) {
		console.warn(
			"[auth] invitation.legacy_query_param: invitationId arrived via query string on /auth/login — legacy email in-flight",
		);
	}
	return <LoginForm />;
}
