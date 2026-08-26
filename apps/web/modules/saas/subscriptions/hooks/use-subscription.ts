"use client";

import { useTenantContext } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type SubscriptionSubjectType = "DOCUMENT" | "FEATURE";

type UseSubscriptionArgs = {
	subjectType: SubscriptionSubjectType;
	subjectId: string;
	projectId: string;
};

/**
 * Read + toggle the caller's opt-in subscription for a document or feature.
 *
 * The status query is keyed under the tenant prefix (subscriptions are scoped
 * by the notification's own workspace). Toggling is optimistic so the button
 * flips instantly and rolls back on error, mirroring
 * `useUpdateNotificationPreferences`.
 */
export function useSubscription({
	subjectType,
	subjectId,
	projectId,
}: UseSubscriptionArgs) {
	const queryClient = useQueryClient();
	const { queryKeyPrefix, organizationId } = useTenantContext();
	const key = [
		...queryKeyPrefix,
		"subscriptions",
		"status",
		subjectType,
		subjectId,
	];

	const query = useQuery({
		queryKey: key,
		queryFn: () =>
			orpcClient.subscriptions.getStatus({
				organizationId,
				subjectType,
				subjectId,
				projectId,
			}),
	});

	const mutation = useMutation({
		// Return void so the two branches' differing result shapes don't split
		// TData / break TContext inference — the toggle only cares about success.
		mutationFn: async (next: boolean) => {
			if (next) {
				await orpcClient.subscriptions.subscribe({
					organizationId,
					subjectType,
					subjectId,
					projectId,
				});
			} else {
				await orpcClient.subscriptions.unsubscribe({
					organizationId,
					subjectType,
					subjectId,
					projectId,
				});
			}
		},
		onMutate: async (next) => {
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData<{ subscribed: boolean }>(
				key,
			);
			queryClient.setQueryData(key, { subscribed: next });
			return { previous };
		},
		onError: (_err, _next, context) => {
			if (context?.previous) {
				queryClient.setQueryData(key, context.previous);
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: key });
		},
	});

	const subscribed = query.data?.subscribed ?? false;

	return {
		subscribed,
		isLoading: query.isLoading,
		isMutating: mutation.isPending,
		toggle: () => mutation.mutate(!subscribed),
	};
}
