"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import type { ReactNode } from "react";

/**
 * What a member's ChatGPT plan usage would have cost on API billing, shown
 * where the real cost reads $0 (Fizzy #2939). Only an estimate: the plan's
 * calls billed the organization nothing.
 */
function planCoveredEstimateTooltip({
	formattedEstimate,
	referenceModels,
}: {
	formattedEstimate: string;
	referenceModels: string[];
}): string {
	return `Covered by members' ChatGPT plans, so nothing was billed. At the provider's API list prices these tokens would have cost about ${formattedEstimate} (estimate, priced as ${referenceModels.join(", ")}).`;
}

/**
 * The estimate struck through — "would have cost, wasn't charged" — with the
 * explanation on hover and focus. `children` replaces the struck amount, for
 * a line that words it differently.
 */
export function PlanCoveredEstimate({
	formattedEstimate,
	referenceModels,
	className,
	testId,
	children,
}: {
	formattedEstimate: string;
	referenceModels: string[];
	className?: string;
	testId?: string;
	children?: ReactNode;
}) {
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className={cn(
							"cursor-help tabular-nums text-muted-foreground underline-offset-2 hover:underline hover:decoration-dotted",
							className,
						)}
						data-testid={testId}
						// Inside a clickable tile, a press here only explains.
						onClick={(event) => event.stopPropagation()}
					>
						{children ?? (
							<>
								<span className="sr-only">
									Not billed; estimated API cost{" "}
								</span>
								<s>{formattedEstimate}</s>
							</>
						)}
					</button>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs text-xs">
					{planCoveredEstimateTooltip({
						formattedEstimate,
						referenceModels,
					})}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
