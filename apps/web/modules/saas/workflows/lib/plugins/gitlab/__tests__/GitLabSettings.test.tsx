/**
 * The workflow GitLab settings show the person's GitLab in the same three
 * states every GitLab screen reports (`gitlab.status`'s `state`). A
 * connection whose grant died keeps `connected: true` with
 * `state: "needs-reconnect"`; it must ask for a reconnect, never say
 * "GitLab Connected", and keep Disconnect reachable.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	status: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		integrations: {
			gitlab: {
				status: (...args: unknown[]) => mocks.status(...args),
				isConfigured: async () => ({ configured: true }),
				disconnect: vi.fn(),
				connectionState: vi.fn(),
				reconcile: vi.fn(),
				retryToolIngestion: vi.fn(),
				getAuthUrl: vi.fn(),
			},
		},
	},
}));

import { GitLabSettings } from "../GitLabSettings";

function renderSettings() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<GitLabSettings
				apiKey=""
				onApiKeyChange={vi.fn()}
				organizationId="example-org"
			/>
		</QueryClientProvider>,
	);
}

const baseStatus = {
	username: "example-user",
	name: "Example User",
	avatarUrl: null,
	connectedAt: null,
	settings: {},
};

beforeEach(() => {
	mocks.status.mockReset();
});

describe("GitLabSettings connection state", () => {
	it("asks for a reconnect, not 'GitLab Connected', when the grant died, and keeps Disconnect", async () => {
		mocks.status.mockResolvedValue({
			...baseStatus,
			connected: true,
			needsReauth: true,
			state: "needs-reconnect",
		});

		renderSettings();

		expect(
			await screen.findByText("GitLab needs to be reconnected"),
		).toBeInTheDocument();
		expect(screen.queryByText("GitLab Connected")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Disconnect GitLab" }),
		).toBeInTheDocument();
		expect(
			await screen.findByRole("button", { name: /Reconnect GitLab/ }),
		).toBeInTheDocument();
	});

	it("shows a working connection as connected", async () => {
		mocks.status.mockResolvedValue({
			...baseStatus,
			connected: true,
			needsReauth: false,
			state: "connected",
		});

		renderSettings();

		expect(await screen.findByText("GitLab Connected")).toBeInTheDocument();
		expect(
			screen.queryByText("GitLab needs to be reconnected"),
		).not.toBeInTheDocument();
	});

	it("offers a connect, with nothing to disconnect, when there is no connection", async () => {
		mocks.status.mockResolvedValue({
			...baseStatus,
			username: null,
			connected: false,
			needsReauth: false,
			state: "not-connected",
		});

		renderSettings();

		expect(
			await screen.findByRole("button", {
				name: /Connect GitLab Account/,
			}),
		).toBeInTheDocument();
		expect(screen.queryByText("GitLab Connected")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Disconnect GitLab" }),
		).not.toBeInTheDocument();
	});
});
