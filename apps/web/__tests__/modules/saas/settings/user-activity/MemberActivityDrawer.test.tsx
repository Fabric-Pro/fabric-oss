/**
 * Tests for MemberActivityDrawer. recharts renders
 * zero-size in jsdom, so assertions target text content (member
 * identity, totals, event rows, empty state), not SVG internals.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockMemberHistory } = vi.hoisted(() => ({
	mockMemberHistory: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		userActivity: {
			memberHistory: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["user-activity", "memberHistory", opts.input],
					queryFn: () => mockMemberHistory(opts.input),
				}),
			},
		},
	},
}));

import { MemberActivityDrawer } from "@saas/settings/components/user-activity/MemberActivityDrawer";

function renderDrawer(userId: string | null) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<MemberActivityDrawer
				organizationId="org-1"
				userId={userId}
				rangeDays={30}
				onClose={vi.fn()}
			/>
		</QueryClientProvider>,
	);
}

const HISTORY = {
	user: {
		id: "u1",
		name: "Ada Lovelace",
		email: "ada@example.com",
		image: null,
	},
	role: "admin",
	lastSeenAt: new Date("2026-07-23T09:00:00.000Z").toISOString(),
	buckets: [
		{ day: "2026-07-01", count: 2 },
		{ day: "2026-07-02", count: 1 },
	],
	totalLoginsInRange: 3,
	recentEvents: [
		{
			action: "auth.login.success",
			createdAt: new Date("2026-07-02T08:00:00.000Z").toISOString(),
			ipAddress: "10.0.0.1",
			userAgent: "Mozilla/5.0 (Macintosh)",
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("MemberActivityDrawer", () => {
	it("fetches nothing while closed", () => {
		renderDrawer(null);
		expect(mockMemberHistory).not.toHaveBeenCalled();
	});

	it("keeps the chart container un-shrinkable so recharts can measure it", async () => {
		mockMemberHistory.mockResolvedValue(HISTORY);
		const { container } = renderDrawer("u1");
		await screen.findByText("Ada Lovelace");
		// Regression (staging): inside the sheet's flex-col overflow body the
		// empty chart div collapsed to 0 height and recharts rendered nothing.
		const chartHost = container.ownerDocument.querySelector(".h-48");
		expect(chartHost).not.toBeNull();
		expect(chartHost?.className).toContain("shrink-0");
	});

	it("exposes an accessible title while loading", () => {
		mockMemberHistory.mockReturnValue(new Promise(() => {}));
		renderDrawer("u1");
		// Radix requires DialogTitle/Description in every open state — the
		// skeleton-only loading branch used to log a11y errors.
		expect(
			screen.getByText("Login history", { selector: "h2" }),
		).toBeInTheDocument();
	});

	it("renders the member identity, total, and recent events", async () => {
		mockMemberHistory.mockResolvedValue(HISTORY);
		renderDrawer("u1");
		expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
		expect(
			screen.getByText(/3 sign-ins in the last 30 days/),
		).toBeInTheDocument();
		expect(screen.getByText("10.0.0.1")).toBeInTheDocument();
	});

	it("shows the empty state when there is no activity in range (AC-6)", async () => {
		mockMemberHistory.mockResolvedValue({
			...HISTORY,
			buckets: HISTORY.buckets.map((b) => ({ ...b, count: 0 })),
			totalLoginsInRange: 0,
			recentEvents: [],
		});
		renderDrawer("u1");
		expect(
			await screen.findByText("No sign-ins in this period."),
		).toBeInTheDocument();
	});

	it("shows last active above the sign-in count (#1709)", async () => {
		mockMemberHistory.mockResolvedValue(HISTORY);
		renderDrawer("u1");
		expect(await screen.findByText(/Last active/)).toBeInTheDocument();
		expect(
			await screen.findByText(/sign-ins in the last/),
		).toBeInTheDocument();
	});

	it("shows 'Never active' when lastSeenAt is null but user has logins (#1709)", async () => {
		mockMemberHistory.mockResolvedValue({
			...HISTORY,
			lastSeenAt: null,
			totalLoginsInRange: 3,
		});
		renderDrawer("u1");
		expect(await screen.findByText(/Never active/)).toBeInTheDocument();
		expect(
			screen.getByText(/3 sign-ins in the last 30 days/),
		).toBeInTheDocument();
	});

	it("surfaces an error state instead of a blank drawer (AC-8)", async () => {
		mockMemberHistory.mockRejectedValue(new Error("boom"));
		renderDrawer("u1");
		expect(
			await screen.findByText("Could not load login history."),
		).toBeInTheDocument();
	});

	it("renders event badges, user agent, and IP fallback", async () => {
		mockMemberHistory.mockResolvedValue({
			...HISTORY,
			recentEvents: [
				...HISTORY.recentEvents,
				{
					action: "auth.logout",
					createdAt: new Date(
						"2026-07-01T17:00:00.000Z",
					).toISOString(),
					ipAddress: null,
					userAgent: null,
				},
			],
		});
		renderDrawer("u1");
		expect(await screen.findByText("Login")).toBeInTheDocument();
		expect(screen.getByText("Logout")).toBeInTheDocument();
		expect(screen.getByText("Mozilla/5.0 (Macintosh)")).toBeInTheDocument();
		expect(screen.getByText("IP unknown")).toBeInTheDocument();
	});
});
