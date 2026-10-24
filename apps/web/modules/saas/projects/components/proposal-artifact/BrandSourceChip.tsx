"use client";

import type { ThemeTokenSource } from "@repo/utils/proposal-artifact/theme-tokens";
import { Badge } from "@ui/components/badge";
import { useTranslations } from "next-intl";

/**
 * Where a brand value comes from, as the Style tab names it (Fizzy #2946).
 * The proposer's own values are "Set for this document" when the Style holds
 * them; the recipient's are "Set by a person" or "Not set", since a person
 * types or confirms every one of them.
 */
export type BrandSourceLabel =
	| "document"
	| "brandKit"
	| "vendorSite"
	| "default"
	| "suggested"
	| "person"
	| "notSet";

/** The label of a proposer value from the source its token resolved from. */
export function proposerSourceLabel(
	source: ThemeTokenSource,
): BrandSourceLabel {
	switch (source) {
		case "MANUAL":
			return "document";
		case "BRAND_KIT":
			return "brandKit";
		case "VENDOR_SITE":
			return "vendorSite";
		case "FETCHED_UNCONFIRMED":
			return "suggested";
		default:
			return "default";
	}
}

/**
 * A value's source as a small text chip. Text, never colour alone: the
 * outline badge carries no meaning of its own, and a screen reader hears
 * "Source:" before the label.
 */
export function BrandSourceChip({ label }: { label: BrandSourceLabel }) {
	const t = useTranslations("projects.proposalArtifact.style");
	return (
		<Badge variant="outline" className="font-sans text-xs">
			<span className="sr-only">{t("sourcePrefix")} </span>
			{t(`sources.${label}`)}
		</Badge>
	);
}
