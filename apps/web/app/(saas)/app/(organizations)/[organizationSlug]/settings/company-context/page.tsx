import { isFeatureEnabled } from "@repo/database";
import { getActiveOrganization } from "@saas/auth/lib/server";
import { CompanyContextPanel } from "@saas/organizations/components/company-context/CompanyContextPanel";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

export const metadata = {
	title: "Company context",
};

/**
 * Organization settings → Company context (Fizzy #2719): the material an
 * organization maintains once about itself, which Proposal and Business Case
 * generation draw on.
 *
 * The settings layout already sends project guests away. With the
 * COMPANY_CONTEXT gate off for this organization the page does not exist —
 * the same NOT_FOUND its procedures answer.
 */
export default async function OrgCompanyContextSettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;

	// Resolve the org from the URL slug — the per-tab source of truth — never
	// from the session's active organization, which another tab may have
	// changed.
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		notFound();
	}

	if (!(await isFeatureEnabled("COMPANY_CONTEXT", organization.id))) {
		notFound();
	}

	const t = await getTranslations("settings.companyContext");

	return (
		<>
			<SettingsHero title={t("title")} description={t("description")} />
			<CompanyContextPanel
				organizationId={organization.id}
				organizationSlug={organizationSlug}
			/>
		</>
	);
}
