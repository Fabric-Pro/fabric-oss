import { beforeEach, describe, expect, it, vi } from "vitest";

import "../../plugins";
import {
	getIntegration,
	getKnowledgeIntegrationTypes,
	getToolIntegrationTypes,
} from "../../plugins";

describe("workflow integration provider coverage", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("registers GitHub, Confluence, Slack, and Google Drive with expected categories", () => {
		expect(getIntegration("GITHUB")).toEqual(
			expect.objectContaining({
				label: "GitHub",
				category: "both",
			}),
		);
		expect(getIntegration("CONFLUENCE")).toEqual(
			expect.objectContaining({
				label: "Confluence",
				category: "knowledge",
			}),
		);
		expect(getIntegration("SLACK")).toEqual(
			expect.objectContaining({
				label: "Slack",
				category: "both",
			}),
		);
		expect(getIntegration("GOOGLE_DRIVE")).toEqual(
			expect.objectContaining({
				label: "Google Drive",
				category: "knowledge",
			}),
		);

		expect(getKnowledgeIntegrationTypes()).toEqual(
			expect.arrayContaining([
				"CONFLUENCE",
				"GOOGLE_DRIVE",
				"GITHUB",
				"SLACK",
			]),
		);
		expect(getToolIntegrationTypes()).toEqual(
			expect.arrayContaining(["GITHUB", "SLACK"]),
		);
	});

	it("exposes concrete action coverage for the four audited providers", () => {
		expect(
			getIntegration("GITHUB")?.actions.map((action) => action.slug),
		).toEqual(
			expect.arrayContaining([
				"create-issue",
				"search-issues",
				"get-file",
			]),
		);
		expect(
			getIntegration("CONFLUENCE")?.actions.map((action) => action.slug),
		).toEqual(
			expect.arrayContaining([
				"search-content",
				"get-page",
				"list-pages",
				"create-page",
			]),
		);
		expect(
			getIntegration("SLACK")?.actions.map((action) => action.slug),
		).toEqual(["send-message"]);
		expect(
			getIntegration("GOOGLE_DRIVE")?.actions.map(
				(action) => action.slug,
			),
		).toEqual(
			expect.arrayContaining([
				"list-files",
				"get-document",
				"search-files",
			]),
		);
	});

	it("validates Confluence credentials via its test function", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			json: async () => ({ displayName: "Test Admin" }),
		} as Response);

		const confluence = getIntegration("CONFLUENCE");
		const testFn = await confluence?.testConfig?.getTestFunction?.();
		const result = await testFn?.({
			CONFLUENCE_DOMAIN: "example.atlassian.net",
			CONFLUENCE_EMAIL: "test-user@example.com",
			CONFLUENCE_API_TOKEN: "token-123",
		});

		expect(result).toEqual({
			success: true,
			message: "Connected as Test Admin",
		});
	});

	it("uses OAuth-backed settings for GitHub, Slack, and Google Drive", () => {
		expect(getIntegration("GITHUB")?.settingsComponent).toBeDefined();
		expect(getIntegration("SLACK")?.SettingsComponent).toBeDefined();
		expect(getIntegration("GOOGLE_DRIVE")?.SettingsComponent).toBeDefined();
		expect(getIntegration("SLACK")?.testConfig?.skipClientTest).toBe(true);
		expect(getIntegration("GOOGLE_DRIVE")?.testConfig?.skipClientTest).toBe(
			true,
		);
	});

	it("registers Databricks Vector Search as a knowledge source", () => {
		expect(getIntegration("DATABRICKS_VECTOR_SEARCH")).toEqual(
			expect.objectContaining({
				label: "Databricks Vector Search",
				category: "knowledge",
			}),
		);
		expect(getKnowledgeIntegrationTypes()).toEqual(
			expect.arrayContaining(["DATABRICKS_VECTOR_SEARCH"]),
		);
	});
});
