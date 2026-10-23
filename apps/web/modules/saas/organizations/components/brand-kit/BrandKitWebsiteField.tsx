"use client";

import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { BrandKitSiteFetch } from "./BrandKitSiteFetch";
import type { BrandKitSiteFetchState } from "./use-brand-kit-site-fetch";

const ids = {
	input: "organization-brand-kit-website",
	help: "organization-brand-kit-website-help",
	error: "organization-brand-kit-website-error",
	found: "organization-brand-kit-site-colors",
};

/**
 * The website the kit's colors are fetched from: the draft's entry, and below
 * it the stored website's fetch.
 */
export function BrandKitWebsiteField({
	value,
	invalid,
	disabled,
	onChange,
	storedWebsite,
	siteFetch,
	canEdit,
	saving,
}: {
	value: string;
	/** The last save refused the entry as `invalidWebsite`. */
	invalid: boolean;
	disabled: boolean;
	onChange: (value: string) => void;
	storedWebsite: string | null;
	siteFetch: BrandKitSiteFetchState;
	canEdit: boolean;
	/** A save is in flight. */
	saving: boolean;
}) {
	const t = useTranslations("settings.brandKit");
	return (
		<div className="space-y-2">
			<Label htmlFor={ids.input}>{t("website")}</Label>
			<Input
				id={ids.input}
				// Text, not `url`: a bare host such as example.com is the
				// expected entry, and the server normalizes it to its https://
				// origin.
				type="text"
				inputMode="url"
				autoComplete="url"
				placeholder={t("websitePlaceholder")}
				aria-describedby={
					invalid ? `${ids.help} ${ids.error}` : ids.help
				}
				aria-invalid={invalid}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
			/>
			<p id={ids.help} className="text-muted-foreground text-xs">
				{t("websiteHelp")}
			</p>
			{invalid && (
				<p
					id={ids.error}
					role="alert"
					className="text-destructive text-sm"
				>
					{t("saveError.invalidWebsite")}
				</p>
			)}
			<BrandKitSiteFetch
				id={ids.found}
				website={storedWebsite}
				siteFetch={siteFetch}
				canEdit={canEdit}
				saving={saving}
			/>
		</div>
	);
}
