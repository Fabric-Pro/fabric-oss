"use client";

import { getAiModelFit } from "@repo/utils/ai-model-fit";
import { ModelFitIndicator } from "@saas/shared/components/ModelFitIndicator";
import { useTranslations } from "next-intl";

export function ModelFitNote({
	taskType,
	model,
	compact = false,
}: {
	taskType: string;
	model: {
		displayName: string;
		suitableForTasks?: readonly string[];
		capabilities?: readonly string[];
		qualityTier?: string;
		inputCostPer1M?: number | null;
		outputCostPer1M?: number | null;
	} | null;
	compact?: boolean;
}) {
	const t = useTranslations("settings.aiModelsRouting.models");
	const fit = model && getAiModelFit({ taskType, ...model });
	if (!fit) {
		return null;
	}
	return (
		<ModelFitIndicator
			fit={fit}
			compact={compact}
			message={t(`modelFit.${fit.reason}`, {
				model: model.displayName,
				task: t(`tasks.${taskType}.name`),
			})}
		/>
	);
}
