"use client";

import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useFocusMode } from "../contexts/FocusModeContext";

export function FocusModeToggle() {
	const { isFocusMode, isFocusModeAvailable, toggleFocusMode } =
		useFocusMode();
	const t = useTranslations("tooltips.common");

	if (!isFocusModeAvailable) {
		return null;
	}

	const titleText = isFocusMode ? t("exitFocusMode") : t("enterFocusMode");
	const hintText = isFocusMode
		? t("exitFocusModeHint")
		: t("enterFocusModeHint");

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant={isFocusMode ? "secondary" : "outline"}
						size="sm"
						onClick={toggleFocusMode}
						className={cn(
							"h-8 px-2.5 gap-1.5 transition-colors text-xs font-medium shrink-0",
							isFocusMode &&
								"border-primary/40 bg-primary/15 text-primary hover:bg-primary/20",
						)}
					>
						{isFocusMode ? (
							<Minimize2Icon className="h-3.5 w-3.5" />
						) : (
							<Maximize2Icon className="h-3.5 w-3.5" />
						)}
						<span>{titleText}</span>
					</Button>
				</TooltipTrigger>
				<TooltipContent surface="popover">
					<p className="text-xs text-muted-foreground">{hintText}</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
