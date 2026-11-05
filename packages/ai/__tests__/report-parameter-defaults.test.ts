import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	structured: vi.fn(),
	plainText: vi.fn(),
	model: vi.fn(),
	logUsage: vi.fn(),
	boundPrompt: vi.fn(),
	trackUsage: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	generateText: (args: { output?: unknown }) =>
		args.output ? m.structured(args) : m.plainText(args),
}));
vi.mock("../lib/dynamic-model-selector", async () => ({
	...(await vi.importActual<typeof import("../lib/dynamic-model-selector")>(
		"../lib/dynamic-model-selector",
	)),
	getAIModelWithMetadata: (...args: unknown[]) => m.model(...args),
}));
vi.mock("../lib/usage-logging", () => ({
	logModelUsageAsync: (...args: unknown[]) => m.logUsage(...args),
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	getBoundPromptForAgent: (...args: unknown[]) => m.boundPrompt(...args),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AIProviderNotConfiguredError } from "../lib/dynamic-model-selector";
import { generateReportParameterDefaults } from "../lib/report-parameter-defaults";

const request = {
	parameters: [
		{ key: "audience", description: "Who reads the report" },
		{ key: "focus" },
	],
	project: { name: "Example Project", description: "An example" },
	template: { name: "Example status", description: null },
	context: {
		userId: "example-user",
		organizationId: "example-org",
		projectId: "example-project",
	},
};

function answer(values: Array<{ key: string; value: string }>) {
	return {
		output: { values },
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.boundPrompt.mockResolvedValue(null);
	m.model.mockResolvedValue({
		model: "example-model",
		metadata: { provider: "example", modelId: "example-model" },
		trackUsage: m.trackUsage,
	});
	m.structured.mockResolvedValue(
		answer([{ key: "audience", value: "Delivery team" }]),
	);
});

describe("generateReportParameterDefaults", () => {
	it("returns the values it was asked for, on the simple model", async () => {
		await expect(generateReportParameterDefaults(request)).resolves.toEqual(
			{ audience: "Delivery team" },
		);

		expect(m.model).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			expect.objectContaining({
				featureKey: "report-parameter-defaults",
				userId: "example-user",
			}),
		);
		expect(m.trackUsage).toHaveBeenCalled();
		expect(m.logUsage).toHaveBeenCalled();
	});

	it("asks from the project's name and description with the fallback prompt", async () => {
		await generateReportParameterDefaults(request);

		const prompt = m.structured.mock.calls[0][0].prompt;
		expect(prompt).toContain("Example Project");
		expect(prompt).toContain("An example");
		expect(prompt).toContain("audience: Who reads the report");
	});

	it("uses the Prompt Library's body when one is bound", async () => {
		m.boundPrompt.mockResolvedValue({
			format: "HANDLEBARS",
			version: { content: "Library body for {{project_name}}" },
		});

		await generateReportParameterDefaults(request);

		expect(m.structured.mock.calls[0][0].prompt).toBe(
			"Library body for Example Project",
		);
	});

	it("keeps only requested keys and usable text", async () => {
		m.structured.mockResolvedValue(
			answer([
				{ key: "audience", value: "  Delivery team  " },
				{ key: "focus", value: "{{focus}}" },
				{ key: "invented", value: "Not asked for" },
			]),
		);

		await expect(generateReportParameterDefaults(request)).resolves.toEqual(
			{ audience: "Delivery team" },
		);
	});

	it("reads a plain-text answer when structured output fails", async () => {
		m.structured.mockRejectedValue(new Error("Example unsupported"));
		m.plainText.mockResolvedValue({
			text: 'Here: {"values":[{"key":"focus","value":"Delivery"}]}',
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});

		await expect(generateReportParameterDefaults(request)).resolves.toEqual(
			{ focus: "Delivery" },
		);
	});

	it("returns nothing and does not throw when generation fails", async () => {
		m.structured.mockRejectedValue(new Error("Example outage"));
		m.plainText.mockRejectedValue(new Error("Example outage"));

		await expect(generateReportParameterDefaults(request)).resolves.toEqual(
			{},
		);
	});

	it("returns nothing and does not throw without an AI provider", async () => {
		m.model.mockRejectedValue(
			new AIProviderNotConfiguredError("example-org"),
		);

		await expect(generateReportParameterDefaults(request)).resolves.toEqual(
			{},
		);
		expect(m.structured).not.toHaveBeenCalled();
	});

	it("returns nothing when the prompt lookup fails", async () => {
		m.boundPrompt.mockRejectedValue(new Error("Example database outage"));

		await expect(generateReportParameterDefaults(request)).resolves.toEqual(
			{},
		);
	});

	it("asks nothing when nothing is fillable or the project has no name", async () => {
		await expect(
			generateReportParameterDefaults({ ...request, parameters: [] }),
		).resolves.toEqual({});
		await expect(
			generateReportParameterDefaults({
				...request,
				project: { name: "  " },
			}),
		).resolves.toEqual({});
		expect(m.model).not.toHaveBeenCalled();
	});
});
