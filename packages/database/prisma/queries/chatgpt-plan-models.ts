/**
 * Which ChatGPT plan model runs which kind of work in an organization
 * (Fizzy #2770). The organization decides; a member who connects a plan, and
 * every shared account, runs what it chose. Stored as ordinary
 * `OrganizationModelPreference` rows for the `OPENAI_CHATGPT_PLAN` provider,
 * so model resolution reads them like any other provider's: the
 * organization's choice, else the seeded default for the task.
 */

import { db } from "../client";
import type { AiTaskType } from "../generated/client";
import { getTaskDefaultModel } from "./ai-models";
import { DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL } from "./chatgpt-plan-org-accounts";
import {
	CHATGPT_PLAN_LABEL_SUFFIX,
	isAutoDetectedChatGptPlanModel,
} from "./chatgpt-plan-served-models";

const CHATGPT_PLAN_PROVIDER = "OPENAI_CHATGPT_PLAN" as const;

/** The work a plan can run, heaviest first; a plan never serves non-text work. */
export const CHATGPT_PLAN_MODEL_TASK_TYPES = [
	"COMPLEX",
	"REASONING",
	"TOOL_CALLING",
	"CHAT",
	"EVAL",
	"SIMPLE",
] as const satisfies readonly AiTaskType[];

export type ChatGptPlanModelTaskType =
	(typeof CHATGPT_PLAN_MODEL_TASK_TYPES)[number];

export interface ChatGptPlanModelSummary {
	canonicalName: string;
	/** The model id a plan call names. */
	slug: string;
	/** Always carries the plan label, Astra's shared catalog row included. */
	displayName: string;
	description: string | null;
	/** Added from a plan's model list rather than seeded. */
	autoDetected: boolean;
}

/** A plan model's name as every plan picker shows it (Fizzy #2770 F7). */
export function chatGptPlanModelLabel(displayName: string): string {
	return displayName.endsWith(CHATGPT_PLAN_LABEL_SUFFIX)
		? displayName
		: `${displayName}${CHATGPT_PLAN_LABEL_SUFFIX}`;
}

/** The models a ChatGPT plan serves, as the catalog maps them. */
export async function listChatGptPlanModels(): Promise<
	ChatGptPlanModelSummary[]
> {
	const rows = await db.aiModel.findMany({
		where: {
			isActive: true,
			providerMappings: {
				some: { provider: CHATGPT_PLAN_PROVIDER, isAvailable: true },
			},
		},
		select: {
			canonicalName: true,
			displayName: true,
			description: true,
			metadata: true,
			providerMappings: {
				where: { provider: CHATGPT_PLAN_PROVIDER, isAvailable: true },
				select: { providerModelId: true },
			},
		},
		orderBy: { displayName: "asc" },
	});
	return rows.map((row) => ({
		canonicalName: row.canonicalName,
		slug: row.providerMappings[0]?.providerModelId ?? row.canonicalName,
		displayName: chatGptPlanModelLabel(row.displayName),
		description: row.description,
		autoDetected: isAutoDetectedChatGptPlanModel(row.metadata),
	}));
}

/**
 * Sets the plan model a call retries on when the plan does not serve the
 * chosen one, or with `null` turns the retry off. False when the model is not
 * one a ChatGPT plan serves. Returns the value before, for the audit trail.
 */
export async function setChatGptPlanOrgFallbackModel(params: {
	organizationId: string;
	slug: string | null;
}): Promise<{ saved: boolean; before: string | null }> {
	const { organizationId, slug } = params;
	if (slug !== null) {
		const served = await db.aiModelProviderMapping.findFirst({
			where: {
				provider: CHATGPT_PLAN_PROVIDER,
				providerModelId: slug,
				isAvailable: true,
				model: { isActive: true },
			},
			select: { id: true },
		});
		if (!served) {
			return { saved: false, before: null };
		}
	}
	const existing = await db.chatGptPlanOrgPolicy.findUnique({
		where: { organizationId },
		select: { fallbackModel: true },
	});
	await db.chatGptPlanOrgPolicy.upsert({
		where: { organizationId },
		create: { organizationId, fallbackModel: slug },
		update: { fallbackModel: slug },
	});
	return {
		saved: true,
		// No row yet: the organization had the default.
		before: existing
			? existing.fallbackModel
			: DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL,
	};
}

export interface ChatGptPlanModelChoiceRow {
	taskType: ChatGptPlanModelTaskType;
	model: { canonicalName: string; displayName: string } | null;
	/** `organization` when it chose; `default` for the seeded default. */
	source: "organization" | "default";
}

/** The organization's model per task, or the seeded default where it chose none. */
export async function getChatGptPlanOrgModelChoices(
	organizationId: string,
): Promise<ChatGptPlanModelChoiceRow[]> {
	const rows = await db.organizationModelPreference.findMany({
		where: { organizationId, provider: CHATGPT_PLAN_PROVIDER },
		select: {
			taskType: true,
			model: { select: { canonicalName: true, displayName: true } },
		},
	});
	const chosen = new Map(rows.map((row) => [row.taskType, row.model]));
	return Promise.all(
		CHATGPT_PLAN_MODEL_TASK_TYPES.map(async (taskType) => {
			const own = chosen.get(taskType);
			if (own) {
				return {
					taskType,
					model: own,
					source: "organization" as const,
				};
			}
			const fallback = await getTaskDefaultModel(
				taskType,
				"MEDIUM",
				CHATGPT_PLAN_PROVIDER,
			);
			return {
				taskType,
				model: fallback
					? {
							canonicalName: fallback.canonicalName,
							displayName: fallback.displayName,
						}
					: null,
				source: "default" as const,
			};
		}),
	);
}

/**
 * Sets the organization's model for one task, or with `null` removes its
 * choice so the seeded default applies again. False when the model is not
 * one a ChatGPT plan serves.
 */
export async function setChatGptPlanOrgModel(params: {
	organizationId: string;
	taskType: ChatGptPlanModelTaskType;
	modelCanonicalName: string | null;
}): Promise<boolean> {
	const { organizationId, taskType, modelCanonicalName } = params;
	if (modelCanonicalName === null) {
		await db.organizationModelPreference.deleteMany({
			where: {
				organizationId,
				taskType,
				provider: CHATGPT_PLAN_PROVIDER,
			},
		});
		return true;
	}
	const model = await db.aiModel.findFirst({
		where: {
			canonicalName: modelCanonicalName,
			isActive: true,
			providerMappings: {
				some: { provider: CHATGPT_PLAN_PROVIDER, isAvailable: true },
			},
		},
		select: { id: true },
	});
	if (!model) {
		return false;
	}
	await db.organizationModelPreference.upsert({
		where: {
			organizationId_taskType_provider: {
				organizationId,
				taskType,
				provider: CHATGPT_PLAN_PROVIDER,
			},
		},
		create: {
			organizationId,
			taskType,
			provider: CHATGPT_PLAN_PROVIDER,
			modelId: model.id,
		},
		update: { modelId: model.id },
	});
	return true;
}
