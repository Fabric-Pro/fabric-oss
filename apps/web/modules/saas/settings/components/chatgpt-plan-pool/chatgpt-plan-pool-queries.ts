"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const chatgptPlanPoolQueryKey = [
	"organizations",
	"chatgpt-plan-pool",
] as const;

type UpdateAccountInput = Parameters<
	typeof orpcClient.organizations.chatgptPlanPool.updateAccount
>[0];
type UpdatePolicyInput = Parameters<
	typeof orpcClient.organizations.chatgptPlanPool.updatePolicy
>[0];

type ChatgptPlanPool = Awaited<
	ReturnType<typeof orpcClient.organizations.chatgptPlanPool.get>
>;
export type ChatgptPlanPoolAccount = ChatgptPlanPool["accounts"][number];

/**
 * The organization's shared ChatGPT plan accounts and pooling policy
 * (Fizzy #2770). The server acts on the SESSION's organization, so nothing is
 * fetched until the session names the organization on screen: the URL commits
 * before a switch's `setActive` lands, and a fetch in that gap cached the
 * previous organization's pool under the new one's key.
 */
export function useChatgptPlanPool() {
	const { activeOrganization, isSessionOnActiveOrganization } =
		useActiveOrganization();
	return useQuery({
		queryKey: [
			...chatgptPlanPoolQueryKey,
			activeOrganization?.slug ?? null,
		],
		queryFn: () => orpcClient.organizations.chatgptPlanPool.get({}),
		enabled: isSessionOnActiveOrganization,
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
			return queryClient.invalidateQueries({
				queryKey: chatgptPlanPoolQueryKey,
			});
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

/**
 * Tests one shared account with one tiny request (Fizzy #2770). A test can
 * mark the account for reconnecting or spent, so the pool is read again.
 */
export function useTestChatgptPlanPoolAccount() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (accountId: string) =>
			orpcClient.organizations.chatgptPlanPool.testAccount({
				accountId,
			}),
		onSettled: () =>
			queryClient.invalidateQueries({
				queryKey: chatgptPlanPoolQueryKey,
			}),
	});
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
