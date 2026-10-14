"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { PlanPausedNotice } from "./PlanPausedNotice";

const POLL_MS = 60_000;

/**
 * The project's setup, when it is paused for a ChatGPT plan reset (Fizzy
 * #2770): its code analysis and first documents wait, and the project's
 * analysis still reads SCANNING. Null while nothing is paused.
 */
export function usePausedSetup(args: {
	projectId: string;
	organizationId: string | null | undefined;
}) {
	return useQuery({
		...orpc.projects.existingSetup.pausedRun.get.queryOptions({
			input: {
				projectId: args.projectId,
				organizationId: args.organizationId,
			},
		}),
		refetchInterval: POLL_MS,
	});
}

type PausedSetup = NonNullable<
	NonNullable<ReturnType<typeof usePausedSetup>["data"]>["setup"]
>;

/**
 * A paused project setup: when it resumes, how many documents wait, Cancel,
 * and — with an AI provider of the organization's own — Run now on API
 * billing.
 */
export function PausedSetupNotice({
	projectId,
	organizationId,
	setup,
	onChanged,
}: {
	projectId: string;
	organizationId: string | null | undefined;
	setup: PausedSetup;
	/** The setup was cancelled or resumed: the page reads its status again. */
	onChanged: () => void;
}) {
	const t = useTranslations("projects.planPause");
	const cancel = useMutation(
		orpc.projects.existingSetup.pausedRun.cancel.mutationOptions({
			onSuccess: () => {
				toast.success(t("cancelled"));
				onChanged();
			},
			onError: (error) => {
				toast.error(t("cancelFailed", { message: error.message }));
			},
		}),
	);
	const runNow = useMutation(
		orpc.projects.existingSetup.pausedRun.runOnApi.mutationOptions({
			onSuccess: () => {
				toast.success(t("runNowStarted"));
				onChanged();
			},
			onError: (error) => {
				toast.error(t("runNowFailed", { message: error.message }));
			},
		}),
	);

	const input = { projectId, organizationId, runId: setup.id };
	return (
		<PlanPausedNotice
			subject={t("setupSubject")}
			resumesAt={setup.resumesAt}
			pendingDocumentCount={
				setup.pendingDocumentCount > 0
					? setup.pendingDocumentCount
					: undefined
			}
			canRunOnApi={setup.canRunOnApi}
			askAdminToRunOnApi={setup.askAdminToRunOnApi}
			onCancel={() => cancel.mutate(input)}
			onRunNow={() => runNow.mutate(input)}
			cancelling={cancel.isPending}
			runningNow={runNow.isPending}
		/>
	);
}
