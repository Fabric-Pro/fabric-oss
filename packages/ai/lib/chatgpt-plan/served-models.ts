import { CHATGPT_PLAN_ORIGIN } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	type ChatGptPlanListedModel,
	type ChatGptPlanServedModel,
	ensureChatGptPlanCatalogModels,
	getChatGptPlanServedModels,
	replaceChatGptPlanServedModels,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	getChatGptPlanAccessToken,
	getChatGptPlanSourceAccessToken,
} from "./plan-credentials";
import {
	type PlanSourceRef,
	planSourceKey,
	planSourceLogFields,
	planSourceStateKey,
} from "./sources";

/**
 * Which models each ChatGPT plan source serves (Fizzy #2770 F8), from the
 * account's own catalog: `GET /v1/models` with the plan's access token, the
 * request OpenAI documents for populating a model picker. Probed when a plan
 * connects, and again when a picker reads a list older than a day. Never on a
 * model call's path.
 */

/** A stored list older than this is refreshed when a picker reads it. */
export const CHATGPT_PLAN_SERVED_MODELS_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * The models a list response offers for display, in the server's order.
 * Entries not meant for a picker (`visibility` other than `list`) or without
 * a slug are dropped.
 */
export function parseChatGptPlanModelList(
	body: unknown,
): ChatGptPlanListedModel[] {
	const models =
		body && typeof body === "object"
			? (body as { models?: unknown }).models
			: undefined;
	if (!Array.isArray(models)) {
		return [];
	}
	return models.flatMap((entry): ChatGptPlanListedModel[] => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const model = entry as Record<string, unknown>;
		if (typeof model.slug !== "string" || model.slug === "") {
			return [];
		}
		if (model.visibility !== undefined && model.visibility !== "list") {
			return [];
		}
		return [
			{
				slug: model.slug,
				displayName:
					typeof model.display_name === "string" && model.display_name
						? model.display_name
						: model.slug,
				description:
					typeof model.description === "string"
						? model.description
						: null,
				priority:
					typeof model.priority === "number" ? model.priority : null,
			},
		];
	});
}

/** Lists the models the account behind `accessToken` serves. */
export async function fetchChatGptPlanModelList(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ChatGptPlanListedModel[]> {
	const response = await fetchImpl(`${CHATGPT_PLAN_ORIGIN}/v1/models`, {
		headers: { authorization: `Bearer ${accessToken}` },
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Listing the plan's models failed: ${response.status}`);
	}
	return parseChatGptPlanModelList(await response.json());
}

/**
 * Probes one source and stores what it serves, adding a catalog row for any
 * model the catalog does not know yet. `accessToken` saves a lookup right
 * after a connect; otherwise the source's own (refreshed) token is used.
 */
export async function refreshChatGptPlanServedModels(
	source: PlanSourceRef,
	options: {
		accessToken?: string;
		fetchImpl?: typeof fetch;
		now?: Date;
	} = {},
): Promise<ChatGptPlanListedModel[]> {
	const accessToken =
		options.accessToken ??
		(source.kind === "user"
			? await getChatGptPlanAccessToken(source.userId)
			: await getChatGptPlanSourceAccessToken(source)
		).accessToken;
	const models = await fetchChatGptPlanModelList(
		accessToken,
		options.fetchImpl,
	);
	if (models.length === 0) {
		// An empty list says nothing about what the plan serves; keep the last.
		return models;
	}
	await ensureChatGptPlanCatalogModels(models);
	await replaceChatGptPlanServedModels({
		...planSourceStateKey(source),
		models,
		checkedAt: options.now ?? new Date(),
	});
	slugCache.delete(planSourceKey(source));
	return models;
}

const inFlight = new Map<string, Promise<unknown>>();

// Every plan-served call resolves its model against the stored list, so a
// process reuses it briefly; a refresh in this process replaces it at once.
const SERVED_SLUGS_CACHE_MS = 60_000;
const slugCache = new Map<
	string,
	{ slugs: Set<string> | null; fetchedAt: number }
>();

/**
 * {@link refreshChatGptPlanServedModels}, fire-and-forget: logged, never
 * thrown, and one probe per source at a time in this process.
 */
export function refreshChatGptPlanServedModelsInBackground(
	source: PlanSourceRef,
	options: { accessToken?: string } = {},
): void {
	const key = planSourceKey(source);
	if (inFlight.has(key)) {
		return;
	}
	const run = refreshChatGptPlanServedModels(source, options)
		.catch((error) => {
			logger.warn("[chatgpt-plan] Listing the plan's models failed", {
				...planSourceLogFields(source),
				error: error instanceof Error ? error.message : String(error),
			});
		})
		.finally(() => inFlight.delete(key));
	inFlight.set(key, run);
}

/**
 * Starts a background refresh for each source whose stored list is missing or
 * older than {@link CHATGPT_PLAN_SERVED_MODELS_MAX_AGE_MS}, given the rows
 * already read for them.
 */
export function refreshStaleChatGptPlanServedModels(
	sources: PlanSourceRef[],
	rows: ChatGptPlanServedModel[],
	now = Date.now(),
): void {
	for (const source of sources) {
		const { sourceKind, sourceId } = planSourceStateKey(source);
		const checked = rows
			.filter(
				(row) =>
					row.sourceKind === sourceKind && row.sourceId === sourceId,
			)
			.map((row) => row.checkedAt.getTime());
		const newest = checked.length > 0 ? Math.max(...checked) : null;
		if (
			newest === null ||
			now - newest > CHATGPT_PLAN_SERVED_MODELS_MAX_AGE_MS
		) {
			refreshChatGptPlanServedModelsInBackground(source);
		}
	}
}

/**
 * The slugs this source served when last checked, or null when it was never
 * checked (or the lookup failed) — then nothing is known to be unserved.
 */
export async function chatGptPlanServedSlugs(
	source: PlanSourceRef,
	now = Date.now(),
): Promise<Set<string> | null> {
	const key = planSourceKey(source);
	const cached = slugCache.get(key);
	if (cached && now - cached.fetchedAt < SERVED_SLUGS_CACHE_MS) {
		return cached.slugs;
	}
	try {
		const rows = await getChatGptPlanServedModels([
			planSourceStateKey(source),
		]);
		const slugs =
			rows.length > 0 ? new Set(rows.map((row) => row.slug)) : null;
		slugCache.set(key, { slugs, fetchedAt: now });
		return slugs;
	} catch {
		return null;
	}
}

export function __resetChatGptPlanServedModelProbes(): void {
	inFlight.clear();
	slugCache.clear();
}
