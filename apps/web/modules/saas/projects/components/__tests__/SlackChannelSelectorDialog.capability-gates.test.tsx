/**
 * Adding Slack channels refreshes the capability gates (Fizzy #1930).
 *
 * The dialog adds each channel through a direct client call rather than a
 * `useMutation`, so the app's central "refresh gates after any mutation" hook
 * never sees it, and a Context-tab gate kept describing the project as it was
 * before the channel arrived. This pins the dialog's own refresh.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		invalidateQueries: vi.fn(),
		create: vi.fn(),
		linkChannel: vi.fn(),
		enable: vi.fn(),
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
	useQuery: () => ({ data: { contexts: [] } }),
	useInfiniteQuery: () => ({
		data: {
			pages: [
				{
					channels: [
						{
							id: "C_EXAMPLE",
							name: "product",
							topic: "",
							purpose: "",
							isPrivate: false,
							memberCount: 3,
						},
					],
					isConnected: true,
				},
			],
		},
		isLoading: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
	}),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org_example" }),
	useContextPath: (path: string) => `/app/example-org/${path}`,
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (url: string) => url,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryOptions: () => ({}),
					queryKey: () => ["contexts"],
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				create: mocks.create,
				listAvailableSlackChannels: vi.fn(),
			},
			slackChannelMonitor: {
				linkChannel: mocks.linkChannel,
				enable: mocks.enable,
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

import { SlackChannelSelectorDialog } from "../SlackChannelSelectorDialog";

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	mocks.create.mockResolvedValue({ id: "context_example" });
	mocks.linkChannel.mockResolvedValue({});
	mocks.enable.mockResolvedValue({});
});

describe("SlackChannelSelectorDialog — capability gates", () => {
	it("refreshes the gates after adding channels", async () => {
		const user = userEvent.setup();
		render(
			<SlackChannelSelectorDialog
				projectId="project_example"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(await screen.findByRole("checkbox"));
		await user.click(
			screen.getByRole("button", { name: /add 1 channel/i }),
		);

		await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
		expect(mocks.invalidateQueries).toHaveBeenCalledWith({
			queryKey: ["capability-gates"],
		});
	});
});
