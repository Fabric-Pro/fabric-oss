"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { reportFailure } from "../lib/report-table";
import {
	applyOrganizationSettingsPatch,
	applyProjectSettingsPatch,
	type OrganizationTimeSettingsPatch,
	type ProjectTimeSettingsPatch,
} from "../lib/time-settings-model";
import {
	invalidateTimePolicy,
	timeReportQuery,
} from "../lib/time-tracking-api";
import { todayInZone } from "../lib/zoned-time";

/*
 * Settings save as they change, with no Save button. Each change is shown at
 * once and sent with only the field that changed; a refusal puts the previous
 * settings back and says so.
 */

/** A project's billing model and time policy, saved on change. */
export function useProjectTimeSettings(projectId: string) {
	const t = useTranslations("timeTracking.settings");
	const queryClient = useQueryClient();
	const input = { projectId };
	const queryKey = orpc.timeTracking.getProjectSettings.queryKey({ input });
	const query = useQuery(
		orpc.timeTracking.getProjectSettings.queryOptions({ input }),
	);

	const mutation = useMutation({
		mutationFn: (patch: ProjectTimeSettingsPatch) =>
			orpc.timeTracking.updateProjectSettings.call({
				projectId,
				...patch,
			}),
		onMutate: async (patch) => {
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData(queryKey);
			if (previous) {
				queryClient.setQueryData(
					queryKey,
					applyProjectSettingsPatch(previous, patch),
				);
			}
			return { previous };
		},
		onError: (_error, _patch, context) => {
			if (context?.previous) {
				queryClient.setQueryData(queryKey, context.previous);
			}
			toast.error(t("saveFailed"));
		},
		onSuccess: (settings) => {
			queryClient.setQueryData(queryKey, settings);
		},
		onSettled: () => invalidateTimePolicy(queryClient),
	});

	return {
		settings: query.data,
		isPending: query.isPending,
		isError: query.isError,
		update: (patch: ProjectTimeSettingsPatch) => mutation.mutate(patch),
	};
}

/** The organization's time policy, saved on change. */
export function useOrganizationTimeSettings(organizationId: string) {
	const t = useTranslations("timeTracking.settings");
	const queryClient = useQueryClient();
	const input = { organizationId };
	const queryKey = orpc.timeTracking.getOrganizationSettings.queryKey({
		input,
	});
	const query = useQuery(
		orpc.timeTracking.getOrganizationSettings.queryOptions({ input }),
	);

	const mutation = useMutation({
		mutationFn: (patch: OrganizationTimeSettingsPatch) =>
			orpc.timeTracking.updateOrganizationSettings.call({
				organizationId,
				...patch,
			}),
		onMutate: async (patch) => {
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData(queryKey);
			if (previous) {
				queryClient.setQueryData(
					queryKey,
					applyOrganizationSettingsPatch(previous, patch),
				);
			}
			return { previous };
		},
		onError: (_error, _patch, context) => {
			if (context?.previous) {
				queryClient.setQueryData(queryKey, context.previous);
			}
			toast.error(t("saveFailed"));
		},
		onSuccess: (settings) => {
			queryClient.setQueryData(queryKey, settings);
		},
		// Every project's settings carry the organization's policy too.
		onSettled: () =>
			Promise.all([
				invalidateTimePolicy(queryClient),
				queryClient.invalidateQueries({
					queryKey: orpc.timeTracking.getProjectSettings.key(),
				}),
			]),
	});

	return {
		settings: query.data,
		isPending: query.isPending,
		isError: query.isError,
		update: (patch: OrganizationTimeSettingsPatch) =>
			mutation.mutate(patch),
	};
}

/**
 * Whether the caller may read this project's time report, asked of the
 * report itself over a single day so the answer is the server's own
 * permission check and costs almost nothing. Unknown until it answers.
 */
export function useCanViewProjectTimeReport(projectId: string): boolean {
	const today = todayInZone("UTC");
	const query = useQuery(
		timeReportQuery({
			kind: "project",
			input: { projectId, from: today, to: today },
		}),
	);
	return (
		query.isSuccess ||
		(query.isError && reportFailure(query.error) !== "no-access")
	);
}
