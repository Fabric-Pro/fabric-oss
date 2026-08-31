import { AccountSecuritySettings } from "@saas/settings/components/AccountSecuritySettings";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("settings.account.security.title"),
	};
}

/**
 * The organization-reachable home for ACCOUNT security settings (Fizzy #1875,
 * R7/R9). It renders the same component as `/app/settings/security` and
 * deliberately ignores `organizationSlug` beyond the URL it sits at: password,
 * passkeys, two-factor and sessions are account-global, so there is nothing
 * here to scope and nothing to move. Passing the organization in would invent
 * per-organization security settings the product does not have.
 */
export default async function OrganizationAccountSecurityPage({
	searchParams,
}: {
	searchParams: Promise<{ mfaRequired?: string; from?: string }>;
}) {
	const { mfaRequired } = await searchParams;

	return <AccountSecuritySettings mfaRequired={mfaRequired === "1"} />;
}
