import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgendaStatusIndicator } from "../AgendaStatusIndicator";

describe("AgendaStatusIndicator (#2106 FR3)", () => {
	it("reports a ready agenda", () => {
		render(
			<AgendaStatusIndicator
				linkedMeetingId="lm_1"
				agendaStatus="READY"
			/>,
		);

		expect(
			screen.getByRole("img", { name: "Agenda ready" }),
		).toBeInTheDocument();
	});

	it("reports an agenda still generating", () => {
		render(
			<AgendaStatusIndicator
				linkedMeetingId="lm_1"
				agendaStatus="GENERATING"
			/>,
		);

		expect(
			screen.getByRole("img", { name: "Agenda generating" }),
		).toBeInTheDocument();
	});

	it("reports a failed generation rather than showing it as simply missing", () => {
		render(
			<AgendaStatusIndicator
				linkedMeetingId="lm_1"
				agendaStatus="FAILED"
			/>,
		);

		expect(
			screen.getByRole("img", { name: "Agenda generation failed" }),
		).toBeInTheDocument();
	});

	it("reports a linked meeting with no agenda yet", () => {
		render(
			<AgendaStatusIndicator
				linkedMeetingId="lm_1"
				agendaStatus={null}
			/>,
		);

		expect(
			screen.getByRole("img", { name: "No agenda yet" }),
		).toBeInTheDocument();
	});

	// D4: an unlinked meeting is exactly a private one with no database row. An
	// empty checkbox would claim the agenda is merely missing, when in fact it
	// cannot exist until the meeting is linked.
	it("distinguishes an unlinked meeting from one that simply has no agenda", () => {
		render(
			<AgendaStatusIndicator
				linkedMeetingId={null}
				agendaStatus={null}
			/>,
		);

		expect(
			screen.getByRole("img", {
				name: "Not tracked — link this meeting to generate an agenda",
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: "No agenda yet" }),
		).not.toBeInTheDocument();
	});

	it("ignores a stale agenda status on an unlinked meeting", () => {
		// Defensive: the server always sends null here, but the component must
		// not render "ready" for a meeting the user cannot open an agenda for.
		render(
			<AgendaStatusIndicator
				linkedMeetingId={null}
				agendaStatus="READY"
			/>,
		);

		expect(
			screen.queryByRole("img", { name: "Agenda ready" }),
		).not.toBeInTheDocument();
	});
});
