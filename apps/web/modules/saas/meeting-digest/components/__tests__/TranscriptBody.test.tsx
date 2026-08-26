import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TranscriptBody } from "../TranscriptBody";

const baseProps = {
	content: "Alice: hello\nBob: hi",
	isLoading: false,
	isError: false,
	hasTranscript: true,
	filename: "meeting.md",
};

describe("TranscriptBody download gating", () => {
	it("renders the download button by default", () => {
		render(<TranscriptBody {...baseProps} />);
		expect(
			screen.getByRole("button", { name: "Download transcript" }),
		).toBeInTheDocument();
	});

	it("hides the download button when showDownload is false", () => {
		render(<TranscriptBody {...baseProps} showDownload={false} />);
		expect(
			screen.queryByRole("button", { name: "Download transcript" }),
		).not.toBeInTheDocument();
		// The transcript itself is still shown.
		expect(screen.getByText("Alice: hello")).toBeInTheDocument();
	});
});

describe("TranscriptBody hidden states (no download button)", () => {
	it("shows the empty message and no button when hasTranscript is false", () => {
		render(<TranscriptBody {...baseProps} hasTranscript={false} />);
		expect(
			screen.getByText("No transcript is available for this meeting."),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Download transcript" }),
		).not.toBeInTheDocument();
	});

	it("shows the error message and no button when isError is true", () => {
		render(<TranscriptBody {...baseProps} content="" isError={true} />);
		expect(
			screen.getByText("Failed to load transcript."),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Download transcript" }),
		).not.toBeInTheDocument();
	});
});

describe("TranscriptBody expanded view (#2108)", () => {
	it("opens a modal with exactly the sidebar's content and no extra controls", async () => {
		render(
			<TranscriptBody
				{...baseProps}
				expandTitle="Transcript — Sprint Review"
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Expand transcript" }),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "Transcript — Sprint Review",
		});
		// Same content string the sidebar rendered (AC5).
		expect(within(dialog).getByText(/Alice: hello/)).toBeInTheDocument();
		expect(within(dialog).getByText(/Bob: hi/)).toBeInTheDocument();
		// FR6: no download button or transcript link inside the modal.
		expect(
			within(dialog).queryByRole("button", {
				name: "Download transcript",
			}),
		).not.toBeInTheDocument();
		expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
	});

	it("still offers expand when download and full-transcript link are absent (personal path)", () => {
		render(<TranscriptBody {...baseProps} showDownload={false} />);
		expect(
			screen.getByRole("button", { name: "Expand transcript" }),
		).toBeInTheDocument();
	});

	it("renders no expand button in loading, error, empty-content and no-transcript states", () => {
		const { rerender } = render(
			<TranscriptBody {...baseProps} hasTranscript={false} />,
		);
		expect(
			screen.queryByRole("button", { name: "Expand transcript" }),
		).not.toBeInTheDocument();
		rerender(<TranscriptBody {...baseProps} content="" isLoading={true} />);
		expect(
			screen.queryByRole("button", { name: "Expand transcript" }),
		).not.toBeInTheDocument();
		rerender(<TranscriptBody {...baseProps} content="" isError={true} />);
		expect(
			screen.queryByRole("button", { name: "Expand transcript" }),
		).not.toBeInTheDocument();
		rerender(<TranscriptBody {...baseProps} content="   " />);
		expect(
			screen.queryByRole("button", { name: "Expand transcript" }),
		).not.toBeInTheDocument();
	});

	it("keeps the sidebar transcript mounted while the modal is open and after close", async () => {
		render(<TranscriptBody {...baseProps} />);
		fireEvent.click(
			screen.getByRole("button", { name: "Expand transcript" }),
		);
		const dialog = await screen.findByRole("dialog");
		// Sidebar's per-line rendering is still there (exact-text match hits
		// the sidebar's line div, not the modal's single pre-wrap block).
		expect(screen.getByText("Alice: hello")).toBeInTheDocument();
		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(screen.getByText("Alice: hello")).toBeInTheDocument();
	});
});

describe("TranscriptBody expanded view — per-meeting reset (#2108 review)", () => {
	it("closes the modal in the same render the meeting identity changes", async () => {
		const { rerender } = render(
			<TranscriptBody {...baseProps} resetKey="meeting-a" />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Expand transcript" }),
		);
		await screen.findByRole("dialog");

		rerender(
			<TranscriptBody
				{...baseProps}
				content="Carol: new meeting"
				resetKey="meeting-b"
			/>,
		);
		// Render-time reset: the modal must be gone without waiting for any
		// effect to run — a cache-warm meeting switch paints synchronously.
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("keeps the modal open across re-renders with the same resetKey (background refetch)", async () => {
		const { rerender } = render(
			<TranscriptBody {...baseProps} resetKey="meeting-a" />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Expand transcript" }),
		);
		await screen.findByRole("dialog");

		rerender(<TranscriptBody {...baseProps} resetKey="meeting-a" />);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});
