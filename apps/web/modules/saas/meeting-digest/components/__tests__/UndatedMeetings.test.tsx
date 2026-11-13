/**
 * @vitest-environment jsdom
 */

/**
 * Meetings with no known date (Fizzy #3507, FR13 and FR16): listed apart from
 * the calendar, opened like any meeting, and given a date or a corrected title
 * by someone who may change the digest. A date is stored at noon UTC so the
 * day is the same for every viewer.
 */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { meetingDigest: { updateMeetingDetails: mocks.update } },
	},
}));

import { MeetingDetailsDialog } from "../MeetingDetailsDialog";
import { UndatedMeetingsSection } from "../UndatedMeetingsSection";

const MEETING = {
	id: "record-1",
	// The key getMeeting reads, not the row id.
	transcriptId: "transcript-1",
	linkedMeetingId: "series-1",
	meetingSubject: "Retro notes",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.update.mockResolvedValue({});
});

afterEach(() => {
	cleanup();
});

describe("UndatedMeetingsSection", () => {
	it("lists meetings without a date under Unknown date, and opens them", () => {
		const onSelect = vi.fn();
		render(
			<UndatedMeetingsSection meetings={[MEETING]} onSelect={onSelect} />,
		);

		expect(
			screen.getByRole("region", { name: "Unknown date" }),
		).toHaveTextContent("Retro notes");
		fireEvent.click(screen.getByRole("button", { name: "Retro notes" }));
		expect(onSelect).toHaveBeenCalledWith("transcript-1");
		expect(screen.queryByRole("button", { name: "Set date" })).toBeNull();
	});

	it("offers to set a date to someone who may change the digest", () => {
		const onSetDate = vi.fn();
		render(
			<UndatedMeetingsSection
				meetings={[MEETING]}
				onSelect={vi.fn()}
				onSetDate={onSetDate}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Set date" }));
		expect(onSetDate).toHaveBeenCalledWith(MEETING);
	});

	it("renders nothing when every meeting has a date", () => {
		const { container } = render(
			<UndatedMeetingsSection meetings={[]} onSelect={vi.fn()} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("MeetingDetailsDialog", () => {
	function renderDialog(meetingDate: string | null = null) {
		const onSaved = vi.fn();
		const onClose = vi.fn();
		render(
			<MeetingDetailsDialog
				projectId="project-1"
				organizationId="org-1"
				target={{
					transcriptId: "transcript-1",
					subject: "Retro notes",
					meetingDate,
				}}
				onClose={onClose}
				onSaved={onSaved}
			/>,
		);
		return { onSaved, onClose };
	}

	it("gives a meeting its date, at noon UTC, and a corrected title", async () => {
		const { onSaved, onClose } = renderDialog();
		fireEvent.change(screen.getByLabelText("Title"), {
			target: { value: "Sprint 12 retro" },
		});
		fireEvent.change(screen.getByLabelText("Date"), {
			target: { value: "2026-10-21" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(mocks.update).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				transcriptId: "transcript-1",
				meetingSubject: "Sprint 12 retro",
				meetingDate: new Date("2026-10-21T12:00:00.000Z"),
			}),
		);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(onSaved).toHaveBeenCalled();
	});

	it("keeps an unknown date unknown when left empty", async () => {
		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		// Not sent at all: an unchanged unknown date stays unknown.
		await waitFor(() => expect(mocks.update).toHaveBeenCalled());
		expect(mocks.update.mock.calls[0]?.[0]).not.toHaveProperty(
			"meetingDate",
		);
	});

	it("keeps a meeting's real start time when only the title changes", async () => {
		renderDialog("2026-03-04T09:37:12.345Z");
		fireEvent.change(screen.getByLabelText("Title"), {
			target: { value: "Sprint 12 retro" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(mocks.update).toHaveBeenCalled());
		expect(mocks.update.mock.calls[0]?.[0]).not.toHaveProperty(
			"meetingDate",
		);
	});

	it("starts from the meeting's own date", () => {
		renderDialog("2026-03-04T12:00:00.000Z");
		expect(screen.getByLabelText("Date")).toHaveValue("2026-03-04");
	});

	it("will not save an empty title", () => {
		renderDialog();
		fireEvent.change(screen.getByLabelText("Title"), {
			target: { value: "  " },
		});
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});
});
