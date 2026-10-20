import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	authorize: vi.fn(),
	agentsAllowed: vi.fn(),
	skillsAllowed: vi.fn(),
	models: vi.fn(),
	instances: vi.fn(),
	skills: vi.fn(),
	templates: vi.fn(),
}));
vi.mock("../../../../orpc/middleware/require-permission", () => ({
	authorizeInputOrganization: mocks.authorize,
}));
vi.mock("@repo/database", () => ({
	canReadOrganizationAgentTemplates: mocks.agentsAllowed,
	canReadOrganizationSkills: mocks.skillsAllowed,
	listAgentTemplateInstances: mocks.instances,
	db: { agentTemplate: { findMany: mocks.templates } },
}));
vi.mock("@repo/ai/skills", () => ({
	listAvailableSkillPage: mocks.skills,
	isTextContentType: (type: string) =>
		type.startsWith("text/") || type === "application/json",
}));
vi.mock("../available-models", () => ({ listAvailableModels: mocks.models }));

import {
	listReviewSelectorOptions,
	reviewSelectorPageSchema,
} from "../review-selector-options";

const context = { userId: "user-1", organizationId: "org-1" };
const input = reviewSelectorPageSchema.parse({ limit: 1 });
const model = {
	id: "model-1",
	canonicalName: "example-model",
	displayName: "Example Model",
	providerMappings: [
		{
			provider: "OPENAI_DIRECT",
			providerModelId: "example-model",
			isAvailable: true,
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.authorize.mockResolvedValue("org-1");
	mocks.agentsAllowed.mockResolvedValue(true);
	mocks.skillsAllowed.mockResolvedValue(true);
	mocks.models.mockResolvedValue({
		defaultProvider: "OPENAI_DIRECT",
		models: [model, { ...model, id: "model-2" }],
		chatgptPlan: {
			model: "plan-model",
			source: "own",
			models: [],
			spent: { until: null },
		},
		configuredProviders: [{ config: "must-not-leak" }],
	});
	mocks.instances.mockResolvedValue({
		instances: [
			{
				id: "instance-1",
				name: "Example Instructions",
				version: 2,
				templateId: "template-1",
				modelOverride: null,
			},
		],
		total: 2,
	});
	mocks.templates.mockResolvedValue([
		{ id: "template-1", suggestedModel: "example-model" },
	]);
	mocks.skills.mockResolvedValue({
		skills: [
			{
				slug: "example-skill",
				name: "Example Skill",
				version: 3,
				fileManifestComplete: false,
				files: [
					{
						path: "guide.md",
						sizeBytes: 200,
						contentType: "text/markdown",
					},
					{
						path: "script.js",
						sizeBytes: 200,
						contentType: "text/javascript",
					},
					{
						path: "large.txt",
						sizeBytes: 20_001,
						contentType: "text/plain",
					},
					{
						path: "image.txt",
						sizeBytes: 20,
						contentType: "image/png",
					},
				],
			},
		],
		hasMore: true,
	});
});

describe("authorized review selectors", () => {
	it("uses the current tenant, active instance helper and exact evaluator task", async () => {
		const result = await listReviewSelectorOptions(context, input);
		expect(mocks.authorize).toHaveBeenCalledWith(
			expect.any(String),
			"org-1",
			{
				user: { id: "user-1" },
				session: { activeOrganizationId: "org-1" },
			},
			{ requireOrganization: true },
		);
		expect(mocks.agentsAllowed).toHaveBeenCalledWith("user-1", "org-1");
		expect(mocks.skillsAllowed).toHaveBeenCalledWith("user-1", "org-1");
		expect(mocks.models).toHaveBeenCalledWith({
			...context,
			sessionOrganizationId: "org-1",
			taskType: "SIMPLE",
		});
		expect(mocks.instances).toHaveBeenCalledWith(
			expect.objectContaining({
				...context,
				status: "ACTIVE",
				latestVersionOnly: true,
				offset: 0,
				limit: 1,
			}),
		);
		expect(result.instructionInstances.items).toEqual([
			{
				id: "instance-1",
				label: "Example Instructions",
				version: 2,
				model: "example-model",
			},
		]);
	});

	it("returns bounded option descriptors with explicit pagination and preserved availability/plan state", async () => {
		const result = await listReviewSelectorOptions(context, input);
		expect(result.models).toEqual({
			items: [
				{
					id: "model-1",
					canonicalName: "example-model",
					label: "Example Model",
					providerMappings: model.providerMappings,
				},
			],
			hasMore: true,
			nextOffset: 1,
		});
		expect(result.chatgptPlan).toMatchObject({
			source: "own",
			spent: { until: null },
			models: { items: [], hasMore: false, nextOffset: null },
		});
		expect(result.instructionInstances).toMatchObject({
			hasMore: true,
			nextOffset: 1,
		});
		expect(result.skills.items).toEqual([
			{
				slug: "example-skill",
				label: "Example Skill",
				version: 3,
				textFiles: [
					{
						path: "guide.md",
						sizeBytes: 200,
						contentType: "text/markdown",
					},
				],
				fileManifestComplete: false,
			},
		]);
		expect(result.skills).toMatchObject({ hasMore: true, nextOffset: 1 });
		expect(JSON.stringify(result)).not.toContain("must-not-leak");
	});

	it.each(["agents", "skills"])(
		"refuses a revoked %s permission before discovering any options",
		async (kind) => {
			(kind === "agents"
				? mocks.agentsAllowed
				: mocks.skillsAllowed
			).mockResolvedValueOnce(false);
			await expect(
				listReviewSelectorOptions(context, input),
			).rejects.toThrow("access denied");
			expect(mocks.models).not.toHaveBeenCalled();
			expect(mocks.instances).not.toHaveBeenCalled();
			expect(mocks.skills).not.toHaveBeenCalled();
		},
	);

	it("refuses model permission denial before other data reads", async () => {
		mocks.authorize.mockRejectedValueOnce(new Error("denied"));
		await expect(listReviewSelectorOptions(context, input)).rejects.toThrow(
			"denied",
		);
		expect(mocks.models).not.toHaveBeenCalled();
		expect(mocks.instances).not.toHaveBeenCalled();
	});

	it("bounds pagination inputs", () => {
		for (const invalid of [
			{ limit: 51 },
			{ limit: 0 },
			{ modelOffset: -1 },
			{ skillOffset: 0.5 },
		]) {
			expect(reviewSelectorPageSchema.safeParse(invalid).success).toBe(
				false,
			);
		}
	});
});
