"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/** A focusable info mark whose tooltip explains a setting. */
export function InfoTip({ setting, text }: { setting: string; text: string }) {
	const t = useTranslations("settings.chatgptPlanPool");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					aria-label={t("tooltipLabel", { setting })}
					className="inline-flex rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					type="button"
				>
					<InfoIcon aria-hidden className="size-3.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs">{text}</TooltipContent>
		</Tooltip>
	);
}
