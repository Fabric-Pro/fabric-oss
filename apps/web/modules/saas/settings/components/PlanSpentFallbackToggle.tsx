"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { toast } from "sonner";

/**
 * "Use when the ChatGPT plan is spent" on one of the member's own keys
 * (Fizzy #3085): where the organization would stop their own work once every
 * plan is spent, it runs on this key instead, billed to them. Only rendered
 * on the Personal tab, which lists the viewer's own keys alone, and never on
 * an embeddings-only key. Hidden while `CHATGPT_PLAN` is off, as the
 * fallback itself never applies then.
 */
export function PlanSpentFallbackToggle({
	provider,
	checked,
}: {
	provider: string;
	checked: boolean;
}) {
	const enabled = useFeatureFlag("CHATGPT_PLAN");
	const t = useTranslations("settings.aiProviders.planSpentFallback");
	const id = useId();
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: (useWhenPlanSpent: boolean) =>
			orpcClient.aiConfig.providers.setPlanSpentFallback({
				provider,
				useWhenPlanSpent,
			}),
		onSuccess: (_result, useWhenPlanSpent) => {
			queryClient.invalidateQueries({ queryKey: ["aiConfigStatus"] });
			toast.success(
				useWhenPlanSpent ? t("enabledToast") : t("disabledToast"),
			);
		},
		onError: (error) => {
			toast.error(t("failedToast"), {
				description: error instanceof Error ? error.message : undefined,
			});
		},
	});

	if (!enabled) {
		return null;
	}

	return (
		<div
			className="flex w-full items-start gap-2"
			data-testid="plan-spent-fallback-toggle"
		>
			<Switch
				checked={checked}
				disabled={mutation.isPending}
				id={id}
				onCheckedChange={(value) => mutation.mutate(value)}
			/>
			<div className="space-y-0.5">
				<Label className="font-medium text-xs" htmlFor={id}>
					{t("toggleLabel")}
				</Label>
				<p className="text-muted-foreground text-xs">
					{t("toggleHint")}
				</p>
			</div>
		</div>
	);
}
