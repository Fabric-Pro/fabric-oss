"use client";

import {
	type ReportListPage,
	reportDeleteFailure,
	withoutReport,
} from "@saas/reports/lib/report-delete-outcome";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	type QueryClient,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Drops a deleted report's cached page as soon as no screen shows it. Marking
 * it stale is not enough: a refetch that fails keeps the old data, so going
 * back would show the report as if it still existed. The page that deleted it
 * keeps its data until it closes, so it does not flash while it navigates.
 */
function forgetReportPage(queryClient: QueryClient, id: string) {
	const queryKey = orpc.reports.instances.get.key({ input: { id } });
	const cache = queryClient.getQueryCache();
	const removeIfUnshown = () => {
		const pages = cache.findAll({ queryKey });
		const shown = pages.some((page) => page.isActive());
		if (!shown) {
			queryClient.removeQueries({ queryKey });
		}
		return !shown;
	};
	if (removeIfUnshown()) {
		return;
	}
	const unsubscribe = cache.subscribe((event) => {
		if (event.type === "observerRemoved" && removeIfUnshown()) {
			unsubscribe();
		}
	});
}

/**
 * The id of a report's delete-failure toast. The failure stays until it is
 * closed, so a later attempt for the same report closes it: a retry that
 * succeeds must not leave "Couldn't delete" beside "Report deleted".
 */
function deleteFailureToastId(id: string) {
	return `report-delete-failed-${id}`;
}

/**
 * Deletes a report and keeps every cached report list in step: the report
 * leaves the lists at once, comes back if the deletion fails, and the lists
 * are read again either way. Once the report is gone its cached page is
 * dropped, so going back to it reads it again rather than showing it live.
 * Only a refusal for permission is described as one.
 */
export function useDeleteReportInstance({
	onDeleted,
}: {
	onDeleted?: () => void;
} = {}) {
	const queryClient = useQueryClient();
	const listKey = orpc.reports.instances.list.key();

	const forgetReport = (id: string) => {
		forgetReportPage(queryClient, id);
		onDeleted?.();
	};

	return useMutation(
		orpc.reports.instances.delete.mutationOptions({
			onMutate: async ({ id }) => {
				toast.dismiss(deleteFailureToastId(id));
				await queryClient.cancelQueries({ queryKey: listKey });
				const previous = queryClient.getQueriesData<ReportListPage>({
					queryKey: listKey,
				});
				queryClient.setQueriesData<ReportListPage>(
					{ queryKey: listKey },
					(page) => withoutReport(page, id),
				);
				return { previous };
			},
			onSuccess: (_result, { id }) => {
				toast.success("Report deleted");
				forgetReport(id);
			},
			onError: (error, { id }, context) => {
				const failure = reportDeleteFailure(error);
				if (failure.kind === "gone") {
					toast.info(failure.message);
					forgetReport(id);
					return;
				}
				for (const [key, page] of context?.previous ?? []) {
					queryClient.setQueryData(key, page);
				}
				toast.error(failure.message, {
					id: deleteFailureToastId(id),
					duration: Number.POSITIVE_INFINITY,
					closeButton: true,
				});
			},
			onSettled: () => {
				void queryClient.invalidateQueries({ queryKey: listKey });
			},
		}),
	);
}
