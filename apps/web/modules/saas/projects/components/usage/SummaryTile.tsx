import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { HelpCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

export function SummaryTile({
	label,
	value,
	subtitle,
	tooltip,
}: {
	label: string;
	value: string;
	subtitle?: string;
	tooltip?: ReactNode;
}) {
	return (
		<Card className="h-full bg-muted/40">
			<CardHeader className="pb-1">
				<CardTitle className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
					{label}
					{tooltip ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className="text-muted-foreground/60 hover:text-muted-foreground"
									aria-label={`${label} details`}
								>
									<HelpCircleIcon className="h-3.5 w-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs text-xs">
								{tooltip}
							</TooltipContent>
						</Tooltip>
					) : null}
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="font-display text-2xl font-semibold tabular-nums">
					{value}
				</div>
				{subtitle ? (
					<div className="mt-0.5 text-[11px] text-muted-foreground">
						{subtitle}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
