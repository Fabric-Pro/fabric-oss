import { expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ getModelForTask: vi.fn() }));
vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY"],
	TEXT_TASK_TYPES: [
		"SIMPLE",
		"COMPLEX",
		"REASONING",
		"CHAT",
		"TOOL_CALLING",
		"EVAL",
	],
	getModelForTask: db.getModelForTask,
}));
vi.mock("@repo/payments", () => ({ assertWithinAiUsageLimits: vi.fn() }));

import { selectModelDynamic } from "../dynamic-model-selector";

// Dropping ignorePreferences at the selector boundary returns the saved model
// for both sides of the preview and suppresses a necessary re-index warning.
it("uses runtime selection with preferences ignored only for the post-reset preview", async () => {
	db.getModelForTask.mockImplementation(async (...args: unknown[]) => {
		const name = (args[6] as { ignorePreferences?: boolean } | undefined)
			?.ignorePreferences
			? "example-default"
			: "example-saved";
		return {
			model: {
				id: name,
				canonicalName: name,
				displayName: name,
				contextWindow: 4096,
			},
			providerModelId: name,
			source: "system_default",
		};
	});
	const context = { userId: "example-user", organizationId: "example-org" };
	const current = await selectModelDynamic(
		{ taskType: "EMBEDDING", preferredProvider: "OPENAI_DIRECT" },
		context,
	);
	const after = await selectModelDynamic(
		{
			taskType: "EMBEDDING",
			preferredProvider: "OPENAI_DIRECT",
			ignorePreferences: true,
		},
		context,
	);
	expect(current.canonicalName).toBe("example-saved");
	expect(after.canonicalName).toBe("example-default");
});
