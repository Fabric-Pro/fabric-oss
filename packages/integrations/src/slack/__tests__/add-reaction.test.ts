import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstTrigger = vi.fn();
const findFirstIntegration = vi.fn();
const updateIntegration = vi.fn();
const canUseWorkflowIntegrations = vi.fn();

vi.mock("@repo/database", () => ({
	canUseWorkflowIntegrations: (...args: unknown[]) =>
		canUseWorkflowIntegrations(...args),
	db: {
		agentDeploymentTrigger: {
			findFirst: (...args: unknown[]) => findFirstTrigger(...args),
		},
		workflowIntegration: {
			findFirst: (...args: unknown[]) => findFirstIntegration(...args),
			updateMany: (...args: unknown[]) => updateIntegration(...args),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => `encrypted:${v}`,
}));

import { addSlackReaction } from "../add-reaction";

describe("addSlackReaction", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		findFirstTrigger.mockReset();
		findFirstIntegration.mockReset();
		updateIntegration.mockReset().mockResolvedValue({ count: 1 });
		canUseWorkflowIntegrations.mockReset().mockResolvedValue(true);
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
			credentials: JSON.stringify({
				access_token: "xoxb-test",
				team_id: "T1",
			}),
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
			credentials: JSON.stringify({
				access_token: "xoxb-stale",
				team_id: "T1",
			}),
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

	it("reacts with a legacy connection after verifying and storing its team", async () => {
		findFirstTrigger.mockResolvedValue({ deployment: { id: "dep-1" } });
		findFirstIntegration.mockResolvedValue({
			id: "connection-example",
			userId: "u1",
			organizationId: "o1",
			credentials: JSON.stringify({ access_token: "xoxb-test" }),
		});
		fetchMock
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true, team_id: "T1" }),
			})
			.mockResolvedValueOnce({
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
		expect(result.ok).toBe(true);
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			"https://slack.com/api/auth.test",
			"https://slack.com/api/reactions.add",
		]);
		expect(updateIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "connection-example",
					credentials: '{"access_token":"xoxb-test"}',
				},
			}),
		);
	});

	it("refuses a legacy connection when auth.test returns no team", async () => {
		findFirstTrigger.mockResolvedValue({ deployment: { id: "dep-1" } });
		findFirstIntegration.mockResolvedValue({
			id: "connection-example",
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
		expect(result.ok).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://slack.com/api/auth.test",
		);
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

	it("refuses a trigger whose connection belongs to a different team", async () => {
		findFirstTrigger.mockResolvedValue({ deployment: { id: "dep-1" } });
		findFirstIntegration.mockResolvedValue({
			credentials: JSON.stringify({
				access_token: "xoxb-test",
				team_id: "T0OTHER",
			}),
		});
		const result = await addSlackReaction({
			teamId: "T1",
			channel: "C1",
			timestamp: "1700000000.000100",
			name: "eyes",
			userId: "u1",
			organizationId: "o1",
		});
		expect(result.ok).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses malformed team and channel IDs before calling Slack", async () => {
		findFirstTrigger.mockResolvedValue({ deployment: { id: "dep-1" } });
		findFirstIntegration.mockResolvedValue({
			credentials: JSON.stringify({
				access_token: "xoxb-test",
				team_id: "T1",
			}),
		});
		for (const ids of [
			{ teamId: "T1.*", channel: "C1" },
			{ teamId: "T1", channel: "C1.*" },
		]) {
			const result = await addSlackReaction({
				...ids,
				timestamp: "1700000000.000100",
				name: "eyes",
				userId: "u1",
			});
			expect(result.ok).toBe(false);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to apiKey when access_token is absent in credentials", async () => {
		findFirstTrigger.mockResolvedValue({ deployment: { id: "dep-1" } });
		findFirstIntegration.mockResolvedValue({
			credentials: JSON.stringify({
				apiKey: "xoxb-legacy",
				team_id: "T1",
			}),
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

	it("refuses a user who is not a member of the organization, without reading a token or calling Slack", async () => {
		canUseWorkflowIntegrations.mockResolvedValue(false);
		findFirstTrigger.mockResolvedValue({ deployment: { id: "dep-1" } });
		findFirstIntegration.mockResolvedValue({
			credentials: JSON.stringify({ access_token: "xoxb-test" }),
		});

		const result = await addSlackReaction({
			teamId: "T1",
			channel: "C1",
			timestamp: "1700000000.000100",
			name: "eyes",
			userId: "u1",
			organizationId: "o1",
		});

		expect(result).toEqual({
			ok: false,
			error: "No Slack bot token found for team T1. Connect Slack in Settings > Integrations.",
		});
		expect(canUseWorkflowIntegrations).toHaveBeenCalledWith("u1", "o1");
		expect(findFirstTrigger).not.toHaveBeenCalled();
		expect(findFirstIntegration).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reads a personal connection when no organization is named", async () => {
		findFirstTrigger.mockResolvedValue({ deployment: { id: "dep-1" } });
		findFirstIntegration.mockResolvedValue({
			credentials: JSON.stringify({
				access_token: "xoxb-personal",
				team_id: "T1",
			}),
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
		});

		expect(result).toEqual({ ok: true });
		expect(canUseWorkflowIntegrations).toHaveBeenCalledWith(
			"u1",
			undefined,
		);
		expect(findFirstIntegration).toHaveBeenCalledWith({
			where: expect.objectContaining({
				userId: "u1",
				organizationId: null,
			}),
		});
	});
});
