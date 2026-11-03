"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { aiConfigStatusQueryKey } from "@saas/shared/components/AiGatewayWarningBanner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { CpuIcon } from "lucide-react";

export type LocalModel = { model: string; provider: string };
export type LocalModels = {
	embedding: LocalModel | null;
	decision: LocalModel | null;
	image: LocalModel | null;
};

/** The task types a local model can serve, with their labels. */
const LOCAL_TASKS = [
	["embedding", "Embeddings"],
	["decision", "Decisions"],
	["image", "Image generation"],
] as const;

/**
 * The local-development models (packages/ai/lib/local-models.ts): per task,
 * the model a local server serves it with, or null. Every task is null outside
 * NODE_ENV=development. Shares the AI-config status cache.
 */
export function useLocalModels(): LocalModels | null {
	const { organizationId, isOrgContext } = useOrganizationContext();
	const { data } = useQuery({
		queryKey: aiConfigStatusQueryKey(organizationId ?? null),
		queryFn: () =>
			orpcClient.aiConfig.resolution.getStatus({ organizationId }),
		enabled: Boolean(isOrgContext),
	});
	return data?.localModels ?? null;
}

/** States which tasks run on local servers while the overrides are on. */
export function LocalModelsNotice({ models }: { models: LocalModels }) {
	const active = LOCAL_TASKS.flatMap(([task, label]) => {
		const local = models[task];
		return local ? [{ label, ...local }] : [];
	});
	if (active.length === 0) {
		return null;
	}
	return (
		<div
			className="rounded-md border border-success/20 bg-success/5 p-4"
			data-testid="local-models-notice"
		>
			<div className="flex gap-3">
				<CpuIcon className="size-5 shrink-0 text-success" />
				<div className="space-y-1 text-sm">
					<p className="font-medium text-foreground">
						Local models (development)
					</p>
					<ul className="text-success/80">
						{active.map(({ label, model, provider }) => (
							<li key={label}>
								{label}:{" "}
								<code className="font-mono">{model}</code> on{" "}
								{provider}
							</li>
						))}
					</ul>
					<p className="text-success/80">
						Set in .env.local (FABRIC_LOCAL_OLLAMA,
						FABRIC_LOCAL_LOCALAI). The providers and models chosen
						here apply again to a task when its local model is
						switched off.
					</p>
				</div>
			</div>
		</div>
	);
}
