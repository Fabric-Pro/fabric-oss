import { describe, expect, it } from "vitest";
import { agendaActionLabel } from "../UpcomingMeetingsSection";

/**
 * The row button opens the agenda sheet in every state, so its label is the
 * only thing telling the user whether an agenda already exists. It previously
 * read "Generate agenda" even beside a row flagged "Agenda ready", which
 * described neither the state nor the action.
 */
describe("agendaActionLabel", () => {
	it("offers generation only when no agenda exists yet", () => {
		expect(agendaActionLabel(null)).toBe("Generate agenda");
	});

	it("offers to view an agenda that is ready", () => {
		expect(agendaActionLabel("READY")).toBe("View agenda");
	});

	it("offers to view an agenda still generating", () => {
		// The sheet shows progress, so opening it is still the useful action.
		expect(agendaActionLabel("GENERATING")).toBe("View agenda");
	});

	it("offers a retry on a failed agenda", () => {
		// A failed row exists but has no content to view; the sheet opens on
		// the error with a retry, which is the only action worth naming.
		expect(agendaActionLabel("FAILED")).toBe("Retry agenda");
	});

	it("never claims an agenda can be generated once one exists", () => {
		for (const status of ["READY", "GENERATING", "FAILED"] as const) {
			expect(agendaActionLabel(status)).not.toBe("Generate agenda");
		}
	});
});
