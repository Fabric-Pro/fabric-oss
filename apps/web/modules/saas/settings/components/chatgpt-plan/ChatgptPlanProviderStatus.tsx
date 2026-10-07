"use client";

import { Badge } from "@ui/components/badge";
import { InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/** In the "configured" banner: the plan first, the API provider for the rest. */
export function ChatgptPlanProviderNote({
	organizationName,
}: {
	organizationName: string;
}) {
	const t = useTranslations("settings.chatgptPlan.providerStatus");
	return (
		<div className="space-y-2" data-testid="chatgpt-plan-provider-note">
			<div className="flex flex-wrap items-center gap-2">
				<Badge className="text-xs" variant="default">
					{t("chip")}
				</Badge>
				<p className="text-foreground text-sm">
					{t("ownWork", { organization: organizationName })}
				</p>
			</div>
			<p className="text-muted-foreground text-sm">
				{t("everythingElse")}
			</p>
		</div>
	);
}

/** Replaces "No AI Provider Configured" while the plan serves the member's own work. */
export function ChatgptPlanOnlyNotice({
	organizationName,
}: {
	organizationName: string;
}) {
	const t = useTranslations("settings.chatgptPlan.providerStatus");
	return (
		<div
			className="rounded-md border border-border bg-muted/40 p-4"
			data-testid="chatgpt-plan-only-notice"
		>
			<div className="flex items-start gap-3">
				<InfoIcon
					aria-hidden="true"
					className="size-5 shrink-0 text-muted-foreground"
				/>
				<div className="space-y-1">
					<p className="font-medium text-foreground">
						{t("onlyTitle")}
					</p>
					<p className="text-muted-foreground text-sm">
						{t("onlyDescription", {
							organization: organizationName,
						})}
					</p>
				</div>
			</div>
		</div>
	);
}
