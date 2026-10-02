"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { Card } from "@ui/components/card";
import { InfoIcon, LockIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { CompanyContextList } from "./CompanyContextList";

type CompanyContextPanelProps = {
	/** The organization the page was opened for, resolved from the URL slug. */
	organizationId: string;
	organizationSlug: string;
};

/**
 * The company context page body (Fizzy #2719): what the organization
 * maintains about itself for Proposals and Business Cases, opening with where
 * that material goes — into client-facing documents that may quote it.
 *
 * Behind the COMPANY_CONTEXT gate; the server page already 404s with it off,
 * and with it off here nothing renders and nothing is fetched.
 *
 * Every member sees the sources and can download them; only admins and owners
 * change them. The role check mirrors the server's (`requireOrgMembership`
 * with admin or owner) rather than `isOrganizationAdmin`, which also admits
 * platform admins the write procedures would refuse — and it only counts for
 * the organization this page is for.
 */
export function CompanyContextPanel({
	organizationId,
	organizationSlug,
}: CompanyContextPanelProps) {
	const enabled = useFeatureFlag("COMPANY_CONTEXT");
	const { activeOrganization, activeOrganizationUserRole } =
		useActiveOrganization();
	const t = useTranslations("settings.companyContext");

	if (!enabled || !activeOrganization) {
		return null;
	}

	const canEdit =
		activeOrganization.id === organizationId &&
		(activeOrganizationUserRole === "admin" ||
			activeOrganizationUserRole === "owner");

	return (
		<SettingsList>
			<Card
				className="rounded-md p-4 md:p-6"
				data-testid="company-context-usage"
			>
				<div className="flex items-start gap-3">
					<InfoIcon
						className="mt-0.5 size-4 shrink-0 text-primary"
						aria-hidden="true"
					/>
					<div className="space-y-1.5">
						<h2 className="font-medium text-sm">
							{t("usage.title")}
						</h2>
						<p className="text-muted-foreground text-sm">
							{t("usage.body")}
						</p>
						<p className="text-muted-foreground text-sm">
							{t("usage.scope")}
						</p>
					</div>
				</div>
			</Card>

			{canEdit ? null : (
				<p
					className="flex items-start gap-2 text-muted-foreground text-sm"
					data-testid="company-context-read-only"
				>
					<LockIcon
						className="mt-0.5 size-4 shrink-0"
						aria-hidden="true"
					/>
					<span>{t("readOnly")}</span>
				</p>
			)}

			<CompanyContextList
				organizationId={organizationId}
				organizationSlug={organizationSlug}
				canEdit={canEdit}
			/>
		</SettingsList>
	);
}
