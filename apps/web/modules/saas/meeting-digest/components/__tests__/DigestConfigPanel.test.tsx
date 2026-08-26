import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConfigMeeting } from "../DigestConfigPanel";
import { DigestConfigPanel } from "../DigestConfigPanel";

const base: ConfigMeeting = {
	linkedMeetingId: "lm1",
	subject: "DSU",
	includedInDigest: true,
	lastMeetingDate: null,
};

describe("DigestConfigPanel", () => {
	it("renders the meeting subject", () => {
		render(
			<DigestConfigPanel
				meetings={[base]}
				onSetIncluded={() => {}}
				onAddMeeting={vi.fn()}
				onUnlink={vi.fn()}
			/>,
		);
		expect(screen.getByText("DSU")).toBeInTheDocument();
	});

	it("invokes onSetIncluded with the toggled value", () => {
		const onSetIncluded = vi.fn();
		render(
			<DigestConfigPanel
				meetings={[base]}
				onSetIncluded={onSetIncluded}
				onAddMeeting={vi.fn()}
				onUnlink={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /exclude/i }));
		expect(onSetIncluded).toHaveBeenCalledWith("lm1", false);
	});

	it("shows the series' last meeting date, or a no-meetings note", () => {
		render(
			<DigestConfigPanel
				meetings={[
					{
						linkedMeetingId: "lm1",
						subject: "FABRIC | DSU",
						includedInDigest: true,
						lastMeetingDate: new Date("2026-04-30T18:30:00Z"),
					},
					{
						linkedMeetingId: "lm2",
						subject: "Weekly Steering",
						includedInDigest: true,
						lastMeetingDate: null,
					},
				]}
				onSetIncluded={vi.fn()}
				onAddMeeting={vi.fn()}
				onUnlink={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/last meeting apr 30, 2026/i),
		).toBeInTheDocument();
		expect(screen.getByText(/no meetings synced yet/i)).toBeInTheDocument();
	});

	it("renders an Add meeting button that calls onAddMeeting", () => {
		const onAddMeeting = vi.fn();
		render(
			<DigestConfigPanel
				meetings={[base]}
				onSetIncluded={vi.fn()}
				onAddMeeting={onAddMeeting}
				onUnlink={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /add meeting/i }));
		expect(onAddMeeting).toHaveBeenCalledTimes(1);
	});

	it("offers Add meeting even when no meetings are linked yet", () => {
		const onAddMeeting = vi.fn();
		render(
			<DigestConfigPanel
				meetings={[]}
				onSetIncluded={vi.fn()}
				onAddMeeting={onAddMeeting}
				onUnlink={vi.fn()}
			/>,
		);
		expect(screen.getByText(/no linked meetings yet/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /add meeting/i }));
		expect(onAddMeeting).toHaveBeenCalledTimes(1);
	});

	// FIX 3 (#1898 final review): a row whose setIncluded call is in flight
	// must have its Include/Exclude button disabled so a second click can't
	// send the opposite value and reverse the user's intent. This asserts
	// the `pendingIncludeIds` prop directly (with a synchronous, non-promise
	// `onSetIncluded`) so the assertion is about DigestConfigPanel's own
	// wiring — not about the shared Button component's separate built-in
	// promise-based auto-loading, which would otherwise mask a regression
	// here.
	it("disables the Include/Exclude button for a row present in pendingIncludeIds", () => {
		render(
			<DigestConfigPanel
				meetings={[base]}
				onSetIncluded={() => {}}
				pendingIncludeIds={new Set(["lm1"])}
				onAddMeeting={vi.fn()}
				onUnlink={vi.fn()}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /^exclude$/i }),
		).toBeDisabled();
	});

	it("does not disable the Include/Exclude button for a row absent from pendingIncludeIds", () => {
		render(
			<DigestConfigPanel
				meetings={[base]}
				onSetIncluded={() => {}}
				pendingIncludeIds={new Set(["some-other-id"])}
				onAddMeeting={vi.fn()}
				onUnlink={vi.fn()}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /^exclude$/i }),
		).not.toBeDisabled();
	});

	it("calls onUnlink with the meeting from the row menu", async () => {
		const onUnlink = vi.fn();
		render(
			<DigestConfigPanel
				meetings={[base]}
				onSetIncluded={vi.fn()}
				onAddMeeting={vi.fn()}
				onUnlink={onUnlink}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: /meeting options for dsu/i }),
		);
		fireEvent.click(await screen.findByText(/unlink meeting/i));
		expect(onUnlink).toHaveBeenCalledWith(base);
	});
});
