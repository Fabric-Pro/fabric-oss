import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ParlumeAutoJoinState } from "../../hooks/use-meeting-digest";
import {
	autoJoinFixLink,
	ParlumeAutoJoinControl,
} from "../ParlumeAutoJoinControl";

const SETTINGS = "/app/example-org/settings";

function state(overrides: Partial<ParlumeAutoJoinState> = {}) {
	return {
		enabled: true,
		toolsReadOnly: true,
		suggestionsEnabled: true,
		suggestionAudience: "MEETING" as const,
		enabledBy: { id: "user-1", name: "Dev Example" },
		error: null,
		errorAt: null,
		syncStopped: false,
		...overrides,
	};
}

function renderControl(
	current: ParlumeAutoJoinState | null,
	props: { pending?: boolean; onChange?: ReturnType<typeof vi.fn> } = {},
) {
	const onChange = props.onChange ?? vi.fn();
	render(
		<ParlumeAutoJoinControl
			linkedMeetingId="lm-1"
			subject="Weekly sync"
			state={current}
			settingsBasePath={SETTINGS}
			pending={props.pending ?? false}
			onChange={onChange}
		/>,
	);
	return onChange;
}

describe("ParlumeAutoJoinControl", () => {
	it("is a labelled switch, off with no choices shown, for a series never set", () => {
		renderControl(null);

		const toggle = screen.getByRole("switch", {
			name: "Parlume joins automatically for Weekly sync",
		});
		expect(toggle).not.toBeChecked();
		expect(
			screen.queryByText("What Parlume can do"),
		).not.toBeInTheDocument();
	});

	it("is keyboard operable", async () => {
		const onChange = renderControl(null);

		screen
			.getByRole("switch", { name: /Parlume joins automatically/ })
			.focus();
		await userEvent.keyboard(" ");

		expect(onChange).toHaveBeenCalledWith({
			enabled: true,
			toolsReadOnly: true,
			suggestionsEnabled: true,
			suggestionAudience: "MEETING",
		});
	});

	it("shows who turned it on and the invite card's mode and suggestion choices while on", () => {
		renderControl(state());

		expect(
			screen.getByText(/Turned on by Dev Example\./),
		).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Read-only" })).toBeChecked();
		expect(
			screen.getByRole("radio", { name: "Actions" }),
		).not.toBeChecked();
		expect(screen.getByRole("switch", { name: "label" })).toBeChecked();
	});

	it("saves a new mode without changing the rest", async () => {
		const onChange = renderControl(state({ suggestionsEnabled: false }));

		await userEvent.click(screen.getByRole("radio", { name: "Actions" }));

		expect(onChange).toHaveBeenCalledWith({
			enabled: true,
			toolsReadOnly: false,
			suggestionsEnabled: false,
			suggestionAudience: "MEETING",
		});
	});

	it("turns suggestions and recap off", async () => {
		const onChange = renderControl(state({ suggestionAudience: "TEAM" }));

		await userEvent.click(screen.getByRole("switch", { name: "label" }));

		expect(onChange).toHaveBeenCalledWith({
			enabled: true,
			toolsReadOnly: true,
			suggestionsEnabled: false,
			suggestionAudience: "TEAM",
		});
	});

	it("asks who sees suggestions only while they are on", () => {
		renderControl(state({ suggestionsEnabled: false }));

		expect(
			screen.queryByText("Who sees suggestions"),
		).not.toBeInTheDocument();
	});

	it("keeps a series' suggestions for the team without changing the rest", async () => {
		const onChange = renderControl(state());
		expect(
			screen.getByRole("radio", {
				name: "Everyone in the meeting (chat)",
			}),
		).toBeChecked();
		expect(
			screen.getByText(/the recap are posted in the meeting chat/),
		).toBeInTheDocument();
		expect(
			screen.getByText(/external guests included/),
		).toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("radio", {
				name: "Only your team (Parlume page)",
			}),
		);

		expect(onChange).toHaveBeenCalledWith({
			enabled: true,
			toolsReadOnly: true,
			suggestionsEnabled: true,
			suggestionAudience: "TEAM",
		});
	});

	it("disables every control while a change is saving", () => {
		renderControl(state(), { pending: true });

		expect(
			screen.getByRole("switch", { name: /Parlume joins automatically/ }),
		).toBeDisabled();
		expect(screen.getByRole("radio", { name: "Actions" })).toBeDisabled();
	});

	it("cannot be turned on for a series whose syncing is stopped, and says why", () => {
		renderControl(state({ enabled: false, syncStopped: true }));

		expect(
			screen.getByRole("switch", { name: /Parlume joins automatically/ }),
		).toBeDisabled();
		expect(
			screen.getByText(/Resume syncing in the project's Settings/),
		).toBeInTheDocument();
	});

	it("can still be turned off after the series' syncing stopped", async () => {
		const onChange = renderControl(state({ syncStopped: true }));

		await userEvent.click(
			screen.getByRole("switch", { name: /Parlume joins automatically/ }),
		);

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: false }),
		);
	});

	it("says when the enabler's account is gone", () => {
		renderControl(state({ enabledBy: null }));

		expect(
			screen.getByText(/no longer has an account/),
		).toBeInTheDocument();
	});

	it("shows the last error with a link to the settings page that fixes it", () => {
		renderControl(
			state({
				error: "Reconnect Microsoft in Settings → Integrations to keep auto-join working.",
			}),
		);

		expect(
			screen.getByText(/Reconnect Microsoft in Settings → Integrations/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Open Integrations" }),
		).toHaveAttribute(
			"href",
			expect.stringContaining(`${SETTINGS}/integrations`),
		);
	});
});

describe("autoJoinFixLink", () => {
	it.each([
		[
			"Add an Attendee API key in Settings → Meeting assistant.",
			"meeting-assistant",
		],
		[
			"Add a key in Settings → AI Providers. ChatGPT plans serve text only.",
			"ai-providers",
		],
		["Reconnect Microsoft in Settings → Integrations.", "integrations"],
	])("points %s at its page", (error, page) => {
		expect(autoJoinFixLink(error, SETTINGS)?.href).toBe(
			`${SETTINGS}/${page}`,
		);
	});

	it("offers no link for an error no setting fixes", () => {
		expect(
			autoJoinFixLink(
				"The person who turned on auto-join can no longer invite Parlume.",
				SETTINGS,
			),
		).toBeNull();
	});
});
