/**
 * Provider-agnostic prompt-caching wiring for the AI scanners.
 *
 * Asserts that `runScan` sends the fixed guidance as a cacheable `system`
 * prefix (carrying the additive Anthropic `cacheControl` marker) and only the
 * per-chunk <document> block as the user `prompt`, while preserving the
 * `maxRetries: 0` + `abortSignal` timeout. The Anthropic marker is attached
 * UNCONDITIONALLY (no branch on provider) — that is what keeps it
 * provider-agnostic: non-Anthropic providers ignore the `anthropic` namespace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		logModelUsageAsync: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		heartbeat: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@repo/ai/limits", () => ({
	classifyLimitError: vi.fn(() => ({ isLimit: false })),
}));

vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: mocks.heartbeat,
}));

// Heavy transitive deps not exercised by runScan — stub so importing the
// activity module doesn't pull the real Prisma client / workflow runtime.
vi.mock("../emit-scan-notification", () => ({
	emitScanNotification: vi.fn(),
}));

vi.mock("../../../workflows/scan-failure-hint", () => ({
	describeScanFailureReason: vi.fn(() => ""),
}));

import type { ScanContentItem } from "@repo/database";
import {
	runAccessibilityScanActivity,
	runSecurityScanActivity,
} from "../scan-activities";

const CHUNK_TEXT =
	"The importer fetches a user-supplied URL server-side with no allow-list.";

const ITEMS: ScanContentItem[] = [
	{ key: "F-1", label: "Feature F-1", text: CHUNK_TEXT },
];

function makeAIModelMock() {
	return {
		model: { id: "test-model" } as unknown as object,
		metadata: {
			modelString: "openai/gpt-5",
			provider: "OPENAI_DIRECT",
			selectionSource: "test-fixture",
		},
		trackUsage: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAIModelWithMetadata.mockResolvedValue(makeAIModelMock());
	mocks.getBoundPromptForAgent.mockResolvedValue(null); // → in-code default guidance
	mocks.generateObject.mockResolvedValue({
		object: { findings: [] },
		usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
	});
});

describe("runScan — provider-agnostic prompt caching", () => {
	it("sends fixed guidance as a cacheable system prefix and only the content in the user prompt (security)", async () => {
		await runSecurityScanActivity({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			projectName: "Acme",
			items: ITEMS,
			customRules: [],
		});

		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
		const call = mocks.generateObject.mock.calls[0]?.[0];

		// System prompt (the cacheable prefix) carries the FIXED guidance...
		expect(call.system.role).toBe("system");
		expect(call.system.content).toContain("A03 Injection");
		expect(call.system.content).toContain("SILENCE IS NEVER A DEFECT");
		// ...but NOT the per-chunk content (that would defeat caching).
		expect(call.system.content).not.toContain(CHUNK_TEXT);

		// The user prompt carries ONLY the <document> block + a short instruction.
		expect(call.prompt).toContain(CHUNK_TEXT);
		expect(call.prompt).toContain(
			"Analyze the content in the document above.",
		);
		expect(call.prompt).not.toContain("A03 Injection");
	});

	it("attaches the provider-agnostic Anthropic cacheControl marker on the system message", async () => {
		await runSecurityScanActivity({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			projectName: "Acme",
			items: ITEMS,
			customRules: [],
		});

		const call = mocks.generateObject.mock.calls[0]?.[0];
		// The additive Anthropic cache breakpoint. Non-Anthropic providers ignore
		// the `anthropic` namespace, so this is safe to always attach (here the
		// resolved model is OPENAI_DIRECT and the call is unchanged for it).
		expect(call.system.providerOptions).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
	});

	it("keeps maxRetries:0 and the per-chunk abortSignal timeout intact", async () => {
		await runSecurityScanActivity({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			projectName: "Acme",
			items: ITEMS,
			customRules: [],
		});

		const call = mocks.generateObject.mock.calls[0]?.[0];
		expect(call.maxRetries).toBe(0);
		expect(call.abortSignal).toBeInstanceOf(AbortSignal);
		// Must NOT pass the old combined `prompt`-only shape (no system message).
		expect(typeof call.system).toBe("object");
	});

	it("uses WCAG guidance for the accessibility scanner but the SAME cache marker", async () => {
		await runAccessibilityScanActivity({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			projectName: "Acme",
			items: ITEMS,
			customRules: [],
		});

		const call = mocks.generateObject.mock.calls[0]?.[0];
		expect(call.system.content).toContain("WCAG 2.1 Level AA");
		expect(call.system.content).not.toContain("A03 Injection");
		expect(call.system.providerOptions).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
		expect(call.prompt).toContain(CHUNK_TEXT);
	});
});
