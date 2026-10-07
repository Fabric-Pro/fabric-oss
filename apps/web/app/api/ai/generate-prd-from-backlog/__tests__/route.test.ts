/**
 * `POST /api/ai/generate-prd-from-backlog` writes no usage row of its own.
 *
 * The model `getAIModelWithMetadata` returns records one `AiUsageLog` row per
 * provider call (the usage-logging middleware in `@repo/ai`), so a route row
 * on top of it counted each call twice in usage reports, estimated cost and
 * the token and cost usage limits (Fizzy #2913).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (args: unknown) => getSession(args) } },
}));

// Every AiUsageLog write attempt, whichever writer made it: the route's own,
// or the one row the resolved model's usage-logging middleware writes for each
// call. The `streamText` mock below stands in for that middleware row, so these
// tests prove the route adds no write of its own; that the resolver really
// wraps its models is a separate contract (Fizzy #2915).
const usageRows: unknown[] = [];
const recordUsageRow = async (row: unknown) => {
	usageRows.push(row);
};
vi.mock("@repo/database", () => ({
	logAiUsage: recordUsageRow,
	logAiUsageAsync: recordUsageRow,
}));

const getAIModelWithMetadata = vi.fn();
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadata(...args),
}));

vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeMaxOutputTokenBudget: () => undefined,
}));

const streamText = vi.fn();
vi.mock("ai", () => ({
	streamText: (...args: unknown[]) => streamText(...args),
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// `after` needs a live request scope; run the callback inline so any usage
// row deferred through it is counted.
vi.mock("next/server", () => ({
	after: (fn: () => unknown) => {
		fn();
	},
}));

const { POST } = await import("../route");

const USER_ID = "user-1";
const ACTIVE_ORG = "org-active";
const RESOLVED_MODEL = { id: "stub-model" };

function generate() {
	return POST(
		new Request("http://localhost/api/ai/generate-prd-from-backlog", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectName: "Example project",
				sections: [
					{
						source: "backlog",
						label: "Backlog",
						priority: 1,
						highSignal: true,
						content: { totalCount: 3 },
					},
				],
				hasBacklog: true,
				hasCodebase: false,
				hasWebsite: false,
			}),
		}) as never,
	);
}

/** The model's own row for one provider call, as its middleware writes it. */
function recordModelCallRow(model: unknown, success: boolean) {
	if (model !== RESOLVED_MODEL) {
		throw new Error("streamText was not given the resolved model");
	}
	usageRows.push({ source: "model", success });
}

beforeEach(() => {
	vi.clearAllMocks();
	usageRows.length = 0;
	getSession.mockResolvedValue({
		user: { id: USER_ID },
		session: { activeOrganizationId: ACTIVE_ORG },
	});
	getAIModelWithMetadata.mockResolvedValue({
		model: RESOLVED_MODEL,
		metadata: {
			modelString: "stub-model",
			provider: "OPENAI_DIRECT",
			canonicalName: "stub",
			billingMode: "external_provider",
		},
		trackUsage: () => {},
	});
	streamText.mockImplementation((options: { model: unknown }) => {
		recordModelCallRow(options.model, true);
		return {
			textStream: (async function* () {
				yield "# PRD";
			})(),
			usage: Promise.resolve({
				inputTokens: 1,
				outputTokens: 1,
				totalTokens: 2,
			}),
			finishReason: Promise.resolve("stop"),
		};
	});
});

describe("POST /api/ai/generate-prd-from-backlog — usage logging", () => {
	it("writes no usage row of its own beside the model's row for a successful call", async () => {
		const res = await generate();

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ text: "# PRD" });
		expect(usageRows).toEqual([{ source: "model", success: true }]);
	});

	it("writes no usage row of its own beside the model's row when the model call fails", async () => {
		// The provider fails mid-stream, as the route reads the text.
		streamText.mockImplementation((options: { model: unknown }) => {
			recordModelCallRow(options.model, false);
			return {
				textStream: (async function* () {
					yield "partial";
					throw new Error("provider unavailable");
				})(),
				usage: new Promise(() => {}),
				finishReason: new Promise(() => {}),
			};
		});

		const res = await generate();

		expect(res.status).toBe(500);
		expect(usageRows).toEqual([{ source: "model", success: false }]);
	});

	it("resolves the model for the session's organization with per-call usage logging", async () => {
		await generate();

		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			expect.not.objectContaining({ usageLogging: "aggregate" }),
			{ userId: USER_ID, organizationId: ACTIVE_ORG, planEligible: true },
		);
	});
});
