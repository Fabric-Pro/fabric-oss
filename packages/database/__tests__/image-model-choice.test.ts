import { beforeEach, expect, it, vi } from "vitest";

const { findImagePreference, resolveModel } = vi.hoisted(() => ({
	findImagePreference: vi.fn(),
	resolveModel: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		organizationModelPreference: { findFirst: findImagePreference },
	},
}));

vi.mock("../prisma/queries/model-resolution", () => ({ resolveModel }));

import { resolveImageModelChoice } from "../prisma/queries/image-model-choice";

beforeEach(() => {
	vi.clearAllMocks();
	resolveModel.mockImplementation(async ({ provider }) => ({
		provider,
		providerModelId:
			provider === "OPENAI_DIRECT"
				? "gpt-image-2"
				: "google/gemini-3.1-flash-image-preview",
	}));
});

it("returns the organization's OPENAI_DIRECT IMAGE choice", async () => {
	findImagePreference.mockResolvedValue({ provider: "OPENAI_DIRECT" });

	await expect(
		resolveImageModelChoice({
			userId: "example-user",
			organizationId: "example-org",
		}),
	).resolves.toEqual({
		provider: "OPENAI_DIRECT",
		providerModelId: "gpt-image-2",
	});
	expect(findImagePreference).toHaveBeenCalledWith({
		where: {
			organizationId: "example-org",
			taskType: "IMAGE",
			provider: { in: ["VERCEL_GATEWAY", "OPENAI_DIRECT"] },
			modelId: { not: null },
		},
		orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
		select: { provider: true },
	});
	expect(resolveModel).toHaveBeenCalledWith({
		userId: "example-user",
		organizationId: "example-org",
		taskType: "IMAGE",
		provider: "OPENAI_DIRECT",
	});
});

it("uses the latest saved IMAGE choice with an id tie-break", async () => {
	findImagePreference.mockResolvedValue({ provider: "OPENAI_DIRECT" });

	await expect(
		resolveImageModelChoice({
			userId: "example-user",
			organizationId: "example-org",
		}),
	).resolves.toMatchObject({ provider: "OPENAI_DIRECT" });
	expect(findImagePreference).toHaveBeenCalledWith(
		expect.objectContaining({
			orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
		}),
	);
});

it("returns the Vercel IMAGE task default when the organization has no choice", async () => {
	findImagePreference.mockResolvedValue(null);

	await expect(
		resolveImageModelChoice({
			userId: "example-user",
			organizationId: "example-org",
		}),
	).resolves.toEqual({
		provider: "VERCEL_GATEWAY",
		providerModelId: "google/gemini-3.1-flash-image-preview",
	});
	expect(resolveModel).toHaveBeenCalledWith(
		expect.objectContaining({
			provider: "VERCEL_GATEWAY",
			taskType: "IMAGE",
		}),
	);
});
