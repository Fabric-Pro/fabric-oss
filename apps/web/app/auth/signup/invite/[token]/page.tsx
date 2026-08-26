import { parseInvitationToken } from "@repo/auth/lib/invitation-token";
import { SignupForm } from "@saas/auth/components/SignupForm";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations();
	return { title: t("auth.signup.title") };
}

interface PageProps {
	params: Promise<{ token: string }>;
}

export default async function SignupInvitePage({ params }: PageProps) {
	const { token } = await params;
	const v = parseInvitationToken(decodeURIComponent(token));
	if (!v.ok) {
		redirect("/auth/login?error=invalid_invitation");
	}
	const { invitationId, email } = v.payload;
	return <SignupForm invitationId={invitationId} email={email} />;
}
