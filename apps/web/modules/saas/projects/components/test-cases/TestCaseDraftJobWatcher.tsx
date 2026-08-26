"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isDraftJobActive } from "./draft-jobs";
import { TestCaseDraftResultsSheet } from "./TestCaseDraftResultsSheet";

type Props = {
	projectId: string;
	organizationId: string | null;
};

/** Poll cadence while a run is in flight. */
const POLL_MS = 3000;

/**
 * Follows the caller's drafting runs and surfaces them without holding the UI.
 *
 * This is what makes the background run visible again after the dialog closes —
 * and, crucially, after a reload. It asks the server "do I have a run here?" on
 * mount rather than remembering anything client-side, so a run started before a
 * refresh (or in another tab) is picked back up. The job row is the source of
 * truth; this component only reflects it.
 *
 * Mounted by `AiDraftDialog`, which the cases list renders unconditionally — so
 * the watcher outlives the dialog being closed.
 */
export function TestCaseDraftJobWatcher({ projectId, organizationId }: Props) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();
	const searchParams = useSearchParams();
	const [resultsJobId, setResultsJobId] = useState<string | null>(null);
	const [resultsOpen, setResultsOpen] = useState(false);

	// Terminal runs we've already reported, so a poll can't re-toast the same
	// completion every 3 seconds.
	const announced = useRef<Set<string>>(new Set());
	// Runs seen in flight during this mount. A run only earns a completion toast
	// if we watched it running first — otherwise every past run on the project
	// would announce itself on first load.
	const watching = useRef<Set<string>>(new Set());

	const jobsQuery = useQuery({
		...orpc.projects.testCases.draftJobs.list.queryOptions({
			input: { projectId, organizationId, limit: 5 },
		}),
		refetchInterval: (query) =>
			query.state.data?.jobs.some((job) => isDraftJobActive(job.status))
				? POLL_MS
				: false,
	});

	const jobs = jobsQuery.data?.jobs;

	// A notification deep-links straight to a batch (?draftJob=<id>).
	const deepLinkedJobId = searchParams.get("draftJob");
	useEffect(() => {
		if (deepLinkedJobId) {
			setResultsJobId(deepLinkedJobId);
			setResultsOpen(true);
		}
	}, [deepLinkedJobId]);

	const active = jobs?.find((job) => isDraftJobActive(job.status));

	// Stop the run mid-flight (the procedure existed but
	// no surface called it, so a stuck run could only be waited out). The list
	// is scoped to the caller's own runs, matching the procedure's
	// requester-only cancel authorization.
	const cancelMutation = useMutation(
		orpc.projects.testCases.draftJobs.cancel.mutationOptions({
			onSuccess: () => {
				toast.dismiss("test-case-draft-progress");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.draftJobs.list.key(),
				});
			},
			onError: (e) =>
				toast.error(t("ai.cancelFailed", { error: e.message })),
		}),
	);

	// The non-blocking progress affordance. A persistent toast keeps the run
	// visible without occupying the page the user went back to working on.
	useEffect(() => {
		if (!active) {
			toast.dismiss("test-case-draft-progress");
			return;
		}
		toast.loading(
			t("ai.progress", {
				done: active.processedFeatures,
				total: active.totalFeatures,
			}),
			{
				id: "test-case-draft-progress",
				duration: Number.POSITIVE_INFINITY,
				action: {
					label: t("ai.cancelRun"),
					onClick: () =>
						cancelMutation.mutate({
							projectId,
							organizationId,
							jobId: active.id,
						}),
				},
			},
		);
		// Dismiss on unmount. The toast is `duration: Infinity`, and the only
		// other paths that clear it (`!active`, and the completion effect below)
		// both require this component to still be mounted — but the Test Cases
		// tab is rendered conditionally, so switching project tabs unmounts it
		// mid-run. That left the spinner pinned to the screen forever, never
		// updating, with a "Cancel run" action firing on an unmounted observer,
		// and a full page reload as the only way out.
		return () => {
			toast.dismiss("test-case-draft-progress");
		};
	}, [active, t, projectId, organizationId, cancelMutation.mutate]);

	useEffect(() => {
		if (!jobs) {
			return;
		}
		for (const job of jobs) {
			if (isDraftJobActive(job.status)) {
				watching.current.add(job.id);
				continue;
			}
			if (announced.current.has(job.id)) {
				continue;
			}
			announced.current.add(job.id);

			// On first load every past run is already terminal — reporting those
			// would fire stale toasts for work finished days ago. Only announce a
			// run this mount actually watched reach its end.
			if (!watching.current.has(job.id)) {
				continue;
			}
			watching.current.delete(job.id);
			toast.dismiss("test-case-draft-progress");

			// Whatever the outcome, the run just became history — refresh the QA
			// tab's per-feature run list. It is a sibling procedure, so the
			// draftJobs.list key invalidated above does NOT cover it. Done here
			// (not per-status) so a cancelled or failed run lands in the history
			// too, not just a successful one.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.testCases.draftJobs.forFeature.key(),
			});

			if (job.status === "CANCELLED") {
				continue;
			}
			if (job.status === "SUCCEEDED") {
				// The cases exist now — let the list show them.
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.list.key(),
				});
				toast.success(
					t("ai.draftedToast", { count: job.createdCount }),
					{
						action: {
							label: t("ai.results.view"),
							onClick: () => {
								setResultsJobId(job.id);
								setResultsOpen(true);
							},
						},
					},
				);
				continue;
			}
			// FAILED — dismissible, and never a blocked dialog.
			toast.error(t("toasts.draftFailed", { error: job.error ?? "" }), {
				action: {
					label: t("ai.results.view"),
					onClick: () => {
						setResultsJobId(job.id);
						setResultsOpen(true);
					},
				},
			});
		}
	}, [jobs, queryClient, t]);

	return (
		<TestCaseDraftResultsSheet
			projectId={projectId}
			organizationId={organizationId}
			jobId={resultsJobId}
			open={resultsOpen}
			onOpenChange={(open) => {
				setResultsOpen(open);
				if (!open) {
					setResultsJobId(null);
				}
			}}
		/>
	);
}
