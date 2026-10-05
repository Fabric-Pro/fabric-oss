/**
 * The wizard's GitLab repository picker says what the server's connection
 * service says about the person's GitLab connection — connected, needs
 * reconnecting, not connected — instead of reading "not connected" off a
 * listing that came back empty. A connection that needs reconnecting offers
 * Reconnect (the personal GitLab OAuth start), and a listing that failed is
 * an error with a retry, not a missing connection.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
});

const { listReposMock, gitlabStartMock } = vi.hoisted(() => ({
	listReposMock: vi.fn(),
	gitlabStartMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			gitlab: { listRepos: (input: unknown) => listReposMock(input) },
		},
		integrations: {
			gitlab: { start: (input: unknown) => gitlabStartMock(input) },
		},
	},
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: (path: string) => `/app/example-org/${path}`,
}));
vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (path: string) => path,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { GitLabProjectPicker } from "../GitLabProjectPicker";

function renderPicker() {
	return render(
		<GitLabProjectPicker
			open
			onOpenChange={() => {}}
			organizationId="example-org"
			onConfirm={() => {}}
		/>,
	);
}

const noProjects = {
	username: null,
	groups: [],
};

beforeEach(() => {
	listReposMock.mockReset();
	gitlabStartMock.mockReset();
	vi.stubGlobal("open", vi.fn());
});

describe("GitLabProjectPicker — the connection notice", () => {
	it("offers Reconnect, not 'Not Connected', when the connection needs reconnecting", async () => {
		listReposMock.mockResolvedValue({
			...noProjects,
			configured: false,
			connectionState: "needs-reconnect",
			error: "Your GitLab connection needs to be reconnected.",
		});
		gitlabStartMock.mockResolvedValue({
			authorizationUrl: "https://gitlab.com/oauth/authorize?state=x",
		});

		renderPicker();

		expect(
			await screen.findByText("GitLab Needs Reconnecting"),
		).toBeInTheDocument();
		expect(screen.queryByText("GitLab Not Connected")).toBeNull();

		await userEvent.click(
			screen.getByRole("button", { name: /Reconnect GitLab/ }),
		);
		await waitFor(() =>
			expect(gitlabStartMock).toHaveBeenCalledWith(
				expect.objectContaining({ organizationId: "example-org" }),
			),
		);
		expect(window.open).toHaveBeenCalledWith(
			"https://gitlab.com/oauth/authorize?state=x",
			"gitlab-oauth",
			expect.any(String),
		);
	});

	it("says 'Not Connected' when there is no connection", async () => {
		listReposMock.mockResolvedValue({
			...noProjects,
			configured: false,
			connectionState: "not-connected",
			error: "GitLab not connected.",
		});

		renderPicker();

		expect(
			await screen.findByText("GitLab Not Connected"),
		).toBeInTheDocument();
		expect(screen.queryByText("GitLab Needs Reconnecting")).toBeNull();
	});

	it("shows a failed listing as an error with a retry, not as a missing connection", async () => {
		listReposMock.mockResolvedValue({
			...noProjects,
			configured: true,
			connectionState: "connected",
			error: "GitLab could not be reached with your connection. Try again.",
		});

		renderPicker();

		expect(
			await screen.findByText("Failed to load projects"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Try Again" }),
		).toBeInTheDocument();
		expect(screen.queryByText("GitLab Not Connected")).toBeNull();
		expect(screen.queryByText("GitLab Needs Reconnecting")).toBeNull();
	});

	it("after a reconnect, a listing that then fails shows the failure, not the expired connection", async () => {
		listReposMock.mockResolvedValueOnce({
			...noProjects,
			configured: false,
			connectionState: "needs-reconnect",
			error: "Your GitLab connection needs to be reconnected.",
		});
		renderPicker();
		expect(
			await screen.findByText("GitLab Needs Reconnecting"),
		).toBeInTheDocument();

		// The reconnect succeeded; the listing that follows fails once.
		listReposMock.mockResolvedValueOnce({
			...noProjects,
			configured: true,
			connectionState: "connected",
			error: "GitLab could not be reached with your connection. Try again.",
		});
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					data: { type: "gitlab_oauth_success" },
				}),
			);
		});

		expect(
			await screen.findByText("Failed to load projects"),
		).toBeInTheDocument();
		expect(screen.queryByText("GitLab Needs Reconnecting")).toBeNull();
		expect(screen.queryByText("GitLab Not Connected")).toBeNull();
	});

	it("a group search applies the connection state before its own error", async () => {
		listReposMock.mockResolvedValueOnce({
			configured: true,
			connectionState: "connected",
			username: "dev",
			groups: [
				{
					owner: "dev",
					ownerType: "user",
					repos: [
						{
							id: 1,
							name: "app",
							fullName: "dev/app",
							description: null,
							private: true,
							defaultBranch: "main",
							updatedAt: "2026-01-01T00:00:00Z",
							language: null,
							url: "https://gitlab.com/dev/app",
						},
					],
				},
			],
		});
		renderPicker();
		const groupInput =
			await screen.findByPlaceholderText(/Enter group name/);

		// The connection lapsed between the listing and the search.
		listReposMock.mockResolvedValueOnce({
			...noProjects,
			configured: false,
			connectionState: "needs-reconnect",
			error: "Your GitLab connection needs to be reconnected.",
		});
		await userEvent.type(groupInput, "example-group");
		await userEvent.click(
			screen.getByRole("button", { name: /Add Group/ }),
		);

		expect(
			await screen.findByText("GitLab Needs Reconnecting"),
		).toBeInTheDocument();
	});
});
