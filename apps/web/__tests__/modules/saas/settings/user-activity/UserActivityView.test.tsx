/**
 * Tests for the UserActivityView client component.
 * Coverage: member rows render with relative last-active/last-sign-in;
 * "Never signed in" / "Never active" zero states; range switch
 * refetches with the new rangeDays; API failure surfaces the inline
 * error state (AC-8); empty result shows the empty state.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListMembers } = vi.hoisted(() => ({
	mockListMembers: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		userActivity: {
			listMembers: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["user-activity", "listMembers", opts.input],
					queryFn: () => mockListMembers(opts.input),
				}),
			},
			memberHistory: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["user-activity", "memberHistory", opts.input],
					queryFn: () => Promise.resolve(null),
				}),
			},
		},
	},
}));

import { UserActivityView } from "@saas/settings/components/user-activity/UserActivityView";

function renderView() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<UserActivityView organizationId="org-1" />
		</QueryClientProvider>,
	);
}

const ROWS = {
	items: [
		{
			userId: "u1",
			name: "Ada Lovelace",
			email: "ada@x.com",
			image: null,
			role: "admin",
			lastSeenAt: new Date("2026-07-23T09:00:00.000Z").toISOString(),
			lastLoginAt: new Date("2026-07-01T08:00:00.000Z").toISOString(),
			loginCountInRange: 5,
		},
		{
			userId: "u2",
			name: "Grace Hopper",
			email: "grace@x.com",
			image: null,
			role: "member",
			lastSeenAt: null,
			lastLoginAt: null,
			loginCountInRange: 0,
		},
	],
	total: 2,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("UserActivityView", () => {
	it("renders member rows with last login and count", async () => {
		mockListMembers.mockResolvedValue(ROWS);
		renderView();
		expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
		expect(screen.getByText("ada@x.com")).toBeInTheDocument();
		expect(screen.getByText("5")).toBeInTheDocument();
	});

	it("shows the never-signed-in zero state (FR-2)", async () => {
		mockListMembers.mockResolvedValue(ROWS);
		renderView();
		expect(await screen.findByText("Never signed in")).toBeInTheDocument();
	});

	it("refetches with the selected range (FR-4/FR-5)", async () => {
		mockListMembers.mockResolvedValue(ROWS);
		renderView();
		await screen.findByText("Ada Lovelace");
		await userEvent.click(
			screen.getByRole("button", { name: "Last 7 days" }),
		);
		await waitFor(() => {
			expect(mockListMembers).toHaveBeenCalledWith(
				expect.objectContaining({ rangeDays: 7 }),
			);
		});
	});

	it("surfaces an error state instead of a blank page (AC-8)", async () => {
		mockListMembers.mockRejectedValue(new Error("boom"));
		renderView();
		expect(
			await screen.findByText("Could not load member activity."),
		).toBeInTheDocument();
	});

	it("shows an empty state when no members match", async () => {
		mockListMembers.mockResolvedValue({ items: [], total: 0 });
		renderView();
		expect(
			await screen.findByText("No members found."),
		).toBeInTheDocument();
	});

	it("resets to page 1 when the sort direction is toggled", async () => {
		mockListMembers.mockResolvedValue(ROWS);
		renderView();
		await screen.findByText("Ada Lovelace");
		await userEvent.click(
			screen.getByRole("button", { name: /Sort by last active/ }),
		);
		await waitFor(() => {
			expect(mockListMembers).toHaveBeenCalledWith(
				expect.objectContaining({ sortDir: "asc", offset: 0 }),
			);
		});
	});

	it("shows a Last active column alongside sign-ins (#1709)", async () => {
		mockListMembers.mockResolvedValue(ROWS);
		renderView();
		await screen.findByText("Ada Lovelace");

		expect(
			screen.getByRole("button", { name: /Sort by last active/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("columnheader", { name: "Last sign-in" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("columnheader", { name: "Sign-ins" }),
		).toBeInTheDocument();
	});

	it("shows 'Never active' rather than falling back to the sign-in date", async () => {
		mockListMembers.mockResolvedValue({
			items: [
				{
					...ROWS.items[0],
					lastSeenAt: null,
					lastLoginAt: new Date(
						"2026-07-01T08:00:00.000Z",
					).toISOString(),
				},
			],
			total: 1,
		});
		renderView();

		expect(await screen.findByText("Never active")).toBeInTheDocument();
	});
});

describe("UserActivityView — search field attributes", () => {
	it("gives the member search input a name and id for form tooling", async () => {
		renderView();
		const input = await screen.findByPlaceholderText("Search members…");
		expect(input).toHaveAttribute("name", "member-search");
		expect(input).toHaveAttribute("id", "member-search");
	});
});
