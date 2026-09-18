import { describe, expect, it, vi } from "vitest";

const { mockGetDefaultProvider, mockGetModel, mockSetPreference } = vi.hoisted(
	() => ({
		mockGetDefaultProvider: vi.fn(),
		mockGetModel: vi.fn(),
		mockSetPreference: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	deleteUserModelPreferencesByTaskType: vi.fn(),
	getAiProviderApiKey: (...args: unknown[]) =>
		mockGetDefaultProvider(...args),
	getModelByCanonicalName: (...args: unknown[]) => mockGetModel(...args),
	isGatewayProvider: vi.fn(),
	setUserModelPreference: (...args: unknown[]) => mockSetPreference(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(() => null),
		requirePermission: vi.fn(() => ({})),
		Permissions: { ORG_AI_CONFIG_EDIT: "org_ai_config_edit" },
	};
});

import { setUserModelPreferenceProcedure } from "../set-user";

const setPreference = setUserModelPreferenceProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: { user: { id: string }; session: unknown };
	}) => Promise<unknown>;
};

describe("set user model preference", () => {
	it("rejects an evaluation-only model for every user text task", async () => {
		mockGetDefaultProvider.mockResolvedValue({ provider: "OPENAI_DIRECT" });
		mockGetModel.mockResolvedValue({
			id: "model-jev",
			canonicalName: "typesafe-ai-jev",
			capabilities: ["EVALUATION"],
			suitableForTasks: ["DECISION"],
			providerMappings: [],
		});

		await expect(
			setPreference._handler({
				input: {
					taskType: "SIMPLE",
					modelCanonicalName: "typesafe-ai-jev",
				},
				context: { user: { id: "user-1" }, session: {} },
			}),
		).rejects.toMatchObject({
			message:
				"Evaluation models can only be configured for DECISION tasks.",
		});
		expect(mockSetPreference).not.toHaveBeenCalled();
	});
});
