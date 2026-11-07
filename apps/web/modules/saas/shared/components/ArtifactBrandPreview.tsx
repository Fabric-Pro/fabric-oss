"use client";

import type { ArtifactCoverStyle } from "@repo/utils/artifact-brand-theme";
import { Input } from "@ui/components/input";
import { useTranslations } from "next-intl";

export type ArtifactBrandPreviewValue = {
	primaryColor: string;
	accentColors: string[];
	displayFontFamily: string;
	bodyFontFamily: string;
	coverStyle: ArtifactCoverStyle;
};

/** A review of saved formatting values; no assets, scripts or remote preview loads. */
export function ArtifactBrandPreview({
	value,
	companyName,
	clientName,
}: {
	value: ArtifactBrandPreviewValue;
	companyName?: string | null;
	clientName?: string | null;
}) {
	const t = useTranslations("artifactBranding");
	return (
		<dl className="grid gap-4 text-sm sm:grid-cols-2">
			{companyName && (
				<div className="min-w-0">
					<dt className="text-muted-foreground text-xs">
						{t("preparedBy")}
					</dt>
					<dd className="break-words">{companyName}</dd>
				</div>
			)}
			{clientName && (
				<div className="min-w-0">
					<dt className="text-muted-foreground text-xs">
						{t("preparedFor")}
					</dt>
					<dd className="break-words">{clientName}</dd>
				</div>
			)}
			<div className="min-w-0 sm:col-span-2">
				<dt className="text-muted-foreground text-xs">{t("colors")}</dt>
				<dd className="flex flex-wrap gap-3">
					{Array.from(
						new Set([value.primaryColor, ...value.accentColors]),
					).map((color) => (
						<span
							key={color}
							className="inline-flex items-center gap-2"
						>
							<Input
								type="color"
								value={color}
								disabled
								className="h-6 w-8 p-0"
								aria-label={t("colorValue", { value: color })}
							/>
							<span>{color}</span>
						</span>
					))}
				</dd>
			</div>
			<div>
				<dt className="text-muted-foreground text-xs">
					{t("headingFont")}
				</dt>
				<dd>{value.displayFontFamily}</dd>
			</div>
			<div>
				<dt className="text-muted-foreground text-xs">
					{t("bodyFont")}
				</dt>
				<dd>{value.bodyFontFamily}</dd>
			</div>
			<div>
				<dt className="text-muted-foreground text-xs">
					{t("coverStyle")}
				</dt>
				<dd>{t(`cover.${value.coverStyle}`)}</dd>
			</div>
		</dl>
	);
}
