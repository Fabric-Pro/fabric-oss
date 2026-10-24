"use client";

import type { ThemeTokenSource } from "@repo/utils/proposal-artifact/theme-tokens";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { Button } from "@ui/components/button";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { BrandSourceChip, proposerSourceLabel } from "./BrandSourceChip";
import type { ProposerSources } from "./proposal-style-model";

/**
 * The proposer values a document cannot override, read-only with their
 * source: the logo, the fonts and the hero come from the Brand kit. An
 * organization admin is pointed there; anyone else is told who can change
 * them. The role check mirrors the Brand kit form's (admin or owner).
 */
export function BrandKitValues({ proposer }: { proposer: ProposerSources }) {
	const t = useTranslations("projects.proposalArtifact.style");
	const { activeOrganization, activeOrganizationUserRole } =
		useActiveOrganization();
	const isOrganizationAdmin =
		activeOrganizationUserRole === "admin" ||
		activeOrganizationUserRole === "owner";
	const fontText = (font: ProposerSources["fonts"]["display"]) =>
		font.hasFile ? t("fontWithFile", { family: font.family }) : font.family;

	const rows: Array<{
		key: string;
		label: string;
		value: string;
		source: ThemeTokenSource;
	}> = [
		{
			key: "logo",
			label: t("logo"),
			value: proposer.logo.present ? t("logoPresent") : t("logoMissing"),
			source: proposer.logo.source,
		},
		{
			key: "displayFont",
			label: t("displayFont"),
			value: fontText(proposer.fonts.display),
			source: proposer.fonts.display.source,
		},
		{
			key: "bodyFont",
			label: t("bodyFont"),
			value: fontText(proposer.fonts.body),
			source: proposer.fonts.body.source,
		},
		{
			key: "hero",
			label: t("hero"),
			value: proposer.hero.present ? t("heroPresent") : t("heroMissing"),
			source: proposer.hero.source,
		},
	];

	return (
		<div className="space-y-3">
			<h4 className="font-medium text-sm">{t("brandKitValues")}</h4>
			<dl className="space-y-2">
				{rows.map((row) => (
					<div
						key={row.key}
						className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
					>
						<dt className="w-32 shrink-0 text-muted-foreground">
							{row.label}
						</dt>
						<dd className="flex flex-wrap items-center gap-2">
							<span>{row.value}</span>
							<BrandSourceChip
								label={proposerSourceLabel(row.source)}
							/>
						</dd>
					</div>
				))}
			</dl>
			{isOrganizationAdmin && activeOrganization ? (
				<Button
					asChild
					variant="link"
					size="sm"
					className="h-auto px-0"
				>
					<Link
						href={`/app/${activeOrganization.slug}/settings/general`}
					>
						{t("changeInBrandKit")}
					</Link>
				</Button>
			) : (
				<p className="text-muted-foreground text-xs">{t("askAdmin")}</p>
			)}
		</div>
	);
}
