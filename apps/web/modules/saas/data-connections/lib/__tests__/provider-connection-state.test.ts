import { describe, expect, it } from "vitest";
import {
	gitlabStateFromIntegrationList,
	isSearchSourceConnected,
	providerConnectedInIntegrationList,
	rowShowsProviderConnected,
} from "../provider-connection-state";

// The GitLab rows an integration list returns without a state: a
// workflow-scoped credential, the OAuth app row, another member's row.
const unstatedGitLabRow = { provider: "GITLAB", hasCredentials: true };

describe("gitlabStateFromIntegrationList", () => {
	it("is the state on the person's own row, whatever else is listed", () => {
		expect(
			gitlabStateFromIntegrationList([
				unstatedGitLabRow,
				{
					provider: "GITLAB",
					hasCredentials: false,
					connectionState: "needs-reconnect",
				},
			]),
		).toBe("needs-reconnect");
	});

	it("is not connected when only rows without a state are listed", () => {
		expect(gitlabStateFromIntegrationList([unstatedGitLabRow])).toBe(
			"not-connected",
		);
		expect(gitlabStateFromIntegrationList(undefined)).toBe("not-connected");
	});
});

describe("providerConnectedInIntegrationList", () => {
	it("does not count a GitLab row without a state as GitLab connected", () => {
		expect(
			providerConnectedInIntegrationList([unstatedGitLabRow], "GITLAB"),
		).toBe(false);
		expect(rowShowsProviderConnected(unstatedGitLabRow)).toBe(false);
	});

	it("counts GitLab only when the person's connection is connected", () => {
		expect(
			providerConnectedInIntegrationList(
				[
					{
						provider: "GITLAB",
						hasCredentials: true,
						connectionState: "connected",
					},
				],
				"GITLAB",
			),
		).toBe(true);
	});

	it("keeps raw credentials as the evidence for every other provider", () => {
		const rows = [{ provider: "LINEAR", hasCredentials: true }];
		expect(providerConnectedInIntegrationList(rows, "LINEAR")).toBe(true);
		expect(providerConnectedInIntegrationList(rows, "ASANA")).toBe(false);
	});
});

describe("isSearchSourceConnected", () => {
	it.each(["EXPIRED", "PENDING"])("never counts a %s source", (status) => {
		expect(
			isSearchSourceConnected(
				{ provider: "NOTION", status },
				"connected",
			),
		).toBe(false);
	});

	it("counts a GitLab source only while the person's GitLab is connected", () => {
		const source = { provider: "GITLAB", status: "CONNECTED" };
		expect(isSearchSourceConnected(source, "connected")).toBe(true);
		expect(isSearchSourceConnected(source, "needs-reconnect")).toBe(false);
		expect(isSearchSourceConnected(source, "not-connected")).toBe(false);
	});
});
