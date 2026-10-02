import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: { oauthConnections: { list: () => list(), revoke: vi.fn() } },
	},
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

/**
 * The real English messages rather than the global key echo: what is under
 * test is that this page says what the consent screen said.
 */
vi.mock("next-intl", () => {
	const lookup = (path: string): string => {
		let node: unknown = en;
		for (const segment of path.split(".")) {
			node =
				typeof node === "object" && node !== null
					? Reflect.get(node, segment)
					: undefined;
		}
		return typeof node === "string" ? node : path;
	};
	return {
		useTranslations: (namespace: string) => (key: string) =>
			lookup(`${namespace}.${key}`),
	};
});

import { ConnectedAgentsSettings } from "../ConnectedAgentsSettings";

describe("Connected agents", () => {
	it("lists each agent's access in the consent screen's words, with the raw scope kept for support", async () => {
		list.mockResolvedValue([
			{
				consentId: "consent-1",
				clientName: "Example Agent",
				organizationId: "org-example",
				organizationName: "Example Org",
				scopes: [
					"mcp:read",
					"instructions:read",
					"instructions:write",
					"offline_access",
					"custom:unknown",
				],
				createdAt: new Date("2026-10-02T12:00:00Z"),
			},
		]);

		render(
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: { queries: { retry: false } },
					})
				}
			>
				<ConnectedAgentsSettings />
			</QueryClientProvider>,
		);

		const consentWords = en.auth.oauth.consent.scopes;
		const read = await screen.findByText(consentWords["mcp:read"]);
		expect(read).toHaveAttribute("title", "mcp:read");
		expect(
			screen.getByText(consentWords["instructions:write"]),
		).toHaveAttribute("title", "instructions:write");
		expect(
			screen.getByText(consentWords.offline_access),
		).toBeInTheDocument();
		expect(
			screen.getByText("custom:unknown").closest("li"),
		).toHaveAttribute("title", "custom:unknown");
		// The raw list no longer stands in for the words.
		expect(
			screen.queryByText(/mcp:read, instructions:read/),
		).not.toBeInTheDocument();
	});
});
