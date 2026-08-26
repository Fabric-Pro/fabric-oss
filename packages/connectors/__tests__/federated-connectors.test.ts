import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubFederatedConnector } from "../src/github/github-federated";
import { SlackFederatedConnector } from "../src/slack/slack-federated";

describe("federated connectors", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("formats GitHub federated code and issue results", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					items: [
						{
							sha: "sha-1",
							name: "auth.ts",
							path: "src/auth.ts",
							html_url:
								"https://github.com/acme/repo/blob/main/src/auth.ts",
							repository: { full_name: "acme/repo" },
							text_matches: [{ fragment: "function login() {}" }],
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					items: [
						{
							id: 42,
							title: "Fix auth regression",
							body: "Users cannot sign in after deploy",
							html_url: "https://github.com/acme/repo/issues/42",
							user: { login: "example-user" },
							updated_at: "2026-04-03T00:00:00.000Z",
							repository_url:
								"https://api.github.com/repos/acme/repo",
						},
					],
				}),
			} as Response);

		const connector = new GitHubFederatedConnector();
		const results = await connector.federatedSearch({
			query: "auth regression",
			maxResults: 4,
			config: {
				id: "conn-1",
				provider: "GITHUB",
				credentials: { accessToken: "gh-token" },
				providerConfig: { owner: "acme" },
				syncConfig: {
					fullSyncIntervalHours: 4,
					incrementalSyncIntervalMinutes: 30,
					enablePermissionsSync: false,
					enableContentSync: true,
				},
			} as any,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual(
			expect.objectContaining({
				provider: "GITHUB",
				title: "src/auth.ts in acme/repo",
				sourceName: "acme/repo",
				metadata: expect.objectContaining({
					type: "code",
					freshness: "live",
				}),
			}),
		);
		expect(results[1]).toEqual(
			expect.objectContaining({
				provider: "GITHUB",
				title: "Issue: Fix auth regression",
				author: "example-user",
				metadata: expect.objectContaining({
					type: "issue",
					freshness: "live",
				}),
			}),
		);
	});

	it("requires a GitHub token for federated search", async () => {
		const connector = new GitHubFederatedConnector();

		await expect(
			connector.federatedSearch({
				query: "auth",
				config: {
					id: "conn-1",
					provider: "GITHUB",
					credentials: {},
					providerConfig: {},
					syncConfig: {
						fullSyncIntervalHours: 4,
						incrementalSyncIntervalMinutes: 30,
						enablePermissionsSync: false,
						enableContentSync: true,
					},
				} as any,
			}),
		).rejects.toThrow("GitHub access token required for federated search");
	});

	it("formats Slack federated message results", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			json: async () => ({
				ok: true,
				messages: {
					matches: [
						{
							iid: "msg-1",
							text: "Launch status is green",
							username: "example-user",
							channel: { name: "launch", id: "C123" },
							permalink: "https://slack.com/archives/C123/p123",
							ts: "1712000000.123",
						},
					],
				},
			}),
		} as Response);

		const connector = new SlackFederatedConnector();
		const results = await connector.federatedSearch({
			query: "launch status",
			maxResults: 5,
			config: {
				id: "conn-2",
				provider: "SLACK",
				credentials: { accessToken: "xoxb-token" },
				providerConfig: {},
				syncConfig: {
					fullSyncIntervalHours: 1,
					incrementalSyncIntervalMinutes: 15,
					enablePermissionsSync: false,
					enableContentSync: true,
				},
			} as any,
		});

		expect(results).toHaveLength(1);
		expect(results[0]).toEqual(
			expect.objectContaining({
				provider: "SLACK",
				title: "Message in #launch",
				author: "example-user",
				sourceName: "#launch",
				metadata: expect.objectContaining({
					channelId: "C123",
					channelName: "launch",
					freshness: "live",
				}),
			}),
		);
	});

	it("surfaces Slack API failures", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			json: async () => ({
				ok: false,
				error: "invalid_auth",
			}),
		} as Response);

		const connector = new SlackFederatedConnector();

		await expect(
			connector.federatedSearch({
				query: "launch",
				config: {
					id: "conn-2",
					provider: "SLACK",
					credentials: { accessToken: "bad-token" },
					providerConfig: {},
					syncConfig: {
						fullSyncIntervalHours: 1,
						incrementalSyncIntervalMinutes: 15,
						enablePermissionsSync: false,
						enableContentSync: true,
					},
				} as any,
			}),
		).rejects.toThrow("Slack API error: invalid_auth");
	});
});
