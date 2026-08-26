import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgendaBody } from "../AgendaSheet";

// "How this agenda was built" reported what data went in but never which prompt
// shaped it. Once the prompt became user-editable, an agenda's shape could
// change with no code change and nothing on screen said so — and a run that
// silently fell back to the built-in prompt looked identical to a healthy one.

const base = {
	id: "ag_1",
	occurrenceStart: "2026-07-25T09:00:00.000Z",
	generatedAt: "2026-07-24T12:00:00.000Z",
	generationError: null,
	editedAt: null,
	editedById: null,
	version: 1,
	status: "READY" as const,
	content: "## Agenda",
	// The expander only renders once the counts are present.
	contextStats: {
		hadPriorTranscripts: true,
		truncated: {},
		priorTranscriptCount: 3,
		priorMeetingWindowDays: 90,
	},
};

function renderAgenda(promptProvenance: unknown) {
	render(
		<AgendaBody
			agenda={{ ...base, promptProvenance } as never}
			canEdit
			stalled={false}
			onSave={vi.fn()}
		/>,
	);
}

describe("AgendaBody — prompt provenance", () => {
	it("names the prompt and version a bound run used", () => {
		renderAgenda({
			source: "BOUND",
			promptName: "Meeting Agenda Generator",
			promptVersion: 4,
			promptScope: "ORG",
			formatOverridden: false,
		});

		expect(
			screen.getByText(/Meeting Agenda Generator.*v4/i),
		).toBeInTheDocument();
	});

	it("says the built-in prompt was used when nothing is bound", () => {
		renderAgenda({ source: "DEFAULT_UNBOUND" });

		expect(screen.getByText(/built-in prompt/i)).toBeInTheDocument();
	});

	it("reports a bound prompt that could not render", () => {
		// The agenda still reads fine, so this is the only place the failure
		// becomes visible to the person who wrote the broken prompt.
		renderAgenda({
			source: "DEFAULT_RENDER_FAILED",
			promptName: "Meeting Agenda Generator",
			promptVersion: 5,
		});

		const line = screen.getByText(/could not be rendered/i);
		expect(line).toBeInTheDocument();
		expect(line.textContent).toMatch(/built-in prompt/i);
	});

	it("flags a prompt whose format does no templating", () => {
		renderAgenda({
			source: "BOUND",
			promptName: "Meeting Agenda Generator",
			promptVersion: 2,
			formatOverridden: true,
		});

		expect(screen.getByText(/read as Handlebars/i)).toBeInTheDocument();
	});

	it("renders no provenance line for an agenda generated before it was recorded", () => {
		// Claiming "built from the built-in prompt" for a run that predates the
		// field would be a measurement we never took.
		renderAgenda(null);

		expect(screen.queryByText(/built-in prompt/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/prompt:/i)).not.toBeInTheDocument();
	});
});
