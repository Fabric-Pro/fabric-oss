/**
 * Provider Map Consistency Test
 *
 * Verifies that known providers resolve correctly through the gateway
 * authority service, ensuring the local CANONICAL_PROVIDER_KEYS map
 * in authority-service.ts stays consistent.
 *
 * Run with: pnpm --filter web test -- provider-map-sync
 */

import { describe, expect, it } from "vitest";
import { resolveProviderFromMcpConfig } from "../authority-service";

describe("Provider map consistency", () => {
	const KNOWN_PROVIDERS: Array<{ serverKey: string; expected: string }> = [
		{ serverKey: "github", expected: "github" },
		{ serverKey: "github-mcp", expected: "github" },
		{ serverKey: "linear", expected: "linear" },
		{ serverKey: "slack", expected: "slack" },
		{ serverKey: "notion", expected: "notion" },
		{ serverKey: "jira", expected: "jira" },
		{ serverKey: "atlassian-jira", expected: "jira" },
		{ serverKey: "azure-devops", expected: "azure-devops" },
		{ serverKey: "figma", expected: "figma" },
		{ serverKey: "confluence", expected: "confluence" },
		{ serverKey: "gitlab", expected: "gitlab" },
		{ serverKey: "microsoft-teams", expected: "microsoft-teams" },
		{ serverKey: "google-drive", expected: "google-drive" },
		{ serverKey: "gmail", expected: "gmail" },
		{ serverKey: "hubspot", expected: "hubspot" },
		{ serverKey: "salesforce", expected: "salesforce" },
		{ serverKey: "stripe", expected: "stripe" },
		{ serverKey: "excalidraw", expected: "excalidraw" },
	];

	it.each(KNOWN_PROVIDERS)(
		"should resolve '$serverKey' to '$expected'",
		({ serverKey, expected }) => {
			const result = resolveProviderFromMcpConfig({
				id: "test-config",
				mcpServer: { key: serverKey, name: serverKey },
			});
			expect(result.providerKey).toBe(expected);
		},
	);

	it("should use custom: prefix for unknown servers", () => {
		const result = resolveProviderFromMcpConfig({
			id: "test-config",
			mcpServer: { key: "my-internal-api", name: "Internal API" },
		});
		expect(result.providerKey).toBe("custom:my-internal-api");
	});
});
