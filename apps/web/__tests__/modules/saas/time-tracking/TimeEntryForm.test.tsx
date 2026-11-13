/**
 * The entry line's save round with the server.
 *
 * A save the server finds suspicious comes back `needs_confirmation` and the
 * form asks one inline question. "Yes" must resend the same entry with the
 * warning acknowledged, and "No, skip" must not save anything: a new entry
 * drops what was typed for it, and an edit is abandoned as Cancel does. A
 * project that requires start and stop swaps the duration for two times.
 */

import { parseDurationInput } from "@repo/utils/time-tracking";
import type {
	LoggableProject,
	TimeEntry,
} from "@saas/time-tracking/lib/time-entry-model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate, mockUpdate, mockToastSuccess, mockToastError } = vi.hoisted(
	() => ({
		mockCreate: vi.fn(),
		mockUpdate: vi.fn(),
		mockToastSuccess: vi.fn(),
		mockToastError: vi.fn(),
	}),
);

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		timeTracking: {
			createEntry: { call: mockCreate },
			updateEntry: { call: mockUpdate },
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
	toast: Object.assign(vi.fn(), {
		success: mockToastSuccess,
		error: mockToastError,
	}),
}));

// Echo interpolation values so the question's duration is assertable.
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

import { TimeEntryForm } from "@saas/time-tracking/components/TimeEntryForm";
import { emptyDraft } from "@saas/time-tracking/lib/entry-draft";

const project: LoggableProject = {
	id: "project-a",
	name: "Alpha",
	billingModel: "FIXED_BID",
	startStopRequired: false,
	defaultBillable: true,
};

const existing: TimeEntry = {
	id: "entry-1",
	projectId: "project-a",
	projectName: "Alpha",
	workDate: "2026-11-11",
	timezone: "Europe/Berlin",
	durationMinutes: 90,
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

function renderForm(
	projects = [project],
	props: Partial<ComponentProps<typeof TimeEntryForm>> = {},
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
	return render(
		<TimeEntryForm
			organizationId="org-1"
			projects={projects}
			initialDraft={emptyDraft({
				projectId: "project-a",
				activity: "DEVELOPMENT",
				workDate: "2026-11-11",
				timezone: "Europe/Berlin",
			})}
			knownEntries={[existing]}
			{...props}
		/>,
		{ wrapper },
	);
}

beforeEach(() => {
	mockCreate.mockReset();
	mockUpdate.mockReset();
	mockToastSuccess.mockReset();
	mockToastError.mockReset();
});

describe("TimeEntryForm", () => {
	it("submits the typed duration when Enter is pressed", async () => {
		mockCreate.mockResolvedValue({
			status: "saved",
			entry: { ...existing, id: "entry-2" },
			warnings: [],
		});
		renderForm();

		await userEvent.type(screen.getByLabelText("duration"), "45m{Enter}");

		await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
		expect(mockCreate.mock.calls[0][0]).toMatchObject({
			projectId: "project-a",
			workDate: "2026-11-11",
			timezone: "Europe/Berlin",
			activity: "DEVELOPMENT",
			durationMinutes: 45,
			acknowledgedWarnings: [],
		});
		await waitFor(() =>
			expect(mockToastSuccess).toHaveBeenCalledWith("added"),
		);
		expect(screen.getByLabelText("duration")).toHaveValue("");
	});

	it("offers common durations on the duration field, each one it can read back", () => {
		renderForm();

		const input = screen.getByLabelText("duration");
		const listId = input.getAttribute("list");
		expect(listId).toBeTruthy();
		const list = document.getElementById(listId ?? "");
		expect(list?.tagName).toBe("DATALIST");
		const values = Array.from(
			list?.querySelectorAll("option") ?? [],
			(option) => option.value,
		);
		expect(values).toEqual([
			"15m",
			"30m",
			"45m",
			"1h",
			"1h 30m",
			"2h",
			"3h",
			"4h",
			"8h",
		]);
		expect(values.map(parseDurationInput)).toEqual([
			15, 30, 45, 60, 90, 120, 180, 240, 480,
		]);
	});

	it("saves the entry in the time zone the user picks", async () => {
		mockCreate.mockResolvedValue({
			status: "saved",
			entry: { ...existing, id: "entry-2", timezone: "Asia/Tokyo" },
			warnings: [],
		});
		renderForm();

		await userEvent.click(screen.getByRole("button", { name: "more" }));
		const zone = screen.getByRole("combobox", { name: "timeZone" });
		expect(zone).toHaveTextContent("Europe/Berlin");
		await userEvent.click(zone);
		await userEvent.click(
			screen.getByRole("option", { name: "Asia/Tokyo" }),
		);
		await userEvent.type(screen.getByLabelText("duration"), "30m{Enter}");

		await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
		expect(mockCreate.mock.calls[0][0]).toMatchObject({
			timezone: "Asia/Tokyo",
			durationMinutes: 30,
		});
	});

	it("asks about a likely duplicate and resends with it acknowledged on yes", async () => {
		mockCreate
			.mockResolvedValueOnce({
				status: "needs_confirmation",
				warnings: [{ code: "LIKELY_DUPLICATE", entryIds: ["entry-1"] }],
			})
			.mockResolvedValueOnce({
				status: "saved",
				entry: { ...existing, id: "entry-2" },
				warnings: [],
			});
		renderForm();

		await userEvent.type(
			screen.getByLabelText("duration"),
			"1h 30m{Enter}",
		);

		const question = await screen.findByRole("alert");
		expect(question).toHaveTextContent('"duration":"1h 30m"');
		expect(question).toHaveTextContent('"activity":"Development"');
		expect(question).toHaveTextContent('"target":"Alpha"');
		expect(mockToastSuccess).not.toHaveBeenCalled();

		await userEvent.click(
			screen.getByRole("button", { name: "duplicateConfirm" }),
		);

		await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
		expect(mockCreate.mock.calls[1][0]).toMatchObject({
			durationMinutes: 90,
			acknowledgedWarnings: ["LIKELY_DUPLICATE"],
		});
		await waitFor(() =>
			expect(mockToastSuccess).toHaveBeenCalledWith("added"),
		);
	});

	it("saves nothing when the question is answered no", async () => {
		mockCreate.mockResolvedValueOnce({
			status: "needs_confirmation",
			warnings: [
				{
					code: "OVER_DAILY_LIMIT",
					totalMinutes: 1000,
					limitMinutes: 960,
				},
			],
		});
		renderForm();

		await userEvent.type(screen.getByLabelText("duration"), "8h{Enter}");
		const question = await screen.findByRole("alert");
		expect(question).toHaveTextContent('"total":"16h 40m"');

		await userEvent.click(screen.getByRole("button", { name: "skip" }));

		expect(screen.queryByRole("alert")).toBeNull();
		expect(mockCreate).toHaveBeenCalledTimes(1);
	});

	it("drops the typed entry on no, keeping project, activity, date and billable", async () => {
		mockCreate
			.mockResolvedValueOnce({
				status: "needs_confirmation",
				warnings: [{ code: "LIKELY_DUPLICATE", entryIds: ["entry-1"] }],
			})
			.mockResolvedValueOnce({
				status: "saved",
				entry: { ...existing, id: "entry-2" },
				warnings: [],
			});
		renderForm();

		await userEvent.click(screen.getByRole("button", { name: "more" }));
		await userEvent.type(screen.getByLabelText("note"), "Pairing");
		await userEvent.click(screen.getByLabelText("billable"));
		await userEvent.type(screen.getByLabelText("duration"), "1h{Enter}");
		await screen.findByRole("alert");

		await userEvent.click(screen.getByRole("button", { name: "skip" }));

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByLabelText("duration")).toHaveValue("");
		expect(screen.getByLabelText("note")).toHaveValue("");
		expect(screen.getByLabelText("billable")).not.toBeChecked();

		await userEvent.type(screen.getByLabelText("duration"), "30m{Enter}");

		await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
		expect(mockCreate.mock.calls[1][0]).toMatchObject({
			projectId: "project-a",
			workDate: "2026-11-11",
			activity: "DEVELOPMENT",
			durationMinutes: 30,
			billable: false,
			acknowledgedWarnings: [],
		});
		expect(mockCreate.mock.calls[1][0].description ?? null).toBeNull();
		expect(mockCreate.mock.calls[1][0].storyId ?? null).toBeNull();
	});

	it("keeps a work item fixed by the page it is logged from on no", async () => {
		mockCreate
			.mockResolvedValueOnce({
				status: "needs_confirmation",
				warnings: [{ code: "LIKELY_DUPLICATE", entryIds: ["entry-1"] }],
			})
			.mockResolvedValueOnce({
				status: "saved",
				entry: { ...existing, id: "entry-2" },
				warnings: [],
			});
		renderForm([project], {
			lockProjectAndItem: true,
			initialDraft: emptyDraft({
				projectId: "project-a",
				activity: "DEVELOPMENT",
				story: { id: "story-1", identifier: "F-001", title: "Sign-in" },
				workDate: "2026-11-11",
				timezone: "Europe/Berlin",
			}),
		});

		await userEvent.type(screen.getByLabelText("duration"), "1h{Enter}");
		await screen.findByRole("alert");
		await userEvent.click(screen.getByRole("button", { name: "skip" }));

		expect(screen.getByLabelText("duration")).toHaveValue("");
		await userEvent.type(screen.getByLabelText("duration"), "30m{Enter}");

		await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
		expect(mockCreate.mock.calls[1][0]).toMatchObject({
			storyId: "story-1",
			durationMinutes: 30,
		});
	});

	it("abandons an edit on no, as Cancel does", async () => {
		mockUpdate.mockResolvedValueOnce({
			status: "needs_confirmation",
			warnings: [
				{
					code: "OVER_DAILY_LIMIT",
					totalMinutes: 1000,
					limitMinutes: 960,
				},
			],
		});
		const onCancel = vi.fn();
		const onSaved = vi.fn();
		renderForm([project], {
			entry: existing,
			initialDraft: {
				...emptyDraft({
					projectId: "project-a",
					activity: "DEVELOPMENT",
					workDate: "2026-11-11",
					timezone: "Europe/Berlin",
				}),
				durationText: "1h 30m",
			},
			onCancel,
			onSaved,
		});

		const duration = screen.getByLabelText("duration");
		await userEvent.clear(duration);
		await userEvent.type(duration, "8h{Enter}");
		await screen.findByRole("alert");

		await userEvent.click(screen.getByRole("button", { name: "skip" }));

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSaved).not.toHaveBeenCalled();
		expect(mockUpdate).toHaveBeenCalledTimes(1);
	});

	it("explains an unreadable duration without calling the server", async () => {
		renderForm();

		await userEvent.type(screen.getByLabelText("duration"), "soon{Enter}");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"problems.duration",
		);
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("asks for start and stop times on a project that requires them", () => {
		renderForm([{ ...project, startStopRequired: true }]);

		expect(screen.queryByLabelText("duration")).toBeNull();
		expect(screen.getByLabelText("startTime")).toHaveAttribute(
			"type",
			"time",
		);
		expect(screen.getByLabelText("stopTime")).toHaveAttribute(
			"type",
			"time",
		);
		expect(screen.getByLabelText("stopDate")).toBeInTheDocument();
	});
});
