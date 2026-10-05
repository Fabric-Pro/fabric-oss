/**
 * Pins which Disconnect the workflow integration settings page shows.
 *
 * The page renders a plugin's custom settings component and then a generic
 * footer. The footer's Disconnect only deletes the stored WorkflowIntegration
 * rows (`workflows.integrations.disconnectByType`), which does not disconnect
 * a provider whose tokens live elsewhere: for GitLab it left the MCP tokens
 * and the data connection in place, so GitLab tools kept working after
 * "Disconnect". A connected GitLab user saw two Disconnect buttons, and the
 * footer one was the wrong one.
 *
 * A plugin whose settings component runs its own provider-specific disconnect
 * declares `ownsDisconnect`, and the footer button is then omitted. These tests
 * run against the real GitLab and Perplexity plugin definitions (only the
 * registry barrel, which would eagerly import every provider, is replaced), so
 * the declaration itself is under test, not a fixture that copies it.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listIntegrations: vi.fn(),
	disconnectByType: vi.fn(),
	gitlabStatus: vi.fn(),
	gitlabIsConfigured: vi.fn(),
	gitlabDisconnect: vi.fn(),
	oauthDisconnect: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: {
			integrations: {
				list: mocks.listIntegrations,
				disconnectByType: mocks.disconnectByType,
			},
		},
		aiConfig: {
			resolution: { getStatus: vi.fn().mockResolvedValue(null) },
		},
		users: {
			firecrawl: { getConfig: vi.fn().mockResolvedValue(null) },
		},
		integrations: {
			oauth: { disconnect: mocks.oauthDisconnect },
			gitlab: {
				status: mocks.gitlabStatus,
				isConfigured: mocks.gitlabIsConfigured,
				disconnect: mocks.gitlabDisconnect,
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// The real barrel imports every provider plugin. Load only the two under test;
// each registers itself with the real registry on import.
vi.mock("../../../lib/plugins", async () => {
	await import("../../../lib/plugins/gitlab");
	await import("../../../lib/plugins/perplexity");
	const registry = await import("../../../lib/plugins/registry");
	return { getAllIntegrations: () => registry.getAllIntegrations() };
});

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IntegrationType } from "../../../lib/plugins/types";
import { WorkflowIntegrationSettingsPageContent } from "../WorkflowIntegrationSettingsPageContent";

const ORGANIZATION_ID = "org-example";

function configured(provider: string) {
	return {
		integrations: [
			{
				id: `integration-${provider}`,
				provider,
				name: provider,
				isActive: true,
				hasCredentials: true,
				credentialKeys: ["apiKey"],
				lastUsedAt: null,
				createdAt: new Date("2026-01-01"),
				// The person's own GitLab row carries the connection's state
				// (`gitlabConnectionRowStatus`); a GitLab row without one is
				// not the person's connection and does not make GitLab
				// connected on this page.
				...(provider === "GITLAB"
					? { connectionState: "connected" as const }
					: {}),
			},
		],
	};
}

function renderPage(
	initialIntegration: IntegrationType,
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	}),
) {
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
					organizationId={ORGANIZATION_ID}
					settingsBasePath="/app/example-org/settings/integrations"
					initialIntegration={initialIntegration}
				/>
			</FeatureFlagProvider>
		</QueryClientProvider>,
	);
}

async function confirmDisconnect(
	user: ReturnType<typeof userEvent.setup>,
	expectedCopy?: RegExp,
) {
	const dialog = await screen.findByRole("alertdialog");
	if (expectedCopy) {
		expect(dialog).toHaveTextContent(expectedCopy);
	}
	await user.click(
		within(dialog).getByRole("button", { name: /^disconnect$/i }),
	);
}

/**
 * GitLab's Disconnect also clears the official GitLab MCP server, and says
 * project repository links are left alone.
 */
const GITLAB_EVERYWHERE =
	/GitLab connection in Fabric, including the official GitLab MCP server.*repositories linked in a project's settings stay connected/is;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.gitlabIsConfigured.mockResolvedValue({ configured: true });
	mocks.gitlabDisconnect.mockResolvedValue({
		success: true,
		revocationWarning: null,
	});
	mocks.disconnectByType.mockResolvedValue({ success: true });
	mocks.oauthDisconnect.mockResolvedValue({ success: true });
});

describe("WorkflowIntegrationSettingsPageContent: GitLab Disconnect", () => {
	it("shows exactly one Disconnect, and it runs gitlab.disconnect (OAuth connection)", async () => {
		mocks.listIntegrations.mockResolvedValue(configured("GITLAB"));
		mocks.gitlabStatus.mockResolvedValue({
			connected: true,
			username: "example-user",
			name: "Example User",
		});
		const user = userEvent.setup();
		renderPage("GITLAB");

		// Wait for the workflow-integrations list so the generic footer button
		// would already be on screen if the page still rendered it.
		await screen.findByText("Workflow configured");
		const disconnectButtons = screen.getAllByRole("button", {
			name: /disconnect/i,
		});
		expect(disconnectButtons).toHaveLength(1);
		const [disconnect] = disconnectButtons;
		// Still named while its spinner replaces the label.
		expect(disconnect).toHaveAccessibleName("Disconnect GitLab");

		await user.click(disconnect);
		await confirmDisconnect(user, GITLAB_EVERYWHERE);

		await waitFor(() =>
			expect(mocks.gitlabDisconnect).toHaveBeenCalledWith({
				organizationId: ORGANIZATION_ID,
			}),
		);
		expect(mocks.disconnectByType).not.toHaveBeenCalled();
		expect(mocks.oauthDisconnect).not.toHaveBeenCalled();
	});

	it("gives a connection with no GitLab profile (a PAT, or an MCP-only token) the same single Disconnect", async () => {
		// A PAT is saved through the generic save path: an active GITLAB row
		// with no GitLab profile in its settings, so `gitlab.status` reports
		// `connected` without a username. The copy must not claim OAuth or PAT,
		// because a missing profile does not say which one it is.
		mocks.listIntegrations.mockResolvedValue(configured("GITLAB"));
		mocks.gitlabStatus.mockResolvedValue({ connected: true });
		const user = userEvent.setup();
		renderPage("GITLAB");

		await screen.findByText("Workflow configured");
		const disconnectButtons = screen.getAllByRole("button", {
			name: /disconnect/i,
		});
		expect(disconnectButtons).toHaveLength(1);
		const [disconnect] = disconnectButtons;
		expect(screen.queryByText(/personal access token/i)).toBeNull();
		expect(screen.queryByText(/via oauth/i)).toBeNull();

		await user.click(disconnect);
		const dialog = await screen.findByRole("alertdialog");
		// The dialog must not name a GitLab account the connection lacks.
		expect(dialog).not.toHaveTextContent("@");
		expect(dialog).toHaveTextContent(GITLAB_EVERYWHERE);
		await user.click(
			within(dialog).getByRole("button", { name: /^disconnect$/i }),
		);

		await waitFor(() =>
			expect(mocks.gitlabDisconnect).toHaveBeenCalledWith({
				organizationId: ORGANIZATION_ID,
			}),
		);
		expect(mocks.disconnectByType).not.toHaveBeenCalled();
	});

	it("keeps one Disconnect when the status check fails but a GitLab credential is listed", async () => {
		// The generic footer Disconnect is gone for GitLab, so a failed
		// `gitlab.status` (previously folded into "not connected") must not
		// leave a stored credential with no way to disconnect it.
		mocks.listIntegrations.mockResolvedValue(configured("GITLAB"));
		mocks.gitlabStatus.mockRejectedValue(new Error("status unavailable"));
		const user = userEvent.setup();
		renderPage("GITLAB");

		// Waits through the one retry before the query reports its error.
		await screen.findByText(
			/couldn.t check gitlab connection status/i,
			undefined,
			{ timeout: 4000 },
		);
		const disconnectButtons = screen.getAllByRole("button", {
			name: /disconnect/i,
		});
		expect(disconnectButtons).toHaveLength(1);
		expect(disconnectButtons[0]).toHaveAccessibleName("Disconnect GitLab");

		await user.click(disconnectButtons[0]);
		await confirmDisconnect(user, GITLAB_EVERYWHERE);

		await waitFor(() =>
			expect(mocks.gitlabDisconnect).toHaveBeenCalledWith({
				organizationId: ORGANIZATION_ID,
			}),
		);
		expect(mocks.disconnectByType).not.toHaveBeenCalled();
		expect(mocks.oauthDisconnect).not.toHaveBeenCalled();
	});

	it("keeps one Disconnect when an older GitLab row without credentials follows a stored one", async () => {
		// The list is newest first; an older empty or undecryptable row must
		// not overwrite the stored row's evidence, or a failed status check
		// leaves no way to disconnect.
		const stored = configured("GITLAB").integrations[0];
		mocks.listIntegrations.mockResolvedValue({
			integrations: [
				stored,
				{
					...stored,
					id: "integration-GITLAB-older",
					hasCredentials: false,
					credentialKeys: [],
					createdAt: new Date("2025-06-01"),
				},
			],
		});
		mocks.gitlabStatus.mockRejectedValue(new Error("status unavailable"));
		renderPage("GITLAB");

		await screen.findByText(
			/couldn.t check gitlab connection status/i,
			undefined,
			{ timeout: 4000 },
		);
		const disconnectButtons = screen.getAllByRole("button", {
			name: /disconnect/i,
		});
		expect(disconnectButtons).toHaveLength(1);
		expect(disconnectButtons[0]).toHaveAccessibleName("Disconnect GitLab");
	});

	it("keeps one Disconnect when another screen cached a guessed `{ connected: false }` under the shared status key", async () => {
		// The project repository settings used to swallow a failed status
		// request into `{ connected: false }`, cached as a fresh success for the
		// same key for 30 seconds. This page then saw neither "connected" nor an
		// error. With a SAVED credential listed it must still offer Disconnect.
		mocks.listIntegrations.mockResolvedValue(configured("GITLAB"));
		mocks.gitlabStatus.mockResolvedValue({ connected: true });
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		await queryClient.fetchQuery({
			queryKey: ["gitlab-oauth-status", ORGANIZATION_ID],
			queryFn: async () => {
				try {
					throw new Error("status request failed");
				} catch {
					return { connected: false };
				}
			},
			staleTime: 30_000,
		});
		const user = userEvent.setup();
		renderPage("GITLAB", queryClient);

		await screen.findByText("Workflow configured");
		const disconnectButtons = await screen.findAllByRole("button", {
			name: /disconnect/i,
		});
		expect(disconnectButtons).toHaveLength(1);
		// The cached guess was served, not refetched.
		expect(mocks.gitlabStatus).not.toHaveBeenCalled();

		await user.click(disconnectButtons[0]);
		await confirmDisconnect(user);
		await waitFor(() =>
			expect(mocks.gitlabDisconnect).toHaveBeenCalledWith({
				organizationId: ORGANIZATION_ID,
			}),
		);
		expect(mocks.disconnectByType).not.toHaveBeenCalled();
	});

	it("treats a legacy MCP token copy as not connected: no partial notice and nothing to disconnect", async () => {
		// Earlier releases reported a token on the MCP config with no
		// connection behind it as `partialConnection` and offered a
		// Disconnect for it. The copy is no longer read or kept, so the field
		// is gone; a stale response that still carries it changes nothing.
		mocks.listIntegrations.mockResolvedValue({ integrations: [] });
		mocks.gitlabStatus.mockResolvedValue({
			connected: false,
			partialConnection: true,
		});
		renderPage("GITLAB");

		expect(
			await screen.findByRole("button", {
				name: /connect gitlab account/i,
			}),
		).toBeInTheDocument();
		expect(screen.queryByText(/only partly connected/i)).toBeNull();
		expect(
			screen.queryByRole("button", { name: /disconnect/i }),
		).toBeNull();
	});

	it("does not treat a typed but unsaved Personal Access Token as a stored credential", async () => {
		// `hasKey` is true as soon as text is typed. Only the saved list counts:
		// with nothing persisted and the status check failing, the form must stay
		// and there is nothing to disconnect.
		mocks.listIntegrations.mockResolvedValue({ integrations: [] });
		mocks.gitlabIsConfigured.mockResolvedValue({ configured: false });
		mocks.gitlabStatus.mockRejectedValue(new Error("status unavailable"));
		const user = userEvent.setup();
		renderPage("GITLAB");

		const input = await screen.findByLabelText(/gitlab access token/i);
		await user.type(input, "glpat-typed-not-saved");
		await screen.findByText(
			/couldn.t check gitlab connection status/i,
			undefined,
			{
				timeout: 4000,
			},
		);

		expect(screen.getByLabelText(/gitlab access token/i)).toHaveValue(
			"glpat-typed-not-saved",
		);
		expect(
			screen.queryByRole("button", { name: /disconnect/i }),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/credential is saved here/i)).toBeNull();
	});

	it("says the status is unavailable, and offers no Disconnect, when the check fails and nothing is listed", async () => {
		mocks.listIntegrations.mockResolvedValue({ integrations: [] });
		mocks.gitlabStatus.mockRejectedValue(new Error("status unavailable"));
		renderPage("GITLAB");

		await screen.findByText(
			/couldn.t check gitlab connection status/i,
			undefined,
			{
				timeout: 4000,
			},
		);
		await waitFor(() =>
			expect(mocks.listIntegrations).toHaveBeenCalledTimes(1),
		);
		expect(
			screen.queryByRole("button", { name: /disconnect/i }),
		).not.toBeInTheDocument();
	});

	it("shows no Disconnect at all when GitLab is not connected", async () => {
		mocks.listIntegrations.mockResolvedValue({ integrations: [] });
		mocks.gitlabStatus.mockResolvedValue({ connected: false });
		renderPage("GITLAB");

		await screen.findByRole("button", { name: /connect gitlab account/i });
		await waitFor(() =>
			expect(mocks.listIntegrations).toHaveBeenCalledTimes(1),
		);
		expect(
			screen.queryByRole("button", { name: /disconnect/i }),
		).not.toBeInTheDocument();
	});
});

describe("WorkflowIntegrationSettingsPageContent: plugins without their own Disconnect", () => {
	it("keeps the generic footer Disconnect for an API-key plugin and runs disconnectByType", async () => {
		mocks.listIntegrations.mockResolvedValue(configured("PERPLEXITY"));
		const user = userEvent.setup();
		renderPage("PERPLEXITY");

		const disconnect = await screen.findByRole("button", {
			name: /^disconnect$/i,
		});
		expect(
			screen.getAllByRole("button", { name: /disconnect/i }),
		).toHaveLength(1);

		await user.click(disconnect);
		await confirmDisconnect(user);

		await waitFor(() =>
			expect(mocks.disconnectByType).toHaveBeenCalledWith({
				type: "PERPLEXITY",
				organizationId: ORGANIZATION_ID,
			}),
		);
		expect(mocks.gitlabDisconnect).not.toHaveBeenCalled();
		expect(mocks.oauthDisconnect).not.toHaveBeenCalled();
	});
});
