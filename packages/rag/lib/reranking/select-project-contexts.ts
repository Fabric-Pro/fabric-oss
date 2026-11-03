import { rethrowIfDispatchStopped } from "@repo/utils/dispatch-guard";
import type { RetrievedContext } from "../project-contexts/retrieval";
import { rerankContexts } from "./index";
import type { RerankerProviderType, RerankerTenant } from "./types";
/** Rank matching passages, aggregate the best score per source, then cap sources. */
export async function selectProjectContexts(options: {
	contexts: RetrievedContext[];
	hits: Array<{ contextId: string; content?: string }>;
	query: string;
	limit: number;
	enabled: boolean;
	provider?: RerankerProviderType;
	tenant?: RerankerTenant;
}): Promise<RetrievedContext[]> {
	const { contexts, hits, limit } = options;
	let selected = contexts;
	if (options.enabled && contexts.length > 1) {
		const items = contexts.flatMap((context) => {
			const passages = [
				...new Set(
					hits
						.filter(
							(hit) =>
								hit.contextId === context.id &&
								hit.content?.trim(),
						)
						.map((hit) => hit.content ?? ""),
				),
			];
			return (passages.length ? passages : [context.content]).map(
				(content) => ({ ...context, content }),
			);
		});
		try {
			const ranked = await rerankContexts({
				query: options.query,
				contexts: items,
				topK: items.length,
				provider: options.provider,
				tenant: options.tenant,
			});
			if (
				ranked.stats.model !== "skipped" &&
				ranked.stats.model !== "fallback-passthrough"
			) {
				const best = new Map<string, RetrievedContext>();
				for (const item of ranked.contexts) {
					if (
						!best.has(item.id) ||
						item.score >
							(best.get(item.id)?.score ??
								Number.NEGATIVE_INFINITY)
					) {
						best.set(item.id, item);
					}
				}
				selected = contexts
					.filter((context) => best.has(context.id))
					.map((context) => {
						const item = best.get(context.id);
						return item
							? {
									...context,
									score: item.score,
									metadata: item.metadata,
								}
							: { ...context, score: Number.NEGATIVE_INFINITY };
					})
					.sort((a, b) => b.score - a.score);
			}
		} catch (error) {
			rethrowIfDispatchStopped(error);
		}
	}
	return selected.slice(0, limit);
}
