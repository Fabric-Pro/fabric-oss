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
}: {
	value: UiMode;
	onChange: (next: UiMode) => void;
	/** Held while a turn streams: switching mid-reply would swap the surface under it. */
	disabled?: boolean;
	compact?: boolean;
}) {
	const t = useTranslations("tooltips.agents");

	return (
		<TooltipProvider>
			<fieldset
				title={disabled ? INTERFACE_MODE_STREAMING_NOTE : undefined}
				className={cn(
					"m-0 flex min-w-0 items-center gap-1 rounded-md border border-border/60 bg-card/35",
					compact ? "p-0.5" : "p-1",
				)}
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
										"flex items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50",
										compact
											? "h-6 px-2 text-[11px]"
											: "h-9 gap-1.5 px-2.5 text-xs",
										active
											? "bg-background text-foreground shadow-sm"
											: "text-muted-foreground hover:bg-background/50",
									)}
								>
									<span className="font-medium capitalize">
										{mode}
									</span>
								</button>
							</TooltipTrigger>
							<TooltipContent>
								<p>{t(`interfaceMode.${mode}`)}</p>
							</TooltipContent>
						</Tooltip>
					);
				})}
			</fieldset>
		</TooltipProvider>
	);
}
