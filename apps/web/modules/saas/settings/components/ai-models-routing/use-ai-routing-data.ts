"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useChatgptPlanModels } from "../chatgpt-plan-models/chatgpt-plan-models-queries";
import { useChatgptPlanPool } from "../chatgpt-plan-pool/chatgpt-plan-pool-queries";

/**
 * What the AI Models routing page reads (Fizzy #2770 F6): the provider status
 * the AI Providers page already caches, the organization's plan models, and —
 * only with `CHATGPT_PLAN_POOLING` on — its shared accounts and policy.
 */
export function useAiRoutingData() {
	const { organizationId, organizationSlug, isOrgContext } =
		useOrganizationContext();
	const pooling = useFeatureFlag("CHATGPT_PLAN_POOLING");
	const status = useQuery({
		queryKey: ["aiConfigStatus", organizationId],
		queryFn: () =>
			orpcClient.aiConfig.resolution.getStatus({ organizationId }),
		enabled: Boolean(isOrgContext),
	});
	const planModels = useChatgptPlanModels();
	const pool = useChatgptPlanPool(pooling);

	const configured = status.data?.configuredProviders ?? [];
	// The providers that may serve LLM work: an embeddings-only key never does.
	const apiProviders = configured.filter(
		(provider) => provider.purpose !== "EMBEDDINGS_ONLY",
	);
	const embeddingProvider =
		configured.find((provider) => provider.isEmbeddingProvider) ?? null;

	return {
		organizationSlug,
		pooling,
		status,
		planModels,
		pool,
		apiProviders,
		hasApiProvider: apiProviders.length > 0,
		embeddingProvider,
		embeddingModel: status.data?.embeddingModel ?? null,
		providersHref: organizationSlug
			? `/app/${organizationSlug}/settings/ai-providers`
			: null,
	};
}

export type AiRoutingData = ReturnType<typeof useAiRoutingData>;
