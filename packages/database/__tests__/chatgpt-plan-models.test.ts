/**
 * The organization's ChatGPT plan model per task (Fizzy #2770): its own
 * choice, else the seeded default; a cleared choice falls back to the
 * default; only models a plan serves can be chosen. The Prisma client is
 * mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	prefFindMany: vi.fn(),
	prefDeleteMany: vi.fn(),
	prefUpsert: vi.fn(),
	modelFindFirst: vi.fn(),
	taskDefault: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		organizationModelPreference: {
			findMany: mocks.prefFindMany,
			deleteMany: mocks.prefDeleteMany,
			upsert: mocks.prefUpsert,
		},
		aiModel: { findFirst: mocks.modelFindFirst },
	},
}));

vi.mock("../prisma/queries/ai-models", () => ({
	getTaskDefaultModel: mocks.taskDefault,
}));

import {
	getChatGptPlanOrgModelChoices,
	setChatGptPlanOrgModel,
} from "../prisma/queries/chatgpt-plan-models";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.taskDefault.mockImplementation(async (taskType: string) => ({
		canonicalName: taskType === "SIMPLE" ? "gpt-5.6-luna" : "gpt-5.6-sol",
		displayName: taskType === "SIMPLE" ? "GPT-5.6 Luna" : "GPT-5.6 Sol",
	}));
});

describe("getChatGptPlanOrgModelChoices", () => {
	it("gives the organization's choice where it made one and the seeded default elsewhere", async () => {
		mocks.prefFindMany.mockResolvedValue([
			{
				taskType: "COMPLEX",
				model: {
					canonicalName: "gpt-6-astra",
					displayName: "GPT-6 Astra",
				},
			},
		]);
		const choices = await getChatGptPlanOrgModelChoices("org_a");
		expect(mocks.prefFindMany.mock.calls[0][0].where).toEqual({
			organizationId: "org_a",
			provider: "OPENAI_CHATGPT_PLAN",
		});
		expect(
			choices.map((row) => [
				row.taskType,
				row.model?.canonicalName,
				row.source,
			]),
		).toEqual([
			["COMPLEX", "gpt-6-astra", "organization"],
			["REASONING", "gpt-5.6-sol", "default"],
			["TOOL_CALLING", "gpt-5.6-sol", "default"],
			["CHAT", "gpt-5.6-sol", "default"],
			["EVAL", "gpt-5.6-sol", "default"],
			["SIMPLE", "gpt-5.6-luna", "default"],
		]);
	});
});

describe("setChatGptPlanOrgModel", () => {
	it("clears the choice so the default applies again", async () => {
		await expect(
			setChatGptPlanOrgModel({
				organizationId: "org_a",
				taskType: "CHAT",
				modelCanonicalName: null,
			}),
		).resolves.toBe(true);
		expect(mocks.prefDeleteMany).toHaveBeenCalledWith({
			where: {
				organizationId: "org_a",
				taskType: "CHAT",
				provider: "OPENAI_CHATGPT_PLAN",
			},
		});
	});

	it("refuses a model no ChatGPT plan serves", async () => {
		mocks.modelFindFirst.mockResolvedValue(null);
		await expect(
			setChatGptPlanOrgModel({
				organizationId: "org_a",
				taskType: "CHAT",
				modelCanonicalName: "claude-opus",
			}),
		).resolves.toBe(false);
		expect(mocks.prefUpsert).not.toHaveBeenCalled();
	});

	it("stores the choice for the plan provider only", async () => {
		mocks.modelFindFirst.mockResolvedValue({ id: "model_astra" });
		await setChatGptPlanOrgModel({
			organizationId: "org_a",
			taskType: "COMPLEX",
			modelCanonicalName: "gpt-6-astra",
		});
		expect(mocks.prefUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: {
					organizationId: "org_a",
					taskType: "COMPLEX",
					provider: "OPENAI_CHATGPT_PLAN",
					modelId: "model_astra",
				},
			}),
		);
	});
});
