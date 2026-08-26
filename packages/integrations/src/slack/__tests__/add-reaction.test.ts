import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstTrigger = vi.fn();
const findFirstIntegration = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		agentDeploymentTrigger: {
			findFirst: (...args: unknown[]) => findFirstTrigger(...args),
		},
		workflowIntegration: {
			findFirst: (...args: unknown[]) => findFirstIntegration(...args),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
}));

import { addSlackReaction } from "../add-reaction";

describe("addSlackReaction", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		findFirstTrigger.mockReset();
		findFirstIntegration.mockReset();
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("posts to reactions.add with form-encoded body and bot token", async () => {
		findFirstTrigger.mockResolvedValue({
			deployment: { id: "dep-1" },
		});
		findFirstIntegration.mockResolvedValue({
			credentials: JSON.stringify({ access_token: "xoxb-test" }),
		});
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true }),
		});

		const result = await addSlackReaction({
			teamId: "T1",
			channel: "C1",
			timestamp: "1700000000.000100",
			name: "eyes",
			userId: "u1",
			organizationId: "o1",
		});

		expect(result).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ method: string; headers: Record<string, string>; body: string },
		];
		expect(url).toBe("https://slack.com/api/reactions.add");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer xoxb-test");
		expect(init.headers["Content-Type"]).toContain(
			"application/x-www-form-urlencoded",
		);
		const params = new URLSearchParams(init.body);
		expect(params.get("channel")).toBe("C1");
		expect(params.get("timestamp")).toBe("1700000000.000100");
		expect(params.get("name")).toBe("eyes");
	});

	it("returns error result when Slack responds with missing_scope", async () => {
		findFirstTrigger.mockResolvedValue({ deployment: { id: "dep-1" } });
		findFirstIntegration.mockResolvedValue({
			credentials: JSON.stringify({ access_token: "xoxb-stale" }),
		});
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ ok: false, error: "missing_scope" }),
		});

		const result = await addSlackReaction({
			teamId: "T1",
			channel: "C1",
			timestamp: "1700000000.000100",
			name: "eyes",
			userId: "u1",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toBe("missing_scope");
	});

	it("returns error result when no Slack integration exists for the team", async () => {
		findFirstTrigger.mockResolvedValue(null);

		const result = await addSlackReaction({
			teamId: "T1",
			channel: "C1",
			timestamp: "1700000000.000100",
			name: "x",
			userId: "u1",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("No Slack bot token found for team T1");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to apiKey when access_token is absent in credentials", async () => {
		findFirstTrigger.mockResolvedValue({ deployment: { id: "dep-1" } });
		findFirstIntegration.mockResolvedValue({
			credentials: JSON.stringify({ apiKey: "xoxb-legacy" }),
		});
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true }),
		});

		const result = await addSlackReaction({
			teamId: "T1",
			channel: "C1",
			timestamp: "1700000000.000100",
			name: "x",
			userId: "u1",
		});

		expect(result.ok).toBe(true);
		const [, init] = fetchMock.mock.calls[0] as [
			string,
			{ headers: Record<string, string> },
		];
		expect(init.headers.Authorization).toBe("Bearer xoxb-legacy");
	});
});
