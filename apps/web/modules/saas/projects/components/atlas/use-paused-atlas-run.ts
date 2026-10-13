"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

/**
 * The analysis run paused for a ChatGPT plan reset (Fizzy #2770): when it
 * resumes, and "Run now on API billing" when the organization has an AI
 * provider of its own and the viewer may approve it. Cancel is the page's
 * "Cancel analysis", which stops a paused run too.
 */
export function usePausedAtlasRun(args: {
	projectId: string;
	organizationId: string | null | undefined;
	analysisId: string | null;
	paused: boolean;
	onResumed: () => void;
}) {
	const t = useTranslations("projects.planPause");
	const enabled = args.paused && args.analysisId !== null;
	const pausedRun = useQuery({
		...orpc.atlas.pausedRun.queryOptions({
			input: {
				projectId: args.projectId,
				organizationId: args.organizationId,
				analysisId: args.analysisId ?? "",
			},
		}),
		enabled,
	});
	const runNow = useMutation(
		orpc.atlas.runPausedOnApi.mutationOptions({
			onSuccess: () => {
				toast.success(t("runNowStarted"));
				args.onResumed();
			},
			onError: (error) => {
				toast.error(t("runNowFailed", { message: error.message }));
			},
		}),
	);
	const run = enabled ? (pausedRun.data?.run ?? null) : null;
	return {
		run,
		canRunOnApi: run?.canRunOnApi === true,
		askAdminToRunOnApi: run?.askAdminToRunOnApi === true,
		runningNow: runNow.isPending,
		runNow: () => {
			if (!run || !args.analysisId) {
				return;
			}
			runNow.mutate({
				projectId: args.projectId,
				organizationId: args.organizationId,
				analysisId: args.analysisId,
				runId: run.id,
			});
		},
	};
}
