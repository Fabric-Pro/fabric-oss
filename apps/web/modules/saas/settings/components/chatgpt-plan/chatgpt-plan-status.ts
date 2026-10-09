"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatgptPlanModelsQueryKey } from "../chatgpt-plan-models/chatgpt-plan-models-queries";
import { chatgptPlanPoolQueryKey } from "../chatgpt-plan-pool/chatgpt-plan-pool-queries";

export const chatgptPlanStatusQueryKey = [
	"users",
	"chatgpt-plan",
	"status",
] as const;

/**
 * The member's ChatGPT plan connection, shared by the settings section and the
 * shell prompt so the two can never disagree. Nothing is fetched while the
 * `CHATGPT_PLAN` flag is off for the organization on screen.
 *
 * `setOrganizationUse` acts on the SESSION's active organization, which can lag
 * the one in the URL for a moment after a switch. `currentOrganization` is
 * therefore only handed out when it is the organization on screen, so a toggle
 * or prompt can never write a choice into a different organization.
 */
export function useChatgptPlanStatus() {
	const enabled = useFeatureFlag("CHATGPT_PLAN");
	const pooling = useFeatureFlag("CHATGPT_PLAN_POOLING");
	const { activeOrganization, isSwitching, isResolvingOrganization } =
		useActiveOrganization();
	const activeSlug = activeOrganization?.slug ?? null;

	const query = useQuery({
		queryKey: [...chatgptPlanStatusQueryKey, activeSlug],
		queryFn: () => orpcClient.users.chatgptPlan.status({}),
		enabled: enabled && !isSwitching && !isResolvingOrganization,
		// With shared plans here, the member's own window can run out at any
		// call and the shell then says the shared plan took over (Fizzy
		// #2770). Without them there is nothing to say, so nothing to poll.
		refetchInterval: (current) =>
			pooling && current.state.data?.currentOrganization?.enabled === true
				? 60_000
				: false,
	});

	const currentOrganization =
		query.data?.currentOrganization &&
		activeSlug !== null &&
		query.data.currentOrganization.slug === activeSlug
			? query.data.currentOrganization
			: null;

	return { query, currentOrganization };
}

/**
 * Whether the member's own interactive work in the organization on screen runs
 * on their ChatGPT plan: connected, signed in, and turned on here.
 */
export function useChatgptPlanServesOwnWork(): boolean {
	const { query, currentOrganization } = useChatgptPlanStatus();
	return (
		query.data?.connected === true &&
		query.data.status === "ACTIVE" &&
		currentOrganization?.enabled === true
	);
}

/**
 * Whether one of the organization's shared ChatGPT accounts serves the
 * member's own interactive work in the organization on screen (Fizzy #2770):
 * they have no plan of their own here, or theirs is spent.
 */
export function useSharedChatgptPlanServesOwnWork(): boolean {
	const { query, currentOrganization } = useChatgptPlanStatus();
	return (
		currentOrganization !== null &&
		query.data?.sharedPlanServesOwnWork === true
	);
}

export function useSetChatgptPlanOrganizationUse({
	onSuccess,
	onError,
}: {
	onSuccess?: (enabled: boolean) => void;
	onError?: () => void;
} = {}) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (enabled: boolean) =>
			orpcClient.users.chatgptPlan.setOrganizationUse({ enabled }),
		onSuccess: (_result, enabled) => {
			onSuccess?.(enabled);
			return queryClient.invalidateQueries({
				queryKey: chatgptPlanStatusQueryKey,
			});
		},
		onError,
	});
}

/**
 * Background-job use is only ever set from here, by an explicit switch, and
 * only together with the organization toggle being on.
 */
export function useSetChatgptPlanBackgroundJobs({
	onSuccess,
	onError,
}: {
	onSuccess?: (includeBackgroundJobs: boolean) => void;
	onError?: () => void;
} = {}) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (includeBackgroundJobs: boolean) =>
			orpcClient.users.chatgptPlan.setOrganizationUse({
				enabled: true,
				includeBackgroundJobs,
			}),
		onSuccess: (_result, includeBackgroundJobs) => {
			onSuccess?.(includeBackgroundJobs);
			return queryClient.invalidateQueries({
				queryKey: chatgptPlanStatusQueryKey,
			});
		},
		onError,
	});
}

export function useDisconnectChatgptPlan({
	onSuccess,
	onError,
}: {
	onSuccess?: () => void;
	onError?: () => void;
}) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: () => orpcClient.users.chatgptPlan.disconnect({}),
		onSuccess: () => {
			onSuccess?.();
			return queryClient.invalidateQueries({
				queryKey: chatgptPlanStatusQueryKey,
			});
		},
		onError,
	});
}

/** Both moves change the member's own plan and the organization's shared accounts. */
function useChatgptPlanMove<TInput>(
	mutationFn: (input: TInput) => Promise<unknown>,
	callbacks: { onSuccess?: () => void; onError?: (error: unknown) => void },
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn,
		onSuccess: () => {
			callbacks.onSuccess?.();
			return Promise.all([
				queryClient.invalidateQueries({
					queryKey: chatgptPlanStatusQueryKey,
				}),
				queryClient.invalidateQueries({
					queryKey: chatgptPlanPoolQueryKey,
				}),
				// The plan models page counts the members on their own plan.
				queryClient.invalidateQueries({
					queryKey: chatgptPlanModelsQueryKey,
				}),
			]);
		},
		onError: callbacks.onError,
	});
}

/** Shares the member's own plan with the organization on screen (Fizzy #2770 I1). */
export function useShareChatgptPlan(callbacks: {
	onSuccess?: () => void;
	onError?: (error: unknown) => void;
}) {
	return useChatgptPlanMove<undefined>(
		() => orpcClient.users.chatgptPlan.share({}),
		callbacks,
	);
}

/** Takes a shared account the member connected back as their own plan. */
export function useTakeBackChatgptPlan(callbacks: {
	onSuccess?: () => void;
	onError?: (error: unknown) => void;
}) {
	return useChatgptPlanMove(
		(accountId: string) =>
			orpcClient.users.chatgptPlan.takeBack({ accountId }),
		callbacks,
	);
}
