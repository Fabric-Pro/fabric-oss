import { humanizeReportError } from "@saas/reports/lib/report-error-messages";
import { toast } from "sonner";

export type ReportGenerateOutcome =
	| { outcome: "started"; instanceId: string; startConfirmed: boolean }
	| { outcome: "refused"; instanceId: string; reason: string };

/**
 * Where a person lands once a new report's run is decided: its run history when
 * it started, its page with the reason when it was refused. The refusal stays
 * until dismissed, as a refused Generate does on that page.
 */
export function routeGenerateOutcome(
	result: ReportGenerateOutcome,
	reportTemplatesPath: string,
	push: (href: string) => void,
): void {
	const reportHref = `${reportTemplatesPath}/instances/${result.instanceId}`;
	switch (result.outcome) {
		case "started":
			if (result.startConfirmed) {
				toast.success("Report generation started");
			} else {
				toast.info("Report queued; waiting for execution confirmation");
			}
			push(`${reportHref}?tab=history`);
			return;
		case "refused":
			toast.error(humanizeReportError(result.reason, "generate"), {
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
			});
			push(reportHref);
			return;
		default: {
			const unreachable: never = result;
			throw new Error(`Unhandled generate outcome: ${unreachable}`);
		}
	}
}
