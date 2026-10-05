import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
const revoke = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			oauthConnections: {
				list: () => list(),
				revoke: (input: unknown) => revoke(input),
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
		useTranslations:
			(namespace: string) =>
			(key: string, values?: Record<string, string>) =>
				lookup(`${namespace}.${key}`).replace(
					/\{(\w+)\}/g,
					(_match, name: string) => values?.[name] ?? `{${name}}`,
				),
	};
});

import { ConnectedAgentsSettings } from "../ConnectedAgentsSettings";

function renderSettings() {
	return render(
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
}

const ORGANIZATION_GRANT = {
	projectId: null,
	projectName: null,
	audience: null,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Connected agents", () => {
	it("lists each agent's access in the consent screen's words, with the raw scope kept for support", async () => {
		list.mockResolvedValue([
			{
				consentId: "consent-1",
				clientName: "Example Agent",
				organizationId: "org-example",
				organizationName: "Example Org",
				...ORGANIZATION_GRANT,
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

		renderSettings();

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

	it("names an organization grant's organization and no project", async () => {
		list.mockResolvedValue([
			{
				consentId: "consent-1",
				clientName: "Example Agent",
				organizationId: "org-example",
				organizationName: "Example Org",
				...ORGANIZATION_GRANT,
				scopes: ["mcp:read"],
				createdAt: new Date("2026-10-02T12:00:00Z"),
			},
		]);

		renderSettings();

		const row = await screen.findByTestId("connected-agent");
		expect(row).toHaveTextContent("Organization: Example Org");
		expect(
			within(row).queryByTestId("connected-agent-project"),
		).not.toBeInTheDocument();
		expect(
			within(row).getByText(en.auth.oauth.consent.scopes["mcp:read"]),
		).toBeInTheDocument();
	});

	it("names a project grant by its project and its organization, in words that say this project", async () => {
		list.mockResolvedValue([
			{
				consentId: "consent-project",
				clientName: "Example Agent",
				organizationId: "org-example",
				organizationName: "Example Org",
				projectId: "project-example-one",
				projectName: "Example Project",
				audience: "mcp",
				scopes: ["mcp:read", "instructions:write"],
				createdAt: new Date("2026-10-02T12:00:00Z"),
			},
		]);

		renderSettings();

		const row = await screen.findByTestId("connected-agent");
		expect(
			within(row).getByTestId("connected-agent-project"),
		).toHaveTextContent("Project: Example Project (Example Org)");
		expect(
			within(row).queryByText(/^Organization:/),
		).not.toBeInTheDocument();
		const projectWords = en.auth.oauth.consent.scopesProject;
		expect(within(row).getByText(projectWords["mcp:read"])).toHaveAttribute(
			"title",
			"mcp:read",
		);
		expect(
			within(row).getByText(projectWords["instructions:write"]),
		).toBeInTheDocument();
		expect(
			within(row).queryByText(en.auth.oauth.consent.scopes["mcp:read"]),
		).not.toBeInTheDocument();
	});

	it("says a project the person can no longer open is one they can no longer open, and names nothing of it", async () => {
		list.mockResolvedValue([
			{
				consentId: "consent-project",
				clientName: "Example Agent",
				organizationId: null,
				organizationName: null,
				projectId: "project-example-one",
				projectName: null,
				audience: "mcp",
				scopes: ["mcp:read"],
				createdAt: null,
			},
		]);

		renderSettings();

		expect(
			await screen.findByTestId("connected-agent-project"),
		).toHaveTextContent("Project: A project you can no longer open");
	});

	it("lists one row per grant, a project's and an organization's of the same agent apart", async () => {
		list.mockResolvedValue([
			{
				consentId: "consent-org",
				clientName: "Example Agent",
				organizationId: "org-example",
				organizationName: "Example Org",
				...ORGANIZATION_GRANT,
				scopes: ["mcp:read"],
				createdAt: null,
			},
			{
				consentId: "consent-project",
				clientName: "Example Agent",
				organizationId: "org-example",
				organizationName: "Example Org",
				projectId: "project-example-one",
				projectName: "Example Project",
				audience: "mcp",
				scopes: ["mcp:read"],
				createdAt: null,
			},
		]);

		renderSettings();

		expect(await screen.findAllByTestId("connected-agent")).toHaveLength(2);
	});

	it("revokes the one grant whose button was pressed", async () => {
		revoke.mockResolvedValue({ success: true });
		list.mockResolvedValue([
			{
				consentId: "consent-org",
				clientName: "Example Agent",
				organizationId: "org-example",
				organizationName: "Example Org",
				...ORGANIZATION_GRANT,
				scopes: ["mcp:read"],
				createdAt: null,
			},
			{
				consentId: "consent-project",
				clientName: "Example Agent",
				organizationId: "org-example",
				organizationName: "Example Org",
				projectId: "project-example-one",
				projectName: "Example Project",
				audience: "mcp",
				scopes: ["mcp:read"],
				createdAt: null,
			},
		]);
		renderSettings();
		const rows = await screen.findAllByTestId("connected-agent");

		await userEvent.click(
			within(rows[1]).getByRole("button", {
				name: en.settings.connectedAgents.revoke,
			}),
		);

		await waitFor(() =>
			expect(revoke).toHaveBeenCalledExactlyOnceWith({
				consentId: "consent-project",
			}),
		);
	});
});
