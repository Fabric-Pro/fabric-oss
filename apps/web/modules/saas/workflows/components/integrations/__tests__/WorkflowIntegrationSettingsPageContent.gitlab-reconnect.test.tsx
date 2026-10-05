/**
 * The workflow integration settings page's Runtime summary for GitLab follows
 * the person's connection as every GitLab screen reports it. A connection
 * whose grant died (`connectionState: "needs-reconnect"` on the integration
 * list, `state: "needs-reconnect"` from `gitlab.status`) reads "Reconnect
 * needed" — not "Connected" and not "Not connected".
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	gitlabStatus: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: {
			integrations: {
				list: mocks.list,
				testSavedConnection: vi.fn(),
				testConnection: vi.fn(),
			},
		},
		aiConfig: {
			resolution: { getStatus: vi.fn().mockResolvedValue(null) },
		},
		users: { firecrawl: { getConfig: vi.fn().mockResolvedValue(null) } },
		integrations: {
			gitlab: {
				status: mocks.gitlabStatus,
				isConfigured: vi.fn().mockResolvedValue({ configured: true }),
				disconnect: vi.fn(),
				connectionState: vi.fn(),
				reconcile: vi.fn(),
				retryToolIngestion: vi.fn(),
			},
		},
	},
}));

// Keep the real GitLab plugin and its settings component.
vi.mock("../../../lib/plugins", async () => {
	await import("../../../lib/plugins/gitlab");
	const registry = await import("../../../lib/plugins/registry");
	return { getAllIntegrations: () => registry.getAllIntegrations() };
});

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkflowIntegrationSettingsPageContent } from "../WorkflowIntegrationSettingsPageContent";

function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<FeatureFlagProvider
				value={
					{ LINEAR_INTEGRATION: false } as Record<
						FeatureFlagKey,
						boolean
					>
				}
			>
				<WorkflowIntegrationSettingsPageContent
					organizationId="example-org"
					settingsBasePath="/app/example-org/settings/integrations"
					initialIntegration="GITLAB"
				/>
			</FeatureFlagProvider>
		</QueryClientProvider>,
	);
}

const gitlabRow = (
	connectionState: "connected" | "needs-reconnect",
	hasCredentials: boolean,
) => ({
	id: "gl-wi-1",
	provider: "GITLAB",
	name: "GitLab: example-user",
	isActive: true,
	hasCredentials,
	connectionState,
	credentialKeys: [],
	lastUsedAt: null,
	createdAt: new Date("2026-01-01"),
});

beforeEach(() => {
	mocks.list.mockReset();
	mocks.gitlabStatus.mockReset();
});

describe("Workflow integration settings — GitLab that needs a reconnect", () => {
	it("reads 'Reconnect needed' in the Runtime summary, not 'Connected'", async () => {
		mocks.list.mockResolvedValue({
			integrations: [gitlabRow("needs-reconnect", false)],
		});
		mocks.gitlabStatus.mockResolvedValue({
			connected: true,
			needsReauth: true,
			state: "needs-reconnect",
			username: "example-user",
			settings: {},
		});

		renderPage();

		expect(await screen.findByText("Reconnect needed")).toBeInTheDocument();
		expect(
			await screen.findByText("GitLab needs to be reconnected"),
		).toBeInTheDocument();
		expect(screen.queryByText("GitLab Connected")).not.toBeInTheDocument();
	});

	it("reads 'Connected' for a working connection", async () => {
		mocks.list.mockResolvedValue({
			integrations: [gitlabRow("connected", true)],
		});
		mocks.gitlabStatus.mockResolvedValue({
			connected: true,
			needsReauth: false,
			state: "connected",
			username: "example-user",
			settings: {},
		});

		renderPage();

		expect(await screen.findByText("GitLab Connected")).toBeInTheDocument();
		expect(screen.queryByText("Reconnect needed")).not.toBeInTheDocument();
	});

	// The GitLab rows the integration list returns WITHOUT a state keep their
	// raw credentials, and none is the person's connection. On their own,
	// the provider-level summary must follow the person's state.
	it.each([
		["a workflow-scoped GitLab credential", "GitLab (workflow)"],
		["the GitLab OAuth app row", "GITLAB_OAUTH_APP"],
		["another member's personal GitLab row", "GitLab: other-member"],
	])(
		"reads 'Not connected' when the only GitLab record is %s",
		async (_kind, name) => {
			mocks.list.mockResolvedValue({
				integrations: [
					{
						id: "gl-other",
						provider: "GITLAB",
						name,
						isActive: true,
						hasCredentials: true,
						credentialKeys: ["access_token"],
						lastUsedAt: null,
						createdAt: new Date("2026-01-01"),
					},
				],
			});
			mocks.gitlabStatus.mockResolvedValue({
				connected: false,
				needsReauth: false,
				state: "not-connected",
				settings: {},
			});

			renderPage();

			expect(
				await screen.findByText("Not connected"),
			).toBeInTheDocument();
			expect(
				await screen.findByRole("button", {
					name: /Connect GitLab Account/,
				}),
			).toBeInTheDocument();
			expect(
				screen.queryByText("Workflow configured"),
			).not.toBeInTheDocument();
			expect(screen.queryByText("Connected")).not.toBeInTheDocument();
			// No "a GitLab credential is saved here" offer to disconnect
			// something the personal disconnect does not remove.
			expect(
				screen.queryByText("A GitLab credential is saved here"),
			).not.toBeInTheDocument();
		},
	);
});
