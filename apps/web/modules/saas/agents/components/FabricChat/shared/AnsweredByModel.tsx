"use client";

import type { StreamModelInfo } from "@saas/agents/hooks/useDirectStream";
import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import {
	formatUsageModel,
	formatUsageProvider,
} from "@saas/payments/lib/ai-usage-labels";
import { getModelDisplayNameFromCatalog } from "@shared/hooks/use-available-models";
import { useQuery } from "@tanstack/react-query";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { useTranslations } from "next-intl";
import { chatModelQueryOptions } from "./use-provider-pick-status";

export function AnsweredByModel({ model }: { model?: StreamModelInfo }) {
	return model && typeof model.viaPlan === "boolean" ? (
		<AnsweredByModelLabel model={model} />
	) : null;
}

function AnsweredByModelLabel({ model }: { model: StreamModelInfo }) {
	const t = useTranslations("tooltips.agents");
	const organizationId = useOrganizationId();
	const { data } = useQuery({
		...chatModelQueryOptions(organizationId),
		staleTime: 5 * 60 * 1000,
	});
	const identifier = model.canonicalName || model.id;
	const catalog = [
		...(data?.models ?? []),
		...(data?.chatgptPlan?.models ?? []),
	];
	let catalogName = getModelDisplayNameFromCatalog(catalog, identifier);
	if (catalogName === identifier && identifier !== model.id) {
		const byId = getModelDisplayNameFromCatalog(catalog, model.id);
		if (byId !== model.id) {
			catalogName = byId;
		}
	}
	const name =
		catalogName !== identifier
			? catalogName
			: formatUsageModel({
					modelCanonicalName: model.canonicalName ?? null,
					providerModelId: model.id,
				});
	const provider =
		model.viaPlan || model.provider
			? formatUsageProvider({
					provider: model.viaPlan
						? "OPENAI_CHATGPT_PLAN"
						: (model.provider ?? ""),
					providerModelId: model.id,
				})
			: undefined;
	return (
		<p className="mt-2 text-muted-foreground text-xs">
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className="rounded-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
					>
						{t("answeredByModel", { model: name })}
					</button>
				</TooltipTrigger>
				<TooltipContent>
					{[name, provider].filter(Boolean).join(" · ")}
				</TooltipContent>
			</Tooltip>
		</p>
	);
}
