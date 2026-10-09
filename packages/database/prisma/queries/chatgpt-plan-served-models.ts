/**
 * The models each ChatGPT plan source serves (Fizzy #2770 F8), as its
 * `GET /v1/models` last listed them, and the plan-only catalog rows Fabric
 * adds for a model OpenAI lists before the catalog knows it.
 *
 * The served-model table has no organizationId. Callers pass only sources
 * they already resolved — the session's own userId, or account ids read
 * through the organization-filtered queries in `chatgpt-plan-org-accounts.ts`
 * and {@link listChatGptPlanOrgSources}.
 */

import { db } from "../client";
import type {
	ChatGptPlanServedModel,
	ChatGptPlanSourceKind,
} from "../generated/client";

export type { ChatGptPlanServedModel };

const CHATGPT_PLAN_PROVIDER = "OPENAI_CHATGPT_PLAN" as const;

/**
 * OpenAI's list names models `GPT-6-Luna`; the catalog writes `GPT-6 Luna`
 * (`GPT-6.1 Sol`). The hyphen after the version number becomes a space; the
 * version's own dot and hyphen stay.
 */
function catalogStyleModelName(name: string): string {
	return name.replace(/(\d)-(?=[A-Za-z])/g, "$1 ");
}

/** The catalog name of a row added from a plan's model list. */
export function chatGptPlanProbeCanonicalName(slug: string): string {
	return `${slug}-chatgpt-plan`;
}

/** `AiModel.metadata.origin` of a catalog row added from a plan's model list. */
export const CHATGPT_PLAN_AUTO_DETECTED_ORIGIN = "chatgpt-plan-probe";

/** The label every plan-only model carries in its display name. */
export const CHATGPT_PLAN_LABEL_SUFFIX = " (ChatGPT plan)";

export function isAutoDetectedChatGptPlanModel(metadata: unknown): boolean {
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		(metadata as { origin?: unknown }).origin ===
			CHATGPT_PLAN_AUTO_DETECTED_ORIGIN
	);
}

/** One model as a plan's model list names it. */
export interface ChatGptPlanListedModel {
	slug: string;
	displayName: string;
	description: string | null;
	priority: number | null;
}

/** Replaces the source's served list with what it listed at `checkedAt`. */
export async function replaceChatGptPlanServedModels(params: {
	sourceKind: ChatGptPlanSourceKind;
	sourceId: string;
	models: ChatGptPlanListedModel[];
	checkedAt: Date;
}): Promise<void> {
	const { sourceKind, sourceId, models, checkedAt } = params;
	await db.$transaction([
		db.chatGptPlanServedModel.deleteMany({
			where: { sourceKind, sourceId },
		}),
		db.chatGptPlanServedModel.createMany({
			data: models.map((model) => ({
				sourceKind,
				sourceId,
				slug: model.slug,
				displayName: model.displayName,
				description: model.description,
				priority: model.priority,
				checkedAt,
			})),
			skipDuplicates: true,
		}),
	]);
}

export async function getChatGptPlanServedModels(
	sources: Array<{ sourceKind: ChatGptPlanSourceKind; sourceId: string }>,
): Promise<ChatGptPlanServedModel[]> {
	if (sources.length === 0) {
		return [];
	}
	return db.chatGptPlanServedModel.findMany({
		where: {
			OR: sources.map(({ sourceKind, sourceId }) => ({
				sourceKind,
				sourceId,
			})),
		},
	});
}

/**
 * The plan sources that serve an organization's work: its enabled shared
 * accounts, and the own plans of members who turned theirs on here. Only
 * sources in good standing.
 */
export async function listChatGptPlanOrgSources(
	organizationId: string,
): Promise<Array<{ sourceKind: ChatGptPlanSourceKind; sourceId: string }>> {
	const [accounts, uses] = await Promise.all([
		db.chatGptPlanOrgAccount.findMany({
			where: { organizationId, enabled: true, status: "ACTIVE" },
			select: { id: true },
		}),
		db.chatGptPlanOrgUse.findMany({
			where: {
				organizationId,
				enabled: true,
				user: { chatGptPlanCredential: { status: "ACTIVE" } },
			},
			select: { userId: true },
		}),
	]);
	return [
		...accounts.map((account) => ({
			sourceKind: "ORG" as const,
			sourceId: account.id,
		})),
		...uses.map((use) => ({
			sourceKind: "USER" as const,
			sourceId: use.userId,
		})),
	];
}

/**
 * The family name of a plan model ("sol" for `gpt-6.1-sol`), which the
 * catalog's plan models share across versions.
 */
function familyOf(slug: string): string {
	return slug.split("-").at(-1) ?? slug;
}

/**
 * Adds a plan-only catalog row for each listed model no catalog row maps to
 * the plan yet, so the pickers can offer it (user decision 2026-10-08:
 * auto-add). Its specs are borrowed from the catalog's plan model of the same
 * family, else Sol; its name and description are OpenAI's. Idempotent:
 * a model already mapped is left alone. Returns the slugs it added.
 */
export async function ensureChatGptPlanCatalogModels(
	models: ChatGptPlanListedModel[],
): Promise<string[]> {
	if (models.length === 0) {
		return [];
	}
	const known = await db.aiModelProviderMapping.findMany({
		where: { provider: CHATGPT_PLAN_PROVIDER },
		select: {
			providerModelId: true,
			model: {
				select: {
					canonicalName: true,
					family: true,
					vendor: true,
					capabilities: true,
					contextWindow: true,
					maxOutputTokens: true,
					speedTier: true,
					qualityTier: true,
					suitableForTasks: true,
				},
			},
		},
	});
	const knownSlugs = new Set(known.map((mapping) => mapping.providerModelId));
	const added: string[] = [];
	for (const listed of models) {
		if (knownSlugs.has(listed.slug)) {
			continue;
		}
		const template =
			known.find(
				(mapping) =>
					familyOf(mapping.providerModelId) === familyOf(listed.slug),
			) ??
			known.find(
				(mapping) => familyOf(mapping.providerModelId) === "sol",
			) ??
			known[0];
		if (!template) {
			continue;
		}
		// Always suffixed: an unsuffixed name would be taken by the catalog
		// the day it adds the API model of the same slug.
		const canonicalName = chatGptPlanProbeCanonicalName(listed.slug);
		const name = catalogStyleModelName(listed.displayName);
		const displayName = name.endsWith(CHATGPT_PLAN_LABEL_SUFFIX)
			? name
			: `${name}${CHATGPT_PLAN_LABEL_SUFFIX}`;
		await db.aiModel.upsert({
			where: { canonicalName },
			create: {
				canonicalName,
				displayName,
				description: listed.description,
				family: template.model.family,
				vendor: template.model.vendor,
				capabilities: template.model.capabilities,
				contextWindow: template.model.contextWindow,
				maxOutputTokens: template.model.maxOutputTokens,
				speedTier: template.model.speedTier,
				qualityTier: template.model.qualityTier,
				suitableForTasks: template.model.suitableForTasks,
				metadata: {
					origin: CHATGPT_PLAN_AUTO_DETECTED_ORIGIN,
					pricedLike: template.model.canonicalName,
				},
				providerMappings: {
					create: {
						provider: CHATGPT_PLAN_PROVIDER,
						providerModelId: listed.slug,
					},
				},
			},
			update: {},
		});
		knownSlugs.add(listed.slug);
		added.push(listed.slug);
	}
	return added;
}
