/**
 * A report's MCP data source is authenticated by its config's own row,
 * except on a GitLab personal server: those configs hold no token of their
 * own (a legacy copy, if any, is never read), so they follow the person's
 * GitLab connection as `gitlab.status` reports it.
 */
import { isReportMcpConfigAuthenticated } from "@saas/reports/lib/mcp-utils";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-06-01T00:00:00Z");
const LATER = new Date("2026-06-02T00:00:00Z");

describe("isReportMcpConfigAuthenticated", () => {
	it.each(["gitlab", "gitlab-official"])(
		"%s: follows the person's GitLab connection, never the config's token columns",
		(key) => {
			const legacyCopy = {
				enabled: true,
				authType: "OAUTH2",
				encryptedAccessToken: "ciphertext",
				tokenExpiresAt: LATER,
				mcpServer: { key },
			};
			for (const state of [
				undefined,
				"not-connected",
				"needs-reconnect",
			]) {
				expect(
					isReportMcpConfigAuthenticated(legacyCopy, state, NOW),
				).toBe(false);
			}

			const noCopy = {
				enabled: true,
				authType: "OAUTH2",
				encryptedAccessToken: null,
				mcpServer: { key },
			};
			expect(
				isReportMcpConfigAuthenticated(noCopy, "connected", NOW),
			).toBe(true);
			expect(
				isReportMcpConfigAuthenticated(
					{ ...noCopy, enabled: false },
					"connected",
					NOW,
				),
			).toBe(false);
		},
	);

	it("judges every other server from its own row", () => {
		const oauth = {
			enabled: true,
			authType: "OAUTH2",
			encryptedAccessToken: "ciphertext",
			mcpServer: { key: "linear" },
		};
		expect(
			isReportMcpConfigAuthenticated(
				{ ...oauth, tokenExpiresAt: LATER },
				undefined,
				NOW,
			),
		).toBe(true);
		expect(
			isReportMcpConfigAuthenticated(
				{ ...oauth, tokenExpiresAt: new Date("2026-05-01T00:00:00Z") },
				undefined,
				NOW,
			),
		).toBe(false);
		expect(
			isReportMcpConfigAuthenticated(
				{ enabled: true, authType: "API_KEY", encryptedApiKey: "k" },
				"not-connected",
				NOW,
			),
		).toBe(true);
		expect(
			isReportMcpConfigAuthenticated(
				{ enabled: true, authType: "NONE" },
				undefined,
				NOW,
			),
		).toBe(true);
	});
});
