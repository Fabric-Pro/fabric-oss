"use client";

import { BrandColorListField } from "@saas/shared/components/BrandColorListField";
import { websiteHost } from "@saas/shared/lib/brand-fetch-polling";
import { Button } from "@ui/components/button";
import { AlertCircle, RefreshCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { BrandKitSiteFetchState } from "./use-brand-kit-site-fetch";

/**
 * The stored website's fetch below the website field: its status, Fetch
 * again, and the colors it found, shown as a source and never copied into
 * the kit's own fields.
 */
export function BrandKitSiteFetch({
	id,
	website,
	siteFetch,
	canEdit,
	saving,
}: {
	/** The found colors' field id. */
	id: string;
	/** The stored website, not the one being typed. */
	website: string | null;
	siteFetch: BrandKitSiteFetchState;
	canEdit: boolean;
	/** A save is in flight: hold Fetch again. */
	saving: boolean;
}) {
	const t = useTranslations("settings.brandKit");
	const { status } = siteFetch;
	const host = website ? websiteHost(website) : "";
	const statusText = (() => {
		switch (status.state) {
			case "running":
				return t("siteFetch.running", { host });
			case "found":
				return t("siteFetch.found", { host });
			case "failed":
				return t(`siteFetch.failed.${status.code}`, { host });
			default:
				return t("siteFetch.notFetched", { host });
		}
	})();

	return (
		<>
			<div className="flex flex-wrap items-center gap-3">
				{/* Always mounted (an implicit polite status), so screen
				    readers announce what it becomes. */}
				<output className="flex items-center gap-2 text-muted-foreground text-sm">
					{website && status.state === "failed" && (
						<AlertCircle
							className="size-4 shrink-0"
							aria-hidden="true"
						/>
					)}
					{website ? statusText : null}
				</output>
				{canEdit && website && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						loading={siteFetch.isPending}
						disabled={status.state === "running" || saving}
						onClick={() => siteFetch.run(false)}
					>
						<RefreshCwIcon className="size-4" aria-hidden="true" />
						{t("siteFetch.fetchAgain")}
					</Button>
				)}
			</div>
			{website && status.state === "found" && (
				<BrandColorListField
					id={id}
					legend={t("siteFetch.foundColors")}
					description={t("siteFetch.foundColorsHelp")}
					colors={status.colors}
					max={status.colors.length}
					disabled
					labels={{
						hex: (position) =>
							t("siteFetch.foundHex", { position }),
						picker: (position) =>
							t("siteFetch.foundPicker", { position }),
						remove: (position) =>
							t("siteFetch.foundHex", { position }),
						add: t("siteFetch.foundColors"),
						invalid: t("invalidColor"),
						empty: t("siteFetch.foundColors"),
					}}
					onChange={() => undefined}
				/>
			)}
		</>
	);
}
