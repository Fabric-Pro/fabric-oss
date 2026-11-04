"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

type Options = {
	instanceId: string;
	organizationId: string | null;
	/**
	 * Test on its own: once when the page opens and again right before a
	 * run, so a broken connection shows in the readiness rail before the
	 * person waits on a report.
	 */
	automatic: boolean;
	onError: (message: string) => void;
};

/**
 * The report page's "Test connections" check. A test the person starts
 * reports its result in a toast; an automatic one only updates the
 * readiness rail. A test never starts while another is running.
 */
export function useReportConnectionTest({
	instanceId,
	organizationId,
	automatic,
	onError,
}: Options) {
	const mutation = useMutation({
		mutationFn: (_request: { announce: boolean }) =>
			orpcClient.reports.instances.testConnections({
				instanceId,
				organizationId,
			}),
		onSuccess: (res, { announce }) => {
			if (!announce) {
				return;
			}
			const bad = res.diagnostics.filter(
				(d) => d.outcome !== "connected",
			);
			if (bad.length) {
				toast.warning(
					`${bad.length} data source${bad.length === 1 ? "" : "s"} need attention`,
				);
			} else {
				toast.success("All data sources connected");
			}
		},
		onError: (error, { announce }) => {
			if (announce) {
				onError(error.message);
			}
		},
	});

	const { mutate, isPending } = mutation;
	const run = useCallback(
		(announce: boolean) => {
			if (!isPending) {
				mutate({ announce });
			}
		},
		[mutate, isPending],
	);

	// Marked only when the test actually starts: while another test is
	// running, the effect runs again once it ends (`isPending` changes).
	const testedOnOpenRef = useRef<string | null>(null);
	useEffect(() => {
		if (automatic && !isPending && testedOnOpenRef.current !== instanceId) {
			testedOnOpenRef.current = instanceId;
			mutate({ announce: false });
		}
	}, [automatic, instanceId, isPending, mutate]);

	return {
		data: mutation.data,
		isPending,
		/** The person asked: report the result. */
		test: () => run(true),
		/** Right before a run: the rail shows the result, the run goes ahead. */
		testBeforeRun: () => {
			if (automatic) {
				run(false);
			}
		},
	};
}
