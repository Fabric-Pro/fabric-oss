/**
 * Deleting an entry from the day view keeps keyboard focus on the page.
 *
 * The edited row and its Delete button leave with the entry, so focus moves
 * to the day's entry list instead of falling to the page body.
 */

import type {
	LoggableProject,
	TimeEntry,
} from "@saas/time-tracking/lib/time-entry-model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDelete } = vi.hoisted(() => ({ mockDelete: vi.fn() }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		timeTracking: {
			createEntry: { call: vi.fn() },
			updateEntry: { call: vi.fn() },
			deleteEntry: { call: mockDelete },
			listEntries: { key: () => [["timeTracking", "listEntries"], {}] },
			listForStory: { key: () => [["timeTracking", "listForStory"], {}] },
		},
		projects: {
			stories: {
				board: {
					queryOptions: (options: { input: unknown }) => ({
						queryKey: [
							["projects", "stories", "board"],
							{ input: options.input, type: "query" },
						],
						queryFn: async () => ({ statuses: [], stories: [] }),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			values ? `${key} ${JSON.stringify(values)}` : key;
		t.raw = (key: string) => key;
		t.has = () => false;
		return t;
	},
	useLocale: () => "en",
}));

import { DayView } from "@saas/time-tracking/components/DayView";

const project: LoggableProject = {
	id: "project-a",
	name: "Alpha",
	billingModel: "TIME_AND_MATERIALS",
	startStopRequired: false,
	defaultBillable: true,
};

const entry: TimeEntry = {
	id: "entry-1",
	projectId: "project-a",
	projectName: "Alpha",
	workDate: "2026-11-11",
	timezone: "Europe/Berlin",
	durationMinutes: 15,
	startAt: null,
	stopAt: null,
	activity: "DEVELOPMENT",
	billable: true,
	description: null,
	storyId: null,
	storyIdentifier: null,
	storyTitle: null,
	startStopRequired: false,
	createdAt: "2026-11-11T08:00:00.000Z",
	updatedAt: "2026-11-11T08:00:00.000Z",
};

function renderDay() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
	return render(
		<DayView
			organizationId="org-1"
			date="2026-11-11"
			today="2026-11-11"
			weekDates={[
				"2026-11-09",
				"2026-11-10",
				"2026-11-11",
				"2026-11-12",
				"2026-11-13",
				"2026-11-14",
				"2026-11-15",
			]}
			entries={[entry]}
			projects={[project]}
			timeZone="Europe/Berlin"
			focusToken={0}
			onSelectDate={vi.fn()}
		/>,
		{ wrapper },
	);
}

beforeEach(() => {
	mockDelete.mockReset();
	// Answers after the dialog has closed and handed focus back to its
	// trigger, as a real request does.
	mockDelete.mockImplementation(
		() =>
			new Promise((resolve) => {
				setTimeout(() => resolve({ deleted: true }), 20);
			}),
	);
});

describe("DayView", () => {
	it("moves focus to the day's entry list once an entry is deleted", async () => {
		const user = userEvent.setup();
		renderDay();

		await user.click(screen.getByRole("button", { name: /^edit / }));
		await user.click(screen.getByRole("button", { name: "action" }));
		const dialog = await screen.findByRole("alertdialog");
		within(dialog).getByRole("button", { name: "confirm" }).focus();
		await user.keyboard("{Enter}");

		const list = screen.getByRole("region", { name: /^entriesFor / });
		await waitFor(() => expect(list).toHaveFocus());
		expect(mockDelete).toHaveBeenCalledWith({ entryId: "entry-1" });
	});
});
