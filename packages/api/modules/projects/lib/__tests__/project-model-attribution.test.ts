import type { FeatureMaturationState } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	generateObject: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	generateObject: mocks.generateObject,
	boundAcceptanceCriteria: (value: string) => value,
}));
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: vi.fn().mockResolvedValue(""),
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
}));

import { analyseTestFailure } from "../analyse-test-failure";
import { generateQaAnalysis } from "../generate-qa-analysis";

const tenant = { userId: "example-user", organizationId: "example-org" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAIModelWithMetadata.mockResolvedValue({ model: {}, metadata: {} });
	mocks.getBoundPromptForAgent.mockResolvedValue({
		version: { content: "Analyze the supplied evidence." },
	});
});

describe("project attribution at model resolution", () => {
	it("attributes test-failure analysis to the finding's project", async () => {
		mocks.generateObject.mockResolvedValue({
			object: { suspectedCause: "Expired token", kind: "PRODUCT_BUG" },
		});
		await analyseTestFailure({
			projectId: "example-project",
			tenant,
			failure: {
				testName: "rejects an expired token",
				occurrences: 1,
				firstSeenAt: new Date("2026-01-01T00:00:00Z"),
				lastSeenAt: new Date("2026-01-01T00:00:00Z"),
			},
		});
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{ ...tenant, projectId: "example-project" },
		);
	});

	it("attributes QA analysis to the loaded feature's project", async () => {
		mocks.generateObject.mockResolvedValue({ object: { warnings: [] } });
		await generateQaAnalysis({
			feature: {
				id: "example-story",
				projectId: "example-project",
				description: "Reject expired authentication tokens.",
				acceptanceCriteria: null,
			} as FeatureMaturationState,
			tenantFilter: tenant,
			depth: "LIGHT",
		});
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{ ...tenant, projectId: "example-project" },
		);
	});
});
