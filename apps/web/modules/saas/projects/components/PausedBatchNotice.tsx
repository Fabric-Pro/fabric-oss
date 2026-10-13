"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { PlanPausedNotice } from "./PlanPausedNotice";

const POLL_MS = 60_000;

/**
 * The project's batch document generation, when it is paused for a ChatGPT
 * plan reset (Fizzy #2770): when it resumes, how many documents wait, Cancel,
 * and — with an AI provider of the organization's own — Run now on API
 * billing. Renders nothing otherwise.
 */
export function PausedBatchNotice({
	projectId,
	organizationId,
}: {
	projectId: string;
	organizationId: string | null | undefined;
}) {
	const t = useTranslations("projects.planPause");
	const queryClient = useQueryClient();
	const query = useQuery({
		...orpc.projects.documents.pausedBatch.get.queryOptions({
			input: { projectId, organizationId },
		}),
		refetchInterval: POLL_MS,
	});
	const batch = query.data?.batch ?? null;

	const refresh = () => {
		query.refetch();
		queryClient.invalidateQueries({
			queryKey: orpc.projects.documents.list.key(),
		});
	};
	const cancel = useMutation(
		orpc.projects.documents.pausedBatch.cancel.mutationOptions({
			onSuccess: () => {
				toast.success(t("cancelled"));
				refresh();
			},
			onError: (error) => {
				toast.error(t("cancelFailed", { message: error.message }));
			},
		}),
	);
	const runNow = useMutation(
		orpc.projects.documents.pausedBatch.runOnApi.mutationOptions({
			onSuccess: () => {
				toast.success(t("runNowStarted"));
				refresh();
			},
			onError: (error) => {
				toast.error(t("runNowFailed", { message: error.message }));
			},
		}),
	);

	if (!batch) {
		return null;
	}
	const input = { projectId, organizationId, runId: batch.id };
	return (
		<PlanPausedNotice
			resumesAt={batch.resumesAt}
			pendingDocumentCount={batch.pendingDocumentCount}
			canRunOnApi={batch.canRunOnApi}
			askAdminToRunOnApi={batch.askAdminToRunOnApi}
			onCancel={() => cancel.mutate(input)}
			onRunNow={() => runNow.mutate(input)}
			cancelling={cancel.isPending}
			runningNow={runNow.isPending}
		/>
	);
}
