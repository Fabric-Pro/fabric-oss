import { config } from "@repo/config";
import { SignupForm } from "@saas/auth/components/SignupForm";
import { getInvitation } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { withQuery } from "ufo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("auth.signup.title"),
	};
}
// TODO(B5-post-deploy): once legacy invitation emails (pre-HMAC) have expired
// (7-day window), remove the invitationId/email searchParams reading from
// SignupForm and this legacy lookup path.
export default async function SignupPage({
	searchParams,
}: {
	searchParams: Promise<{
		[key: string]: string | string[] | undefined;
		invitationId?: string;
	}>;
}) {
	const params = await searchParams;
	const { invitationId } = params;

	if (!(config.auth.enableSignup || invitationId)) {
		redirect(withQuery("/auth/login", params));
	}

	if (invitationId) {
		console.warn(
			"[auth] invitation.legacy_query_param: invitationId arrived via query string on /auth/signup — legacy email in-flight",
		);
		const invitation = await getInvitation(invitationId);

		if (
			!invitation ||
			invitation.status !== "pending" ||
			invitation.expiresAt.getTime() < Date.now()
		) {
			redirect(withQuery("/auth/login", params));
		}

		return <SignupForm email={invitation.email} />;
	}

	return <SignupForm />;
}
