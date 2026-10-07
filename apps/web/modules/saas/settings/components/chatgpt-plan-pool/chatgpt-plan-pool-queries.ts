"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const poolQueryKey = ["organizations", "chatgpt-plan-pool"] as const;

type UpdateAccountInput = Parameters<
	typeof orpcClient.organizations.chatgptPlanPool.updateAccount
>[0];
type UpdatePolicyInput = Parameters<
	typeof orpcClient.organizations.chatgptPlanPool.updatePolicy
>[0];

export type ChatgptPlanPool = Awaited<
	ReturnType<typeof orpcClient.organizations.chatgptPlanPool.get>
>;
export type ChatgptPlanPoolAccount = ChatgptPlanPool["accounts"][number];

/**
 * The organization's shared ChatGPT plan accounts and pooling policy
 * (Fizzy #2770). The server acts on the SESSION's organization, so the key
 * carries the slug on screen and nothing is fetched mid-switch.
 */
export function useChatgptPlanPool() {
	const { activeOrganization, isSwitching, isResolvingOrganization } =
		useActiveOrganization();
	return useQuery({
		queryKey: [...poolQueryKey, activeOrganization?.slug ?? null],
		queryFn: () => orpcClient.organizations.chatgptPlanPool.get({}),
		enabled:
			Boolean(activeOrganization) &&
			!isSwitching &&
			!isResolvingOrganization,
	});
}

function usePoolMutation<TInput, TResult>(
	mutationFn: (input: TInput) => Promise<TResult>,
	callbacks: { onSuccess?: () => void; onError?: (error: unknown) => void },
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn,
		onSuccess: () => {
			callbacks.onSuccess?.();
			return queryClient.invalidateQueries({ queryKey: poolQueryKey });
		},
		onError: callbacks.onError,
	});
}

export function useUpdateChatgptPlanPoolAccount(callbacks: {
	onSuccess?: () => void;
	onError?: (error: unknown) => void;
}) {
	return usePoolMutation(
		(input: UpdateAccountInput) =>
			orpcClient.organizations.chatgptPlanPool.updateAccount(input),
		callbacks,
	);
}

export function useDisconnectChatgptPlanPoolAccount(callbacks: {
	onSuccess?: () => void;
	onError?: (error: unknown) => void;
}) {
	return usePoolMutation(
		(accountId: string) =>
			orpcClient.organizations.chatgptPlanPool.disconnectAccount({
				accountId,
			}),
		callbacks,
	);
}

export function useUpdateChatgptPlanPoolPolicy(callbacks: {
	onSuccess?: () => void;
	onError?: (error: unknown) => void;
}) {
	return usePoolMutation(
		(input: UpdatePolicyInput) =>
			orpcClient.organizations.chatgptPlanPool.updatePolicy(input),
		callbacks,
	);
}

export function useAcknowledgeChatgptPlanPoolTerms(callbacks: {
	onSuccess?: () => void;
	onError?: (error: unknown) => void;
}) {
	return usePoolMutation(
		() => orpcClient.organizations.chatgptPlanPool.acknowledgeTerms({}),
		callbacks,
	);
}
