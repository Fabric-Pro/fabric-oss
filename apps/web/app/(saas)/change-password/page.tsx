import { getSession } from "@saas/auth/lib/server";
import { ForceChangePasswordForm } from "@saas/auth/components/ForceChangePasswordForm";
import { AuthWrapper } from "@saas/shared/components/AuthWrapper";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations("changePassword");

	return {
		title: t("title"),
	};
}

export default async function ChangePasswordPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	if (!session.user.mustChangePassword) {
		redirect("/app");
	}

	return (
		<AuthWrapper>
			<ForceChangePasswordForm />
		</AuthWrapper>
	);
}
