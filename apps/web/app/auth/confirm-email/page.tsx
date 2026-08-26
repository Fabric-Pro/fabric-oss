import { ConfirmEmailForm } from "@saas/auth/components/ConfirmEmailForm";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations();
	return { title: t("auth.confirmEmail.title") };
}

export default async function ConfirmEmailPage({
	searchParams,
}: {
	searchParams: Promise<{ token?: string }>;
}) {
	const { token } = await searchParams;
	return <ConfirmEmailForm token={token} />;
}
