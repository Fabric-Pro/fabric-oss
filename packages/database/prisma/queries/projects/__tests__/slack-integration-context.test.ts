/**
 * The Slack channel's pointer row — the parent conversation capture hangs
 * bundles off (Fizzy #2228).
 *
 * The load-bearing assertion in here is the one about IDENTITY. Slack rows
 * written by the Add-Context dialog and the project wizard carry no workspace
 * id, so a matcher keyed on `(slackTeamId, channelId)` would fail to recognize
 * every row those two writers created and add a second context beside each one.
 * `channelId` alone is the key, and the duplicate-suppression test below is
 * what stops that regression coming back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	findMany: vi.fn(),
	createContext: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: { projectContext: { findMany: m.findMany } },
}));

vi.mock("../contexts", () => ({ createContext: m.createContext }));

import {
	buildSlackChannelContextMetadata,
	ensureSlackChannelIntegrationContext,
	slackChannelContextMatches,
} from "../slack-integration-context";

beforeEach(() => {
	vi.clearAllMocks();
	m.findMany.mockResolvedValue([]);
	m.createContext.mockResolvedValue({ id: "ctx_new" });
});

describe("buildSlackChannelContextMetadata", () => {
	it("writes the shape the Add-Context dialog already writes", () => {
		expect(
			buildSlackChannelContextMetadata({
				channelId: "C1",
				channelName: "engineering",
			}),
		).toMatchObject({
			provider: "SLACK",
			channelId: "C1",
			channelName: "engineering",
			title: "#engineering",
		});
	});

	it("omits absent keys instead of writing undefined", () => {
		const meta = buildSlackChannelContextMetadata({ channelId: "C1" });
		expect("channelName" in meta).toBe(false);
		expect("slackTeamId" in meta).toBe(false);
		expect("teamName" in meta).toBe(false);
		expect(meta.title).toBe("Slack channel");
	});

	it("carries the workspace id as enrichment when the caller knows it", () => {
		expect(
			buildSlackChannelContextMetadata({
				channelId: "C1",
				channelName: "engineering",
				slackTeamId: "T1",
				teamName: "Example Workspace",
				channelWebUrl: "https://example.slack.com/archives/C1",
			}),
		).toMatchObject({
			slackTeamId: "T1",
			teamName: "Example Workspace",
			channelWebUrl: "https://example.slack.com/archives/C1",
		});
	});
});

describe("slackChannelContextMatches", () => {
	it("matches on channelId alone, so a row with no workspace id is recognized", () => {
		// Exactly what the Add-Context dialog writes — no slackTeamId anywhere.
		expect(
			slackChannelContextMatches(
				{ provider: "SLACK", channelId: "C1", channelName: "eng" },
				{ channelId: "C1" },
			),
		).toBe(true);
	});

	it("does not match another channel, another provider, or a non-object", () => {
		expect(
			slackChannelContextMatches(
				{ provider: "SLACK", channelId: "C2" },
				{ channelId: "C1" },
			),
		).toBe(false);
		expect(
			slackChannelContextMatches(
				{ provider: "MICROSOFT_TEAMS", channelId: "C1" },
				{ channelId: "C1" },
			),
		).toBe(false);
		expect(slackChannelContextMatches(null, { channelId: "C1" })).toBe(
			false,
		);
		expect(slackChannelContextMatches(["C1"], { channelId: "C1" })).toBe(
			false,
		);
	});
});

describe("ensureSlackChannelIntegrationContext", () => {
	it("creates the pointer row when the channel has none", async () => {
		const result = await ensureSlackChannelIntegrationContext({
			projectId: "proj_1",
			channelId: "C1",
			channelName: "engineering",
			slackTeamId: "T1",
			userId: "user_1",
			organizationId: "org_1",
		});

		expect(result).toEqual({ created: true, contextId: "ctx_new" });
		expect(m.createContext).toHaveBeenCalledTimes(1);
		expect(m.createContext).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj_1",
				type: "INTEGRATION",
				content: "",
				// COMPLETED, not PENDING: the pointer row is not waiting on an
				// extraction, and a PENDING one would sit on a "Pending" pill
				// forever.
				extractionStatus: "COMPLETED",
				userId: "user_1",
				organizationId: "org_1",
				metadata: expect.objectContaining({
					provider: "SLACK",
					channelId: "C1",
				}),
			}),
		);
	});

	it("does NOT duplicate on a second link of the same channel", async () => {
		m.findMany.mockResolvedValue([
			{
				id: "ctx_existing",
				metadata: { provider: "SLACK", channelId: "C1" },
			},
		]);

		const result = await ensureSlackChannelIntegrationContext({
			projectId: "proj_1",
			channelId: "C1",
			channelName: "engineering",
			slackTeamId: "T1",
			userId: "user_1",
			organizationId: "org_1",
		});

		expect(result).toEqual({ created: false, contextId: "ctx_existing" });
		expect(m.createContext).not.toHaveBeenCalled();
	});

	it("reuses a row written WITHOUT a workspace id, rather than adding a second", async () => {
		// The Add-Context / wizard shape. This is the duplicate the identity
		// choice exists to prevent.
		m.findMany.mockResolvedValue([
			{
				id: "ctx_from_add_context",
				metadata: {
					provider: "SLACK",
					channelId: "C1",
					channelName: "engineering",
				},
			},
		]);

		const result = await ensureSlackChannelIntegrationContext({
			projectId: "proj_1",
			channelId: "C1",
			slackTeamId: "T1",
			userId: "user_1",
			organizationId: "org_1",
		});

		expect(result).toEqual({
			created: false,
			contextId: "ctx_from_add_context",
		});
		expect(m.createContext).not.toHaveBeenCalled();
	});

	it("does not adopt a DIFFERENT channel's row in the same project", async () => {
		m.findMany.mockResolvedValue([
			{
				id: "ctx_other",
				metadata: { provider: "SLACK", channelId: "C9" },
			},
		]);

		const result = await ensureSlackChannelIntegrationContext({
			projectId: "proj_1",
			channelId: "C1",
			userId: "user_1",
		});

		expect(result).toEqual({ created: true, contextId: "ctx_new" });
	});

	it("writes a personal-tenant row with no organizationId", async () => {
		await ensureSlackChannelIntegrationContext({
			projectId: "proj_1",
			channelId: "C1",
			userId: "user_1",
		});

		expect(m.createContext).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user_1",
				organizationId: undefined,
			}),
		);
	});
});
