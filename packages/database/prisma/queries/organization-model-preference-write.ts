import { db, type Prisma } from "../client";
import type { AIProvider } from "../generated/client";
import type { setOrgModelPreference } from "./ai-models";

type PreferenceInput = Parameters<typeof setOrgModelPreference>[0];
type PreferenceTransaction = Pick<
	Prisma.TransactionClient,
	"$queryRaw" | "organizationModelPreference"
>;

/** Serialize task replacements even when the tenant has no provider rows left. */
async function lockOrganizationPreferences(
	tx: PreferenceTransaction,
	organizationId: string,
): Promise<void> {
	await tx.$queryRaw`SELECT id FROM "organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`;
}

async function writeReplacement(
	tx: PreferenceTransaction,
	data: PreferenceInput,
) {
	await tx.organizationModelPreference.deleteMany({
		where: {
			organizationId: data.organizationId,
			taskType: data.taskType,
			provider: { not: "OPENAI_CHATGPT_PLAN" },
		},
	});
	return tx.organizationModelPreference.upsert({
		where: {
			organizationId_taskType_provider: {
				organizationId: data.organizationId,
				taskType: data.taskType,
				provider: data.provider,
			},
		},
		create: data,
		update: {
			modelId: data.modelId,
			customParameters: data.customParameters,
		},
		include: { model: true },
	});
}

/** Replace an API task choice under one organization lock and transaction. */
export async function replaceOrgModelPreferenceForTask(data: PreferenceInput) {
	return db.$transaction(async (tx) => {
		await lockOrganizationPreferences(tx, data.organizationId);
		return writeReplacement(tx, data);
	});
}

/** Retain an off switch when removing a selected non-gateway decision provider. */
export async function disableOrgDecisionPreferenceForProvider(
	tx: PreferenceTransaction,
	organizationId: string,
	provider: AIProvider,
): Promise<void> {
	if (provider === "VERCEL_GATEWAY") {
		return;
	}
	await lockOrganizationPreferences(tx, organizationId);
	const selected = await tx.organizationModelPreference.findFirst({
		where: {
			organizationId,
			provider,
			taskType: "DECISION",
			modelId: { not: null },
		},
		select: { id: true },
	});
	if (!selected) {
		return;
	}
	await writeReplacement(tx, {
		organizationId,
		taskType: "DECISION",
		provider: "VERCEL_GATEWAY",
		modelId: null,
	});
}
