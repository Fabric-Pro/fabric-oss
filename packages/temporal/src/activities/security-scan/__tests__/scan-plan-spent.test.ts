/**
 * An AI scanner when every shared ChatGPT plan runs out part-way (Fizzy
 * #2770): no chunk starts after the first refusal, the scanner fails with the
 * plan's own type carrying the items it scanned and their findings, and the
 * retry after the workflow's wait scans only the rest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/ai/limits", () => ({
	classifyLimitError: vi.fn(() => null),
}));

vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: vi.fn(async () => null),
	getProjectScanContent: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/activity")>()),
	heartbeat: vi.fn(),
}));

vi.mock("../emit-scan-notification", () => ({
	emitScanNotification: vi.fn(),
}));

import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { ApplicationFailure } from "@temporalio/activity";
import { runSecurityScanActivity, type ScanProgress } from "../scan-activities";

// Each item is over the chunk budget, so each is its own chunk.
const item = (key: string) => ({
	key,
	label: key,
	text: `${key} `.repeat(8_000),
});

const INPUT = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
	projectName: "Example project",
	items: ["A", "B", "C"].map(item),
	customRules: [],
};

/** The item a chunk call scans, from its prompt. */
function itemOf(call: unknown): string {
	const prompt = (call as { prompt: string }).prompt;
	return /\b([ABC]) /.exec(prompt)?.[1] ?? "?";
}

const finding = (title: string) => ({
	title,
	severity: "MEDIUM",
	description: "Description",
	remediation: "Remediation",
	ruleSource: "rule",
	isCustomRule: false,
	location: null,
});

let spentFor: Set<string>;

beforeEach(() => {
	vi.clearAllMocks();
	spentFor = new Set();
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "model", provider: "OPENAI_CHATGPT_PLAN" },
		trackUsage: vi.fn(),
	});
	mocks.generateObject.mockImplementation(async (call: unknown) => {
		const key = itemOf(call);
		if (spentFor.has(key)) {
			throw new SubscriptionPlanExhaustedError("No usage left.", null);
		}
		return {
			object: { findings: [finding(`Finding in ${key}`)] },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
	});
});

describe("runSecurityScanActivity — every shared plan spent part-way", () => {
	it("fails with the plan's type, carrying the items it scanned and their findings", async () => {
		spentFor.add("B");

		const failure = await runSecurityScanActivity(INPUT).then(
			() => null,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(ApplicationFailure);
		const appFailure = failure as ApplicationFailure;
		expect(appFailure.type).toBe("SubscriptionPlanExhaustedError");
		expect(appFailure.nonRetryable).toBe(true);
		const progress = appFailure.details?.[0] as ScanProgress;
		expect([...progress.doneItemKeys].sort()).toEqual(["A", "C"]);
		expect(progress.findings.map((f) => f.title).sort()).toEqual([
			"Finding in A",
			"Finding in C",
		]);
		// The refused chunk is not retried inside the attempt.
		expect(
			mocks.generateObject.mock.calls.filter(
				([call]) => itemOf(call) === "B",
			),
		).toHaveLength(1);
	});

	it("scans only the rest on the retry and returns every finding", async () => {
		const resume: ScanProgress = {
			doneItemKeys: ["A", "C"],
			findings: [],
			inputTokens: 20,
			outputTokens: 10,
		};
		resume.findings = (
			await runSecurityScanActivity({
				...INPUT,
				items: [item("A"), item("C")],
			})
		).findings;
		mocks.generateObject.mockClear();

		const output = await runSecurityScanActivity({ ...INPUT, resume });

		expect(
			mocks.generateObject.mock.calls.map(([call]) => itemOf(call)),
		).toEqual(["B"]);
		expect(output.findings.map((f) => f.title).sort()).toEqual([
			"Finding in A",
			"Finding in B",
			"Finding in C",
		]);
		expect(output.inputTokens).toBe(30);
	});

	it("fails as before, without progress, when model resolution finds every plan spent", async () => {
		const spent = new SubscriptionPlanExhaustedError(
			"No usage left.",
			null,
		);
		mocks.getAIModelWithMetadata.mockRejectedValue(spent);

		await expect(runSecurityScanActivity(INPUT)).rejects.toBe(spent);
	});
});
