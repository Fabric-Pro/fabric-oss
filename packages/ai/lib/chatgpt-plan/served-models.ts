import { CHATGPT_PLAN_ORIGIN } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	type ChatGptPlanListedModel,
	type ChatGptPlanServedModel,
	ensureChatGptPlanCatalogModels,
	replaceChatGptPlanServedModels,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type ChatGptPlanAccessToken,
	getChatGptPlanAccessToken,
	getChatGptPlanSourceAccessToken,
} from "./plan-credentials";
import {
	__resetChatGptPlanServedSlugs,
	invalidateChatGptPlanServedSlugs,
} from "./served-slugs";
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
 * model the catalog does not know yet. `token` saves a lookup right after a
 * connect; otherwise the source's own (refreshed) token is used. The list is
 * stored only while the source still has the sign-in that token came from
 * (Fizzy #3037): a probe that outlives a replacement or a disconnect stores
 * nothing.
 */
export async function refreshChatGptPlanServedModels(
	source: PlanSourceRef,
	options: {
		token?: PlanToken;
		fetchImpl?: typeof fetch;
		now?: Date;
	} = {},
): Promise<ChatGptPlanListedModel[]> {
	const token: PlanToken =
		options.token ??
		(source.kind === "user"
			? await getChatGptPlanAccessToken(source.userId)
			: await getChatGptPlanSourceAccessToken(source));
	const models = await fetchChatGptPlanModelList(
		token.accessToken,
		options.fetchImpl,
	);
	if (models.length === 0) {
		// An empty list says nothing about what the plan serves; keep the last.
		return models;
	}
	// Catalog rows are shared by every source, not this source's state.
	await ensureChatGptPlanCatalogModels(models);
	let stored: boolean;
	try {
		stored = await replaceChatGptPlanServedModels({
			...planSourceStateKey(source),
			models,
			checkedAt: options.now ?? new Date(),
			credentialFingerprint: token.credentialFingerprint,
		});
	} catch (error) {
		// It may still have landed; a list read before it must not be kept.
		invalidateChatGptPlanServedSlugs(source);
		throw error;
	}
	if (!stored) {
		logger.info(
			"[chatgpt-plan] Dropped a model list read with a replaced sign-in",
			planSourceLogFields(source),
		);
		return models;
	}
	// A list read before the replace landed must not be kept.
	invalidateChatGptPlanServedSlugs(source);
	return models;
}

type PlanToken = Pick<
	ChatGptPlanAccessToken,
	"accessToken" | "credentialFingerprint"
>;

const inFlight = new Map<string, Promise<unknown>>();

/**
 * {@link refreshChatGptPlanServedModels}, fire-and-forget: logged, never
 * thrown, and one probe per source and sign-in at a time in this process. A
 * probe that brings its own token is never held back by one that began
 * before, which may have read a sign-in since replaced.
 */
export function refreshChatGptPlanServedModelsInBackground(
	source: PlanSourceRef,
	options: { token?: PlanToken } = {},
): void {
	const key = `${planSourceKey(source)}#${options.token?.credentialFingerprint ?? ""}`;
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

export function __resetChatGptPlanServedModelProbes(): void {
	inFlight.clear();
	__resetChatGptPlanServedSlugs();
}
