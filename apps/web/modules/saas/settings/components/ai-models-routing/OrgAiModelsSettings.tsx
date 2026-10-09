"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Skeleton } from "@ui/components/skeleton";
import { useTranslations } from "next-intl";
import { OrgAiModelPreferencesForm } from "../OrgAiModelPreferencesForm";
import { AiModelsTable } from "./AiModelsTable";
import { AiRoutingCard } from "./AiRoutingCard";
import { useAiRoutingData } from "./use-ai-routing-data";

/**
 * Organization settings → AI Models. With `CHATGPT_PLAN` on, the
 * organization's admins and owners get one page for how its AI work runs:
 * the routing between plans and API billing with its policy, then the model
 * for each kind of work on both (Fizzy #2770 F6). Everyone else — every
 * organization without the flag, and members — sees the page exactly as
 * before.
 */
export function OrgAiModelsSettings({
	canManagePlanModels,
	readOnly,
}: {
	canManagePlanModels: boolean;
	readOnly: boolean;
}) {
	const planEnabled = useFeatureFlag("CHATGPT_PLAN");
	if (!planEnabled || !canManagePlanModels) {
		return <OrgAiModelPreferencesForm readOnly={readOnly} />;
	}
	return <PlanRoutingPage readOnly={readOnly} />;
}

function PlanRoutingPage({ readOnly }: { readOnly: boolean }) {
	const t = useTranslations("settings.aiModelsRouting.routing");
	const data = useAiRoutingData();
	if (data.planModels.isPending || data.status.isPending) {
		return <Skeleton className="h-96 w-full" />;
	}
	if (data.planModels.isError || data.status.isError) {
		return (
			<Alert variant="error">
				<AlertDescription>{t("loadFailed")}</AlertDescription>
			</Alert>
		);
	}
	return (
		<div className="space-y-5" data-testid="ai-models-plan-routing">
			<AiRoutingCard data={data} />
			<AiModelsTable data={data} readOnly={readOnly} />
		</div>
	);
}
