/**
 * How the live Slack fetch reports a failed channel (Fizzy #3504).
 *
 * A token Slack refuses (`invalid_auth`, `token_revoked`, `account_inactive`)
 * belongs to the requesting user and fails every channel alike. It was logged
 * as an error once per channel per request, which the recurring-error scan
 * then filed as a worker fault, while the only remedy is that user
 * reconnecting Slack. It is now one warning per request that names the code
 * and the remedy. A channel the bot cannot read is a warning of its own, and
 * anything unclassified stays an error.
 */

import { SlackConfigurationError } from "@repo/integrations/slack";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLiveIntegrationContext } from "../live-integration-context";

const { findManyMock, executeSlackToolMock } = vi.hoisted(() => ({
	findManyMock: vi.fn(),
	executeSlackToolMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { projectContext: { findMany: findManyMock } },
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
	isMicrosoftAccessDeniedError: vi.fn(() => false),
}));

// The real classifier and error class, so the test exercises what Slack's
// client actually throws; only the network call is replaced.
vi.mock("@repo/integrations/slack", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/integrations/slack")>()),
	executeSlackTool: executeSlackToolMock,
}));

function slackChannel(channelId: string, channelName: string) {
	return {
		id: `ctx-${channelId}`,
		metadata: { provider: "SLACK", channelId, channelName },
		sourceType: null,
		aiInstructions: null,
	};
}

function slackFailure(code: string) {
	return new SlackConfigurationError(
		code,
		`Slack API conversations.history error: ${code} (params: channel,limit)`,
	);
}

const fetchOptions = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
};

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	findManyMock.mockReset();
	executeSlackToolMock.mockReset();
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	warn.mockRestore();
	error.mockRestore();
});

describe("a token Slack refuses", () => {
	it("is one warning per request, naming the code and the remedy", async () => {
		findManyMock.mockResolvedValue([
			slackChannel("C1", "general"),
			slackChannel("C2", "releases"),
			slackChannel("C3", "support"),
		]);
		executeSlackToolMock.mockRejectedValue(slackFailure("invalid_auth"));

		const result = await fetchLiveIntegrationContext(fetchOptions);

		expect(result.slackMessages).toEqual([]);
		expect(result.hasSlack).toBe(true);
		expect(error).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		const [line] = warn.mock.calls[0] as [string];
		expect(line).toContain("invalid_auth");
		expect(line).toContain("skipped 3 channel(s)");
		expect(line).toContain("reconnect Slack");
	});

	it.each(["token_revoked", "account_inactive"])(
		"treats %s the same way",
		async (code) => {
			findManyMock.mockResolvedValue([slackChannel("C1", "general")]);
			executeSlackToolMock.mockRejectedValue(slackFailure(code));

			await fetchLiveIntegrationContext(fetchOptions);

			expect(error).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain(code);
		},
	);

	it("keeps messages from channels that did answer", async () => {
		findManyMock.mockResolvedValue([
			slackChannel("C1", "general"),
			slackChannel("C2", "releases"),
		]);
		executeSlackToolMock.mockImplementation(
			async (_method: string, args: { channelId: string }) => {
				if (args.channelId === "C2") {
					throw slackFailure("invalid_auth");
				}
				return {
					messages: [
						{
							id: "m1",
							content: "Shipped.",
							from: "Ana",
							createdAt: "2026-11-02T10:00:00Z",
						},
					],
					count: 1,
				};
			},
		);

		const result = await fetchLiveIntegrationContext(fetchOptions);

		expect(result.slackMessages.map((m) => m.id)).toEqual(["m1"]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("skipped 1 channel(s)");
	});
});

describe("a channel the bot cannot read", () => {
	it("is a warning for that channel, not an error", async () => {
		findManyMock.mockResolvedValue([slackChannel("C1", "general")]);
		executeSlackToolMock.mockRejectedValue(slackFailure("not_in_channel"));

		await fetchLiveIntegrationContext(fetchOptions);

		expect(error).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("general");
		expect(warn.mock.calls[0]?.[0]).toContain("not_in_channel");
	});
});

describe("an unclassified failure", () => {
	it("stays an error, so a real fault is still seen", async () => {
		findManyMock.mockResolvedValue([slackChannel("C1", "general")]);
		executeSlackToolMock.mockRejectedValue(
			new Error("Slack API conversations.history failed: 502"),
		);

		await fetchLiveIntegrationContext(fetchOptions);

		expect(warn).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]?.[1]).toContain("502");
	});
});
