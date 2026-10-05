import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	testSavedConnection: vi.fn(),
	testConnection: vi.fn(),
	githubStatus: vi.fn(),
	githubStart: vi.fn(),
	githubDisconnect: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: {
			integrations: {
				list: mocks.list,
				testSavedConnection: mocks.testSavedConnection,
				testConnection: mocks.testConnection,
			},
		},
		aiConfig: {
			resolution: { getStatus: vi.fn().mockResolvedValue(null) },
		},
		users: { firecrawl: { getConfig: vi.fn().mockResolvedValue(null) } },
		integrations: {
			github: {
				status: mocks.githubStatus,
				start: mocks.githubStart,
				disconnect: mocks.githubDisconnect,
				isConfigured: vi.fn().mockResolvedValue({ configured: true }),
			},
		},
	},
}));

// Keep the real GitHub plugin, settings component, queries, and shared Button.
vi.mock("../../../lib/plugins", async () => {
	await import("../../../lib/plugins/github");
	const registry = await import("../../../lib/plugins/registry");
	return { getAllIntegrations: () => registry.getAllIntegrations() };
});

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GitHubSettings } from "../../../lib/plugins/github/GitHubSettings";
import { WorkflowIntegrationSettingsPageContent } from "../WorkflowIntegrationSettingsPageContent";

beforeEach(() => {
	vi.clearAllMocks();
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.list.mockResolvedValue({
		integrations: [
			{
				id: "integration-example",
				provider: "GITHUB",
				name: "GitHub",
				isActive: true,
				hasCredentials: true,
				credentialKeys: ["access_token"],
				lastUsedAt: null,
				createdAt: new Date("2026-01-01"),
			},
		],
	});
	mocks.githubStatus.mockResolvedValue({
		connected: true,
		login: "example-user",
	});
	mocks.githubStart.mockResolvedValue({
		authorizationUrl:
			"https://github.com/login/oauth/authorize?client_id=example",
	});
});

function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const page = (organizationId: string) => (
		<StrictMode>
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
						organizationId={organizationId}
						settingsBasePath="/app/example-org/settings/integrations"
						initialIntegration="GITHUB"
					/>
				</FeatureFlagProvider>
			</QueryClientProvider>
		</StrictMode>
	);
	const view = render(page("org-example"));
	return {
		...view,
		switchOrganization: (organizationId: string) =>
			view.rerender(page(organizationId)),
	};
}

describe("Workflow integration connection test lifecycle", () => {
	it("keeps the shared settings neutral when a caller such as DataSourcesSheet supplies no live test result", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={queryClient}>
				<GitHubSettings
					apiKey=""
					hasKey={false}
					onApiKeyChange={() => {}}
					organizationId="org-example"
				/>
			</QueryClientProvider>,
		);
		await screen.findByText("Connection needs checking");
		expect(screen.queryByText("GitHub Connected")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Reconnect GitHub" }),
		).not.toBeInTheDocument();
	});
	it("keeps a persisted connection neutral while its account metadata is unavailable", async () => {
		mocks.githubStatus.mockImplementation(() => new Promise(() => {}));
		renderPage();
		await screen.findByText("Workflow configured");
		expect(
			screen.getByText("Connection needs checking"),
		).toBeInTheDocument();
		expect(screen.queryByText("GitHub Connected")).not.toBeInTheDocument();
	});
	it.each([
		{
			outcome: "invalid saved token",
			result: {
				success: false,
				status: "reconnect_required",
				error: "Access token expired or invalid. Please reconnect GitHub.",
			},
			banner: "Connection Failed",
			message:
				"Access token expired or invalid. Please reconnect GitHub.",
		},
		{
			outcome: "successful connection",
			result: {
				success: true,
				status: "connected",
				message: "Connected as example-user",
			},
			banner: "Connection Successful",
			message: "Connected as example-user",
		},
		{
			outcome: "temporary provider outage",
			result: {
				success: false,
				status: "unknown",
				error: "GitHub is temporarily unavailable. Please try again.",
			},
			banner: "Connection Failed",
			message: "GitHub is temporarily unavailable. Please try again.",
		},
		{
			outcome: "rejected request",
			result: new Error("Connection test unavailable"),
			banner: "Connection Failed",
			message: "Connection test unavailable",
		},
	])(
		"allows retry after $outcome under Strict Mode",
		async ({ result, banner, message }) => {
			let resolveTest!: (value: {
				success: boolean;
				message?: string;
				error?: string;
			}) => void;
			let rejectTest!: (error: Error) => void;
			mocks.testSavedConnection.mockImplementation(
				() =>
					new Promise((resolve, reject) => {
						resolveTest = resolve;
						rejectTest = reject;
					}),
			);
			const user = userEvent.setup();
			const queryClient = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			render(
				<StrictMode>
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
								organizationId="org-example"
								settingsBasePath="/app/example-org/settings/integrations"
								initialIntegration="GITHUB"
							/>
						</FeatureFlagProvider>
					</QueryClientProvider>
				</StrictMode>,
			);
			await screen.findByText("Workflow configured");
			await screen.findByText("Connection needs checking");
			expect(
				screen.queryByText("GitHub Connected"),
			).not.toBeInTheDocument();
			await user.click(
				screen.getByRole("button", { name: "Test Connection" }),
			);
			expect(
				screen.getByRole("button", { name: "Testing..." }),
			).toBeDisabled();
			expect(mocks.testSavedConnection).toHaveBeenCalledWith({
				type: "GITHUB",
				organizationId: "org-example",
			});
			expect(mocks.testConnection).not.toHaveBeenCalled();
			await act(async () => {
				if (result instanceof Error) {
					rejectTest(result);
				} else {
					resolveTest(result);
				}
			});
			expect(screen.getByText(banner)).toBeInTheDocument();
			expect(screen.getByText(message)).toBeInTheDocument();
			if (result instanceof Error || result.status === "unknown") {
				expect(
					screen.getByText("Connection needs checking"),
				).toBeInTheDocument();
				expect(
					screen.queryByRole("button", { name: "Reconnect GitHub" }),
				).not.toBeInTheDocument();
			} else if (result.status === "reconnect_required") {
				expect(
					screen.getByText("Reconnect required"),
				).toBeInTheDocument();
			} else {
				expect(
					screen.getByText("GitHub Connected"),
				).toBeInTheDocument();
			}
			const button = screen.getByRole("button", {
				name: "Test Connection",
			});
			expect(button).toBeEnabled();
			expect(button.querySelector(".animate-spin")).toBeNull();
			await user.click(button);
			expect(mocks.testSavedConnection).toHaveBeenCalledTimes(2);
			expect(screen.queryByText(banner)).not.toBeInTheDocument();
			await act(async () =>
				resolveTest({
					success: true,
					message: "Connected as example-user",
				}),
			);
			expect(
				screen.getByRole("button", { name: "Test Connection" }),
			).toBeEnabled();
			queryClient.clear();
		},
	);
	it("offers direct OAuth reconnect while keeping intentional Disconnect separate, then verifies the saved connection automatically after callback", async () => {
		mocks.testSavedConnection.mockResolvedValue({
			success: false,
			status: "reconnect_required",
			error: "Reconnect required for authorization",
		});
		const popup = vi
			.spyOn(window, "open")
			.mockReturnValue({ closed: false } as Window);
		const user = userEvent.setup();
		renderPage();
		await screen.findByText("Workflow configured");
		await user.click(
			screen.getByRole("button", { name: "Test Connection" }),
		);
		const reconnect = await screen.findByRole("button", {
			name: "Reconnect GitHub",
		});
		expect(
			screen.getByRole("button", { name: "Disconnect" }),
		).toBeInTheDocument();
		await user.click(reconnect);
		expect(mocks.githubStart).toHaveBeenCalledWith({
			organizationId: "org-example",
			redirectUri: `${window.location.origin}/api/integrations/github/oauth/callback`,
			returnUrl: "/",
		});
		expect(popup).toHaveBeenCalledWith(
			"https://github.com/login/oauth/authorize?client_id=example",
			"github-oauth",
			expect.any(String),
		);
		expect(mocks.githubDisconnect).not.toHaveBeenCalled();
		let finishCheck!: (result: unknown) => void;
		mocks.testSavedConnection.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishCheck = resolve;
				}),
		);
		await act(async () =>
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					data: { type: "github_oauth_success" },
				}),
			),
		);
		await vi.waitFor(() =>
			expect(mocks.testSavedConnection).toHaveBeenCalledTimes(2),
		);
		expect(mocks.testSavedConnection).toHaveBeenLastCalledWith({
			type: "GITHUB",
			organizationId: "org-example",
		});
		expect(mocks.testConnection).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Testing..." }),
		).toBeDisabled();
		await act(async () =>
			finishCheck({
				success: true,
				status: "connected",
				message: "Connected as example-user",
			}),
		);
		await screen.findByText("GitHub Connected");
		expect(
			screen.getByRole("button", { name: "Test Connection" }),
		).toBeEnabled();
		popup.mockRestore();
	});
	it.each([
		{
			status: "unknown",
			text: "Connection needs checking",
			error: "Temporary GitHub outage",
		},
		{
			status: "reconnect_required",
			text: "Reconnect required",
			error: "Authorization rejected",
		},
	])(
		"classifies the automatic OAuth callback check as $status",
		async ({ status, text, error }) => {
			mocks.testSavedConnection.mockResolvedValue({
				success: false,
				status,
				error,
			});
			renderPage();
			await screen.findByText("Workflow configured");
			await act(async () =>
				window.dispatchEvent(
					new MessageEvent("message", {
						origin: window.location.origin,
						data: { type: "github_oauth_success" },
					}),
				),
			);
			await vi.waitFor(() =>
				expect(mocks.testSavedConnection).toHaveBeenCalledTimes(1),
			);
			await screen.findByText(text);
			expect(
				screen.getByText(error, { exact: false }),
			).toBeInTheDocument();
			expect(
				screen.queryByText("GitHub Connected"),
			).not.toBeInTheDocument();
			expect(mocks.testConnection).not.toHaveBeenCalled();
			expect(
				screen.getByRole("button", { name: "Test Connection" }),
			).toBeEnabled();
		},
	);

	it("automatically checks a newly saved OAuth connection after the account list changes", async () => {
		const savedList = await mocks.list();
		mocks.list.mockResolvedValue({ integrations: [] });
		mocks.githubStatus.mockResolvedValue({ connected: false });
		mocks.testSavedConnection.mockResolvedValue({
			success: true,
			status: "connected",
		});
		renderPage();
		await screen.findByRole("button", { name: "Connect GitHub Account" });
		mocks.list.mockClear();
		mocks.list.mockResolvedValue(savedList);
		mocks.githubStatus.mockResolvedValue({
			connected: true,
			login: "example-user",
		});
		await act(async () =>
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					data: { type: "github_oauth_success" },
				}),
			),
		);
		await screen.findByText("GitHub Connected");
		expect(mocks.testSavedConnection).toHaveBeenCalledExactlyOnceWith({
			type: "GITHUB",
			organizationId: "org-example",
		});
		expect(mocks.testConnection).not.toHaveBeenCalled();
	});

	it("cancels a queued callback check when the organization changes", async () => {
		const savedList = await mocks.list();
		const { switchOrganization } = renderPage();
		await screen.findByText("Workflow configured");
		let finishList!: (value: unknown) => void;
		mocks.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishList = resolve;
				}),
		);
		await act(async () =>
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					data: { type: "github_oauth_success" },
				}),
			),
		);
		expect(
			screen.getByRole("button", { name: "Testing..." }),
		).toBeDisabled();
		switchOrganization("org-second");
		await act(async () => finishList(savedList));
		await screen.findByRole("button", { name: "Test Connection" });
		expect(mocks.testSavedConnection).not.toHaveBeenCalled();
		expect(screen.queryByText("GitHub Connected")).not.toBeInTheDocument();
	});

	it("ignores an old token rejection that resolves after OAuth reconnect", async () => {
		let complete!: (result: unknown) => void;
		mocks.testSavedConnection
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						complete = resolve;
					}),
			)
			.mockResolvedValue({ success: true, status: "connected" });
		const user = userEvent.setup();
		renderPage();
		await screen.findByText("Workflow configured");
		await user.click(
			screen.getByRole("button", { name: "Test Connection" }),
		);
		await act(async () =>
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					data: { type: "github_oauth_success" },
				}),
			),
		);
		await act(async () =>
			complete({
				success: false,
				status: "reconnect_required",
				error: "Old token rejected",
			}),
		);
		expect(
			screen.queryByText("Old token rejected"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Reconnect required"),
		).not.toBeInTheDocument();
		await screen.findByText("GitHub Connected");
		expect(
			screen.getByRole("button", { name: "Test Connection" }),
		).toBeEnabled();
	});
	it("does not report a successful old check after intentional disconnect", async () => {
		let complete!: (result: unknown) => void;
		mocks.testSavedConnection.mockImplementation(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		mocks.githubDisconnect.mockResolvedValue({ success: true });
		const user = userEvent.setup();
		renderPage();
		await screen.findByText("Workflow configured");
		await user.click(
			screen.getByRole("button", { name: "Test Connection" }),
		);
		mocks.list.mockResolvedValue({ integrations: [] });
		mocks.githubStatus.mockResolvedValue({ connected: false });
		await user.click(screen.getByRole("button", { name: "Disconnect" }));
		await screen.findByRole("button", { name: "Connect GitHub Account" });
		await act(async () =>
			complete({
				success: true,
				status: "connected",
				message: "Old connection worked",
			}),
		);
		expect(
			screen.queryByText("Connection Successful"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Old connection worked"),
		).not.toBeInTheDocument();
	});
});
