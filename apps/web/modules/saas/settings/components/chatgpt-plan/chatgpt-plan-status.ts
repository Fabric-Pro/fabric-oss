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
 * The server answers for the SESSION's active organization, which lags the one
 * in the URL for a moment after a switch. So nothing is fetched until the
 * session names the organization on screen (as `useChatgptPlanModels` and
 * `useChatgptPlanPool` already do): fetched earlier, the previous
 * organization's answer was cached under this one's key and read as "no plan
 * serves your work here" until the next refetch (Fizzy #3082).
 *
 * `currentOrganization` is likewise only handed out when it is the
 * organization on screen, so a toggle or prompt — whose mutations also act on
 * the session's organization — can never write a choice into a different one.
 *
 * `known` says whether the answer is in for the organization on screen. Until
 * it is, the `...ServesOwnWork` hooks answer false, which a notice must read
 * as "not yet known", not as "no plan here".
 */
export function useChatgptPlanStatus() {
	const enabled = useFeatureFlag("CHATGPT_PLAN");
	const {
		activeOrganization,
		isSwitching,
		isResolvingOrganization,
		isSessionOnActiveOrganization,
	} = useActiveOrganization();
	const activeSlug = activeOrganization?.slug ?? null;
	const sessionOnScreen =
		isSessionOnActiveOrganization &&
		!isSwitching &&
		!isResolvingOrganization;

	const query = useQuery({
		queryKey: [...chatgptPlanStatusQueryKey, activeSlug],
		queryFn: () => orpcClient.users.chatgptPlan.status({}),
		enabled: enabled && sessionOnScreen,
		// The member's own window can run out at any call and the shell then
		// says a shared plan took over (Fizzy #2770).
		refetchInterval: (current) =>
			current.state.data?.currentOrganization?.enabled === true
				? 60_000
				: false,
	});

	const currentOrganization =
		query.data?.currentOrganization &&
		activeSlug !== null &&
		query.data.currentOrganization.slug === activeSlug
			? query.data.currentOrganization
			: null;
	// An answer naming another organization is the session's, not the
	// page's: it arrived from a refetch after the session moved elsewhere.
	const answersForAnotherOrganization =
		query.data?.currentOrganization != null && currentOrganization === null;
	// With the flag off no plan can serve anything, so that is an answer. A
	// failed call is one too: the notices fall back to "no plan", as before.
	const known =
		!enabled ||
		query.isError ||
		(sessionOnScreen &&
			query.data !== undefined &&
			!answersForAnotherOrganization);

	return { query, currentOrganization, known };
}

/**
 * Whether the plan status is in for the organization on screen. A notice whose
 * message depends on whether a plan serves the member's work waits for this.
 */
export function useChatgptPlanStatusKnown(): boolean {
	return useChatgptPlanStatus().known;
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

/**
 * Tests the member's own plan with one tiny request (Fizzy #2770). A test can
 * mark the plan for reconnecting or spent, so the status is read again.
 */
export function useTestChatgptPlan() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => orpcClient.users.chatgptPlan.test({}),
		onSettled: () =>
			queryClient.invalidateQueries({
				queryKey: chatgptPlanStatusQueryKey,
			}),
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
