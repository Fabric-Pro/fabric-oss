import type { AiModelFit } from "@repo/utils/ai-model-fit";
import { cn } from "@ui/lib";
import { InfoIcon, TriangleAlertIcon } from "lucide-react";

/** A static advisory, without live-region announcements. */
export function ModelFitIndicator({
	fit,
	message,
	compact = false,
}: {
	fit: AiModelFit;
	message: string;
	compact?: boolean;
}) {
	const Icon = fit.kind === "quality" ? TriangleAlertIcon : InfoIcon;
	return (
		<span
			className={cn(
				"inline-flex items-start gap-1 text-xs",
				fit.kind === "quality"
					? "text-highlight"
					: "text-muted-foreground",
			)}
		>
			<Icon
				role={compact ? "img" : undefined}
				aria-label={compact ? message : undefined}
				aria-hidden={compact ? undefined : true}
				className="size-3.5 shrink-0"
			>
				{compact && <title>{message}</title>}
			</Icon>
			{!compact && <span>{message}</span>}
		</span>
	);
}
