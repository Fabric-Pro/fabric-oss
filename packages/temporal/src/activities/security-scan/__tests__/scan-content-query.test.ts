/**
 * The AI scanners load their items from the gather's content query (Fizzy #2502).
 *
 * The gathered item text used to travel through Temporal as the gather result
 * and as both scanners' inputs; a large project's 200 items (2.34 MB) exceeded
 * the 2 MB payload limit and failed every scan. Each scanner now re-runs the
 * gather's `getProjectScanContent` call itself, with the same arguments.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		getProjectScanContent: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/ai/limits", () => ({
	classifyLimitError: vi.fn(() => ({ isLimit: false })),
}));

vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: vi.fn(async () => null),
	getProjectScanContent: mocks.getProjectScanContent,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

vi.mock("../emit-scan-notification", () => ({
	emitScanNotification: vi.fn(),
}));

vi.mock("../../../workflows/scan-failure-hint", () => ({
	describeScanFailureReason: vi.fn(() => ""),
}));

import { runSecurityScanActivity } from "../scan-activities";

const LOADED_TEXT =
	"The importer fetches a user-supplied URL with no allow-list.";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {
			modelString: "openai/gpt-5",
			provider: "OPENAI_DIRECT",
			selectionSource: "test-fixture",
		},
		trackUsage: vi.fn(),
	});
	mocks.generateObject.mockResolvedValue({
		object: { findings: [] },
		usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
	});
	mocks.getProjectScanContent.mockResolvedValue({
		projectName: "Acme",
		items: [{ key: "F-1", label: "Feature F-1", text: LOADED_TEXT }],
		itemCount: 1,
		scannedItemKeys: ["F-1"],
		truncatedItemCount: 0,
	});
});

describe("runSecurityScanActivity content loading", () => {
	it("loads the items with the gather's query, including its incremental window", async () => {
		await runSecurityScanActivity({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			projectName: "Acme",
			contentQuery: {
				projectId: "project-1",
				storyId: null,
				targetType: "PROJECT",
				mode: "INCREMENTAL",
				sinceCompletedAt: "2026-09-12T03:35:00.000Z",
			},
			customRules: [],
		});

		expect(mocks.getProjectScanContent).toHaveBeenCalledWith("project-1", {
			storyId: null,
			targetType: "PROJECT",
			mode: "INCREMENTAL",
			sinceCompletedAt: new Date("2026-09-12T03:35:00.000Z"),
		});
		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
		expect(mocks.generateObject.mock.calls[0]?.[0].prompt).toContain(
			LOADED_TEXT,
		);
	});

	it("scans items handed over directly without reading the database", async () => {
		await runSecurityScanActivity({
			projectId: "project-1",
			userId: "user-1",
			projectName: "Acme",
			items: [{ key: "F-2", label: "Feature F-2", text: "Inline item" }],
			customRules: [],
		});

		expect(mocks.getProjectScanContent).not.toHaveBeenCalled();
		expect(mocks.generateObject.mock.calls[0]?.[0].prompt).toContain(
			"Inline item",
		);
	});
});
