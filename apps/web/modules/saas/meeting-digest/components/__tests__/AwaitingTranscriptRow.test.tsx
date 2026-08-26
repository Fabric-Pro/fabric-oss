import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AwaitingMeeting } from "../../lib/types";
import {
	AwaitingAgendaRow,
	AwaitingCalendarBadge,
} from "../AwaitingTranscriptRow";
import { AWAITING_PRESENTATION } from "../awaiting-presentation";

const meeting: AwaitingMeeting = {
	linkedMeetingId: "lm1",
	subject: "Fabric DSU",
	occurrenceStart: new Date("2026-07-15T09:00:00Z"),
};

describe("AwaitingCalendarBadge", () => {
	it("shows the subject and the awaiting-transcript accessible name", () => {
		render(<AwaitingCalendarBadge meeting={meeting} />);
		expect(screen.getByText("Fabric DSU")).toBeInTheDocument();
		expect(
			screen.getByLabelText("Awaiting transcript"),
		).toBeInTheDocument();
	});

	it("is inert — it renders no button", () => {
		const { container } = render(
			<AwaitingCalendarBadge meeting={meeting} />,
		);
		expect(container.querySelector("button")).toBeNull();
	});

	it("falls back to a placeholder when the subject is null", () => {
		render(
			<AwaitingCalendarBadge meeting={{ ...meeting, subject: null }} />,
		);
		expect(screen.getByText("Untitled meeting")).toBeInTheDocument();
	});

	it("shows the visible text marker, matching PersonalCalendarBadge (#2104)", () => {
		render(<AwaitingCalendarBadge meeting={meeting} />);
		expect(
			screen.getByText(AWAITING_PRESENTATION.badge),
		).toBeInTheDocument();
	});

	// Mirrors PersonalCalendarBadge exactly, as this pair must: sharing one
	// line, the marker left the subject ~5 characters in a 1280px window.
	it("gives the subject a line of its own, with the marker beneath it", () => {
		render(<AwaitingCalendarBadge meeting={meeting} />);

		const subject = screen.getByText("Fabric DSU");
		const marker = screen.getByText(AWAITING_PRESENTATION.badge);

		// Nothing shares the subject's line, and the marker is the element
		// directly after that line rather than inside it.
		expect(subject.parentElement?.contains(marker)).toBe(false);
		expect(marker.previousElementSibling?.contains(subject)).toBe(true);
	});
});

describe("AwaitingAgendaRow", () => {
	it("shows the subject and the Not synced yet badge", () => {
		render(<AwaitingAgendaRow meeting={meeting} />);
		expect(screen.getByText("Fabric DSU")).toBeInTheDocument();
		expect(screen.getByText("Not synced yet")).toBeInTheDocument();
	});

	it("is inert — it renders no button", () => {
		const { container } = render(<AwaitingAgendaRow meeting={meeting} />);
		expect(container.querySelector("button")).toBeNull();
	});
});
