"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { chatgptPlanStatusQueryKey } from "@saas/settings/components/chatgpt-plan/chatgpt-plan-status";
import type { AiErrorToastCopy } from "@saas/shared/lib/ai-error-message";
import { orpcClient } from "@shared/lib/orpc-client";
import { QueryClientContext } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useContext } from "react";
import { toast } from "sonner";
import type { AiErrorToastAction } from "./copilot-error-toast";

export function useChatgptPlanSpentAction(): (
	copy: AiErrorToastCopy,
	requestOrganizationId: string | null,
) => AiErrorToastAction | undefined {
	const { activeOrganization } = useActiveOrganization();
	const router = useRouter();
	const t = useTranslations("settings.chatgptPlan");
	const queryClient = useContext(QueryClientContext);
	return useCallback(
		(copy, requestOrganizationId) => {
			if (
				!activeOrganization?.id ||
				(requestOrganizationId !== null &&
					requestOrganizationId !== activeOrganization.id)
			) {
				return undefined;
			}
			if (copy.planApiBillingActionable) {
				return {
					label: t("useOrganizationBilling"),
					onClick: () => {
						orpcClient.users.chatgptPlan
							.setOrganizationUse({ enabled: false })
							.then(
								() => {
									toast.success(
										t("usingOrganizationBilling"),
									);
									return queryClient?.invalidateQueries({
										queryKey: chatgptPlanStatusQueryKey,
									});
								},
								() => toast.error(t("updateFailed")),
							);
					},
				};
			}
			if (copy.planPersonalKeyActionable && activeOrganization.slug) {
				return {
					label: t("configurePersonalFallback"),
					onClick: () =>
						router.push(
							`/app/${activeOrganization.slug}/settings/ai-providers?tab=personal`,
						),
				};
			}
			return undefined;
		},
		[
			activeOrganization?.id,
			activeOrganization?.slug,
			queryClient,
			router,
			t,
		],
	);
}
