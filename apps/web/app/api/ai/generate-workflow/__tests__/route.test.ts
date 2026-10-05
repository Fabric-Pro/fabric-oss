/**
 * `POST /api/ai/generate-workflow` binds the organization it runs in to the
 * caller before it resolves a model.
 *
 * The body carries an optional `organizationId`, and that id picks the tenant
 * whose AI provider (and provider key) serves the request and whose usage the
 * call is logged against. Taken on its own it would let a signed-in user run
 * on — and bill — an organization they have no tie to. The route now resolves
 * it through `resolveRequestedOrganization`, the same rule the direct-chat
 * stream uses: a named organization must be one the caller has a tie to, an
 * omitted one falls back to the session's active organization (tie-checked
 * too), and neither is a 403.
 *
 * It also writes no usage row of its own: the model `getAIModelWithMetadata`
 * returns records one `AiUsageLog` row per provider call (the usage-logging
 * middleware in `@repo/ai`), so a route row on top of it counted each call
 * twice (Fizzy #2913).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (args: unknown) => getSession(args) } },
}));

const hasOrganizationTie = vi.fn();
// Every AiUsageLog write attempt, whichever writer made it: the route's own,
// or the one row the resolved model's usage-logging middleware writes for each
// call. The `generateText` mock below stands in for that middleware row, so these
// tests prove the route adds no write of its own; that the resolver really
// wraps its models is a separate contract (Fizzy #2915).
const usageRows: unknown[] = [];
const recordUsageRow = async (row: unknown) => {
	usageRows.push(row);
};
vi.mock("@repo/database", () => ({
	hasOrganizationTie: (userId: string, organizationId: string) =>
		hasOrganizationTie(userId, organizationId),
	logAiUsage: recordUsageRow,
	logAiUsageAsync: recordUsageRow,
}));

const getAIModelWithMetadata = vi.fn();
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadata(...args),
}));

const generateText = vi.fn();
vi.mock("ai", () => ({
	generateText: (...args: unknown[]) => generateText(...args),
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
const MEMBER_ORG = "org-member";
const FOREIGN_ORG = "org-foreign";

function generate(body: Record<string, unknown>) {
	return POST(
		new Request("http://localhost/api/ai/generate-workflow", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}) as never,
	);
}

const PROMPT = "When a form is submitted, send a Slack message";

const RESOLVED_MODEL = { id: "stub-model" };

/** The model's own row for one provider call, as its middleware writes it. */
function recordModelCallRow(model: unknown, success: boolean) {
	if (model !== RESOLVED_MODEL) {
		throw new Error("generateText was not given the resolved model");
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
	hasOrganizationTie.mockImplementation(
		async (_userId: string, organizationId: string) =>
			organizationId === ACTIVE_ORG || organizationId === MEMBER_ORG,
	);
	getAIModelWithMetadata.mockResolvedValue({
		model: RESOLVED_MODEL,
		metadata: {
			modelString: "stub-model",
			provider: "OPENAI",
			canonicalName: "stub",
			billingMode: "external_byok",
		},
		trackUsage: () => {},
	});
	generateText.mockImplementation(async (options: { model: unknown }) => {
		recordModelCallRow(options.model, true);
		return {
			text: JSON.stringify({ action: "replace", nodes: [], edges: [] }),
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		};
	});
});

describe("POST /api/ai/generate-workflow — requested organization", () => {
	it("refuses an organization the caller has no tie to, before any model is resolved", async () => {
		const res = await generate({
			prompt: PROMPT,
			organizationId: FOREIGN_ORG,
		});

		expect(res.status).toBe(403);
		expect(hasOrganizationTie).toHaveBeenCalledWith(USER_ID, FOREIGN_ORG);
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(usageRows).toHaveLength(0);
	});

	it("serves an organization the caller belongs to, resolving the model there", async () => {
		const res = await generate({
			prompt: PROMPT,
			organizationId: MEMBER_ORG,
		});

		expect(res.status).toBe(200);
		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{ userId: USER_ID, organizationId: MEMBER_ORG },
		);
		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({ model: RESOLVED_MODEL }),
		);
	});

	it("falls back to the session's active organization when the body names none", async () => {
		const res = await generate({ prompt: PROMPT });

		expect(res.status).toBe(200);
		expect(hasOrganizationTie).toHaveBeenCalledWith(USER_ID, ACTIVE_ORG);
		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{ userId: USER_ID, organizationId: ACTIVE_ORG },
		);
	});

	it("refuses when the body names none and the session has no active organization", async () => {
		getSession.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: null },
		});

		const res = await generate({ prompt: PROMPT });

		expect(res.status).toBe(403);
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});
});

describe("POST /api/ai/generate-workflow — usage logging", () => {
	it("writes no usage row of its own beside the model's row for a successful call", async () => {
		const res = await generate({ prompt: PROMPT });

		expect(res.status).toBe(200);
		expect(usageRows).toEqual([{ source: "model", success: true }]);
	});

	it("writes no usage row of its own beside the model's row when the model call fails", async () => {
		generateText.mockImplementation(async (options: { model: unknown }) => {
			recordModelCallRow(options.model, false);
			throw new Error("provider unavailable");
		});

		const res = await generate({ prompt: PROMPT });

		expect(res.status).toBe(500);
		expect(usageRows).toEqual([{ source: "model", success: false }]);
	});

	it("resolves the model with per-call usage logging", async () => {
		await generate({ prompt: PROMPT });

		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			expect.not.objectContaining({ usageLogging: "aggregate" }),
			expect.anything(),
		);
	});
});
