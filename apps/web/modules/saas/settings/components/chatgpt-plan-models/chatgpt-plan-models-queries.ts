"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const chatgptPlanModelsQueryKey = [
	"organizations",
	"chatgpt-plan-models",
] as const;

type ChatgptPlanModels = Awaited<
	ReturnType<typeof orpcClient.organizations.chatgptPlanModels.get>
>;
export type ChatgptPlanModelTask = ChatgptPlanModels["tasks"][number];

/**
 * The organization's ChatGPT plan model per task (Fizzy #2770). The server
 * reads the SESSION's organization, so the key carries the slug on screen.
 */
export function useChatgptPlanModels(enabled = true) {
	const { activeOrganization, isSwitching, isResolvingOrganization } =
		useActiveOrganization();
	return useQuery({
		queryKey: [
			...chatgptPlanModelsQueryKey,
			activeOrganization?.slug ?? null,
		],
		queryFn: () => orpcClient.organizations.chatgptPlanModels.get({}),
		enabled:
			enabled &&
			Boolean(activeOrganization) &&
			!isSwitching &&
			!isResolvingOrganization,
	});
}

export function useSetChatgptPlanModel(callbacks: {
	onSuccess?: () => void;
	onError?: () => void;
}) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			taskType: ChatgptPlanModelTask["taskType"];
			modelCanonicalName: string | null;
		}) => orpcClient.organizations.chatgptPlanModels.set(input),
		onSuccess: () => {
			callbacks.onSuccess?.();
			return queryClient.invalidateQueries({
				queryKey: chatgptPlanModelsQueryKey,
			});
		},
		onError: callbacks.onError,
	});
}

/** The plan model a call retries on when the plan does not serve the chosen one; null for none. */
export function useSetChatgptPlanFallbackModel(callbacks: {
	onSuccess?: () => void;
	onError?: () => void;
}) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (fallbackModel: string | null) =>
			orpcClient.organizations.chatgptPlanModels.setFallback({
				fallbackModel,
			}),
		onSuccess: () => {
			callbacks.onSuccess?.();
			return queryClient.invalidateQueries({
				queryKey: chatgptPlanModelsQueryKey,
			});
		},
		onError: callbacks.onError,
	});
}
