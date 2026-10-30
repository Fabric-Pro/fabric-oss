/**
 * `sendSlackMessage` posts with the bot token of the user's Slack connection,
 * and uses an organization's connection only while the user is a member of
 * that organization, as `getSlackCredentials` does. A refusal is returned as
 * a failed result, as a missing token is, so the trigger activity that posts
 * replies logs it rather than retrying.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { canUseWorkflowIntegrations, findFirstTrigger, findFirstIntegration } =
	vi.hoisted(() => ({
		canUseWorkflowIntegrations: vi.fn(),
		findFirstTrigger: vi.fn(),
		findFirstIntegration: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	canUseWorkflowIntegrations,
	db: {
		agentDeploymentTrigger: { findFirst: findFirstTrigger },
		workflowIntegration: { findFirst: findFirstIntegration },
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value,
}));

import { sendSlackMessage } from "../send-message";

const NO_TOKEN =
	"No Slack bot token found for team T-example. Connect Slack in Settings > Integrations.";

const message = {
	teamId: "T-example",
	channel: "C-example",
	text: "Done.",
	threadTs: "1700000000.000100",
	userId: "user-example-1",
};

describe("sendSlackMessage", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		canUseWorkflowIntegrations.mockResolvedValue(true);
		findFirstTrigger.mockResolvedValue({ deployment: { id: "dep-1" } });
		findFirstIntegration.mockResolvedValue({
			credentials: JSON.stringify({ access_token: "xoxb-test" }),
		});
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, ts: "1700000000.000200" }),
		});
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("refuses a user who is not a member of the organization, without reading a token or calling Slack", async () => {
		canUseWorkflowIntegrations.mockResolvedValue(false);

		const result = await sendSlackMessage({
			...message,
			organizationId: "org-example-1",
		});

		expect(result).toEqual({ ok: false, error: NO_TOKEN });
		expect(canUseWorkflowIntegrations).toHaveBeenCalledWith(
			"user-example-1",
			"org-example-1",
		);
		expect(findFirstTrigger).not.toHaveBeenCalled();
		expect(findFirstIntegration).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("posts with a member's organization connection", async () => {
		const result = await sendSlackMessage({
			...message,
			organizationId: "org-example-1",
		});

		expect(result).toEqual({ ok: true, messageTs: "1700000000.000200" });
		expect(findFirstIntegration).toHaveBeenCalledWith({
			where: expect.objectContaining({
				userId: "user-example-1",
				organizationId: "org-example-1",
				provider: "SLACK",
			}),
		});
		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ headers: Record<string, string>; body: string },
		];
		expect(url).toBe("https://slack.com/api/chat.postMessage");
		expect(init.headers.Authorization).toBe("Bearer xoxb-test");
		expect(JSON.parse(init.body)).toEqual({
			channel: "C-example",
			text: "Done.",
			thread_ts: "1700000000.000100",
		});
	});

	it("reads a personal connection when no organization is named", async () => {
		const result = await sendSlackMessage(message);

		expect(result.ok).toBe(true);
		expect(canUseWorkflowIntegrations).toHaveBeenCalledWith(
			"user-example-1",
			undefined,
		);
		expect(findFirstIntegration).toHaveBeenCalledWith({
			where: expect.objectContaining({
				userId: "user-example-1",
				organizationId: null,
			}),
		});
	});

	it("returns a failed result when the membership check itself fails", async () => {
		canUseWorkflowIntegrations.mockRejectedValue(new Error("db down"));

		const result = await sendSlackMessage({
			...message,
			organizationId: "org-example-1",
		});

		expect(result).toEqual({ ok: false, error: "db down" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
