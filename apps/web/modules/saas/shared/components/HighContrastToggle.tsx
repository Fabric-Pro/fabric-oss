"use client";

import { useContrastPreference } from "@saas/shared/components/ContrastPreferenceProvider";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { ContrastIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * The high-contrast switch beside the colour-mode control (Fizzy #1444,
 * GAP-1): the sidebar footer, where the light/dark control already lives, so
 * the two appearance controls are found in the same place.
 *
 * A toggle button: the accessible name stays "High contrast" and the state is
 * `aria-pressed`, which is what a screen reader announces as on/off — a label
 * that flipped between "Turn on…" and "Turn off…" would read as two different
 * controls (AC-9). Renders nothing outside the authenticated app.
 *
 * `pill` matches the segmented colour-mode control it sits next to; `rail` is
 * the square icon button the collapsed sidebar stacks its controls as.
 */
export function HighContrastToggle({
	variant = "pill",
	className,
}: {
	variant?: "pill" | "rail";
	className?: string;
}) {
	const t = useTranslations("app.userMenu");
	const contrast = useContrastPreference();

	if (!contrast) {
		return null;
	}

	const { highContrast, setHighContrast } = contrast;
	const label = t("highContrast");

	if (variant === "rail") {
		return (
			<Button
				variant="ghost"
				size="icon"
				aria-label={label}
				aria-pressed={highContrast}
				data-testid="high-contrast-toggle"
				onClick={() => setHighContrast(!highContrast)}
				className={cn(
					"rounded-md border border-border bg-card shadow-xs hover:bg-muted",
					highContrast && "bg-accent text-foreground",
					className,
				)}
			>
				<ContrastIcon className="size-4" aria-hidden="true" />
			</Button>
		);
	}

	return (
		<TooltipProvider delayDuration={0}>
			<Tooltip>
				<TooltipTrigger asChild>
					<div
						className={cn(
							"inline-flex items-center rounded-md border border-border bg-muted p-0.5",
							className,
						)}
					>
						<button
							type="button"
							aria-label={label}
							aria-pressed={highContrast}
							data-testid="high-contrast-toggle"
							onClick={() => setHighContrast(!highContrast)}
							className={cn(
								"flex h-6 w-6 items-center justify-center rounded-sm border transition-colors",
								"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
								highContrast
									? "border-border bg-background text-foreground shadow-xs"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
						>
							<ContrastIcon
								className="size-3.5"
								aria-hidden="true"
							/>
						</button>
					</div>
				</TooltipTrigger>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
