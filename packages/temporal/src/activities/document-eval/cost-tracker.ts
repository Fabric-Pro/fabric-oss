/**
 * Evaluation cost tracking utilities.
 */

import { db } from "@repo/database";
import { startOfMonth } from "date-fns";

const COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
	"gpt-4o": { input: 0.005, output: 0.015 },
	"gpt-4o-mini": { input: 0.00015, output: 0.0006 },
	"claude-3-5-sonnet": { input: 0.003, output: 0.015 },
	"claude-3-haiku": { input: 0.00025, output: 0.00125 },
	"llama-3.3-70b": { input: 0.0007, output: 0.0008 },
	"llama-3.1-8b": { input: 0.00005, output: 0.00008 },
};

const AVG_EVAL_TOKENS = {
	input: 2000,
	output: 500,
};

export function estimateEvalCost(model: string): number {
	// Normalize model string - handle provider prefixes like "openai/gpt-4o"
	const parts = model.split("/");
	const normalizedModel = parts.length > 1 ? parts[parts.length - 1] : model;
	const pricing =
		COST_PER_1K_TOKENS[normalizedModel] ??
		COST_PER_1K_TOKENS["gpt-4o-mini"];
	const inputCost = (AVG_EVAL_TOKENS.input / 1000) * pricing.input;
	const outputCost = (AVG_EVAL_TOKENS.output / 1000) * pricing.output;
	return Math.round((inputCost + outputCost) * 10000) / 10000;
}

export async function recordEvalCost(params: {
	organizationId: string;
	costUsd: number;
}) {
	const { organizationId, costUsd } = params;
	if (!organizationId || costUsd <= 0) {
		return;
	}

	const monthStart = startOfMonth(new Date());

	await db.organizationEvalBudget.upsert({
		where: { organizationId },
		create: {
			organizationId,
			currentMonthUsd: costUsd,
			lastResetAt: monthStart,
		},
		update: {
			currentMonthUsd: {
				increment: costUsd,
			},
			lastResetAt: monthStart,
		},
	});
}

export async function isOverBudget(organizationId: string): Promise<boolean> {
	if (!organizationId) {
		return false;
	}

	const budget = await db.organizationEvalBudget.findUnique({
		where: { organizationId },
	});

	if (!budget || !budget.monthlyBudgetUsd) {
		return false;
	}

	const monthStart = startOfMonth(new Date());
	if (budget.lastResetAt < monthStart) {
		await db.organizationEvalBudget.update({
			where: { organizationId },
			data: { currentMonthUsd: 0, lastResetAt: monthStart },
		});
		return false;
	}

	return budget.currentMonthUsd >= budget.monthlyBudgetUsd;
}
