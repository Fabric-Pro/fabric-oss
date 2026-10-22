import { cn } from "@ui/lib";
import {
	CircleCheckIcon,
	CircleDashedIcon,
	CircleSlashIcon,
	CircleXIcon,
	ClockAlertIcon,
	Loader2Icon,
} from "lucide-react";

/**
 * One glyph per run or step status. Both vocabularies are plain strings on
 * the wire (`WorkflowExecutionStatus`, a log's status), so an unknown value
 * falls back to the neutral "not started" circle.
 */
export function RunStatusIcon({
	status,
	className,
}: {
	status: string;
	className?: string;
}) {
	const base = cn("size-3.5 shrink-0", className);
	switch (status) {
		case "COMPLETED":
			return (
				<CircleCheckIcon
					className={cn(base, "text-success")}
					aria-label="Completed"
				/>
			);
		case "FAILED":
			return (
				<CircleXIcon
					className={cn(base, "text-destructive")}
					aria-label="Failed"
				/>
			);
		case "RUNNING":
			return (
				<Loader2Icon
					className={cn(
						base,
						"text-foreground motion-safe:animate-spin",
					)}
					aria-label="Running"
				/>
			);
		case "TIMED_OUT":
			return (
				<ClockAlertIcon
					className={cn(base, "text-highlight")}
					aria-label="Timed out"
				/>
			);
		case "CANCELLED":
		case "SKIPPED":
			return (
				<CircleSlashIcon
					className={cn(base, "text-muted-foreground")}
					aria-label={status === "SKIPPED" ? "Skipped" : "Cancelled"}
				/>
			);
		default:
			return (
				<CircleDashedIcon
					className={cn(base, "text-muted-foreground")}
					aria-label="Pending"
				/>
			);
	}
}
