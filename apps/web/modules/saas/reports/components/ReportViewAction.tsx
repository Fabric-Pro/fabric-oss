"use client";

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { EyeIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useId } from "react";

export const NO_SUCCESSFUL_REPORT_MESSAGE =
	"No successful report available yet.";

/** The query parameter that opens a report page on its latest successful report. */
export const VIEW_LATEST_REPORT_PARAM = "view";
export const VIEW_LATEST_REPORT_VALUE = "latest";

/** A report page that opens on its latest successful report. */
export function viewLatestReportHref(reportHref: string): string {
	return `${reportHref}?tab=history&${VIEW_LATEST_REPORT_PARAM}=${VIEW_LATEST_REPORT_VALUE}`;
}

/**
 * View, which opens the report's latest successful run. Before one exists it
 * stays visible but disabled, with the reason as visible text rather than a
 * tooltip, so touch and screen-reader users read it too.
 */
export function ReportViewAction({
	hasSuccessfulReport,
	href,
	onView,
	isOpening = false,
	size = "sm",
	className,
}: {
	hasSuccessfulReport: boolean;
	/** Where View goes; give this or `onView`. */
	href?: string;
	onView?: () => void;
	isOpening?: boolean;
	size?: "sm" | "default";
	className?: string;
}) {
	const reasonId = useId();
	const icon = isOpening ? (
		<Loader2Icon className="mr-1 h-3 w-3 motion-safe:animate-spin" />
	) : (
		<EyeIcon className="mr-1 h-3 w-3" />
	);

	if (!hasSuccessfulReport) {
		return (
			<span className={cn("inline-flex flex-col gap-1", className)}>
				<Button
					variant="outline"
					size={size}
					disabled
					aria-describedby={reasonId}
				>
					{icon}
					View
				</Button>
				<span id={reasonId} className="text-xs text-muted-foreground">
					{NO_SUCCESSFUL_REPORT_MESSAGE}
				</span>
			</span>
		);
	}

	if (href) {
		return (
			<Button variant="outline" size={size} asChild className={className}>
				<Link href={href} aria-label="View latest successful report">
					{icon}
					View
				</Link>
			</Button>
		);
	}

	return (
		<Button
			variant="outline"
			size={size}
			onClick={onView}
			disabled={isOpening}
			aria-label="View latest successful report"
			className={className}
		>
			{icon}
			View
		</Button>
	);
}
