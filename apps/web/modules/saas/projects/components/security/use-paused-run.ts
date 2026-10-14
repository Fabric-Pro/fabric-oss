"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

/** Polls a paused run this often, so the page sees its resume start. */
export const PAUSED_RUN_POLL_MS = 60_000;

/**
 * "Run now on API billing" for a scan, review or grouping run paused for a
 * ChatGPT plan reset (Fizzy #2770), and whether the organization may: it needs
 * an AI provider of its own. Cancel stays each run's own cancel.
 */
export function usePausedRun(args: {
	projectId: string;
	organizationId: string | null | undefined;
	kind: "scan" | "review" | "grouping";
	runId: string | null | undefined;
	paused: boolean;
	onResumed: () => void;
}) {
	const t = useTranslations("projects.planPause");
	const options = useQuery({
		...orpc.projects.scan.pausedRunOptions.queryOptions({
			input: {
				projectId: args.projectId,
				organizationId: args.organizationId,
			},
		}),
		enabled: args.paused,
	});
	const runNow = useMutation(
		orpc.projects.scan.runPausedOnApi.mutationOptions({
			onSuccess: () => {
				toast.success(t("runNowStarted"));
				args.onResumed();
			},
			onError: (error) => {
				toast.error(t("runNowFailed", { message: error.message }));
			},
		}),
	);
	return {
		canRunOnApi: options.data?.canRunOnApi === true,
		askAdminToRunOnApi: options.data?.askAdminToRunOnApi === true,
		runningNow: runNow.isPending,
		runNow: () => {
			if (!args.runId) {
				return;
			}
			runNow.mutate({
				projectId: args.projectId,
				organizationId: args.organizationId,
				kind: args.kind,
				runId: args.runId,
			});
		},
	};
}
