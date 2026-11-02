"use client";

import type { UiMode } from "@repo/database";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";

const MODES = ["simple", "advanced"] as const satisfies readonly UiMode[];

const INTERFACE_MODE_STREAMING_NOTE =
	"Available once the reply being written finishes.";

/**
 * Simple / Advanced segmented control (Fizzy #2040), shared by the full page
 * and the ⌘J drawer so the two read the same and write the same preference.
 */
export function InterfaceModeToggle({
	value,
	onChange,
	disabled = false,
	compact = false,
	tooltipNamespace = "tooltips.agents.interfaceMode",
}: {
	value: UiMode;
	onChange: (next: UiMode) => void;
	/** Held while a turn streams: switching mid-reply would swap the surface under it. */
	disabled?: boolean;
	compact?: boolean;
	tooltipNamespace?:
		| "tooltips.agents.interfaceMode"
		| "tooltips.publishing.interfaceMode";
}) {
	const t = useTranslations(tooltipNamespace);

	return (
		<TooltipProvider>
			<fieldset
				title={disabled ? INTERFACE_MODE_STREAMING_NOTE : undefined}
				className="m-0 flex min-w-0 items-center gap-0.5 rounded-full border border-border bg-muted/60 p-0.5"
			>
				<legend className="sr-only">Interface mode</legend>
				{MODES.map((mode) => {
					const active = value === mode;
					return (
						<Tooltip key={mode}>
							<TooltipTrigger asChild>
								<button
									type="button"
									disabled={disabled}
									onClick={() => {
										if (mode !== value) {
											onChange(mode);
										}
									}}
									aria-pressed={active}
									className={cn(
										"flex items-center justify-center rounded-full transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
										compact
											? "h-6 px-2.5 text-xs"
											: "h-7 gap-1.5 px-3 text-xs",
										active
											? "border border-border bg-card text-foreground shadow-2xs"
											: "border border-transparent text-muted-foreground hover:text-foreground",
									)}
								>
									<span className="font-medium capitalize">
										{mode}
									</span>
								</button>
							</TooltipTrigger>
							<TooltipContent>
								<p>{t(mode)}</p>
							</TooltipContent>
						</Tooltip>
					);
				})}
			</fieldset>
		</TooltipProvider>
	);
}
