"use client";

import {
	Component,
	type ReactNode,
	type RefObject,
	useCallback,
	useRef,
	useState,
} from "react";

/** The report's "Full report" state and root, as `AnalysisReport` takes them. */
export type AnalysisReportState = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	regionRef: RefObject<HTMLElement | null>;
};

/**
 * What the Internal Analysis panel holds for the run's report (Fizzy #2946):
 * whether "Full report" is open, and where focus goes when the shown run is
 * replaced.
 *
 * Returns the props for `AnalysisReport` and `runSwapFocus`, the element
 * that watches the shown run; the panel renders it after its body.
 */
export function useAnalysisReportState({
	shownRunId,
	denied,
	ownRerunRunId,
	headingRef,
}: {
	/** The run the panel shows, if any. */
	shownRunId: string | null;
	/** The server refused the analysis, so no run is shown. */
	denied: boolean;
	/** The run the member's own re-run started, once the server accepted it. */
	ownRerunRunId: string | null;
	/** The panel's heading: where focus lands when the report has nothing. */
	headingRef: RefObject<HTMLElement | null>;
}): { reportProps: AnalysisReportState; runSwapFocus: ReactNode } {
	// "Full report" stays as the member left it through polls and the greyed
	// remount, for as long as the same run is shown; a newer run starts it
	// closed.
	const [fullReport, setFullReport] = useState<{
		runId: string | null;
		open: boolean;
	}>({ runId: null, open: false });
	const fullReportOpen = fullReport.runId === shownRunId && fullReport.open;
	const setFullReportOpen = useCallback(
		(open: boolean) => setFullReport({ runId: shownRunId, open }),
		[shownRunId],
	);
	const reportRef = useRef<HTMLElement>(null);
	const onRunSwap = (runId: string | null, focusWasInReport: boolean) => {
		if (!focusWasInReport || runId === null || runId !== ownRerunRunId) {
			return;
		}
		const report = reportRef.current;
		const active = document.activeElement;
		// Focus the swap left where it was stays there.
		if (active && active !== document.body && !report?.contains(active)) {
			return;
		}
		(
			report?.querySelector<HTMLElement>(
				"[data-slot='collapsible-trigger']",
			) ??
			report?.querySelector<HTMLElement>("h3") ??
			headingRef.current
		)?.focus();
	};

	return {
		reportProps: {
			open: fullReportOpen,
			onOpenChange: setFullReportOpen,
			regionRef: reportRef,
		},
		runSwapFocus: (
			<RunSwapFocus
				runId={denied ? null : shownRunId}
				reportRef={reportRef}
				onSwap={onRunSwap}
			/>
		),
	};
}

/**
 * Notices the shown run being replaced and says whether focus was inside
 * the report just before the page changed — read before the commit, since
 * the full report closing with the old run removes whatever held focus
 * there, and nothing reliably reports focus lost that way.
 *
 * Only the swap to the run of the member's own re-run moves focus
 * (`onSwap` decides): back to "Full report", else the report's heading,
 * else the panel's. A swap a poll brings moves nothing.
 */
class RunSwapFocus extends Component<{
	runId: string | null;
	reportRef: RefObject<HTMLElement | null>;
	onSwap: (runId: string | null, focusWasInReport: boolean) => void;
}> {
	getSnapshotBeforeUpdate(previous: { runId: string | null }) {
		if (previous.runId === this.props.runId) {
			return null;
		}
		const report = this.props.reportRef.current;
		const active = document.activeElement;
		return !!report && !!active && report.contains(active);
	}

	componentDidUpdate(
		_previous: unknown,
		_state: unknown,
		focusWasInReport: boolean | null,
	) {
		if (focusWasInReport !== null) {
			this.props.onSwap(this.props.runId, focusWasInReport);
		}
	}

	render() {
		return null;
	}
}
