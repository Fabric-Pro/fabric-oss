import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptDeepLinkHighlighter } from "../TranscriptDeepLinkHighlighter";

const CONTENT = [
	"## Meeting Transcript: Demo",
	"",
	"Ann: welcome everyone.",
	"Bob: we decided to keep VTT parsing.",
].join("\n");

function renderWithHash(hash: string) {
	window.history.replaceState(null, "", `/x${hash}`);
	return render(
		<div>
			<article data-testid="meeting-transcript-markdown">
				<p>Ann: welcome everyone.</p>
				<p>Bob: we decided to keep VTT parsing.</p>
			</article>
			<TranscriptDeepLinkHighlighter content={CONTENT} />
		</div>,
	);
}

describe("TranscriptDeepLinkHighlighter", () => {
	beforeEach(() => {
		window.scrollTo = vi.fn();
		Range.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
			top: 100,
			bottom: 120,
			left: 0,
			right: 0,
			width: 0,
			height: 20,
			x: 0,
			y: 100,
			toJSON: () => ({}),
		});
	});
	afterEach(() => {
		window.history.replaceState(null, "", "/x");
	});

	it("scrolls to the line named by the hash and announces it", async () => {
		renderWithHash("#t-4"); // line 4 → "Bob: we decided to keep VTT parsing."
		await waitFor(() => expect(window.scrollTo).toHaveBeenCalled());
		expect(
			screen.getByText(
				"Jumped to transcript: we decided to keep VTT parsing.",
				{
					exact: false,
				},
			),
		).toBeInTheDocument();
	});

	it("is a no-op for a line past the content (no scroll, no error)", async () => {
		renderWithHash("#t-999");
		await new Promise((r) => setTimeout(r, 60));
		expect(window.scrollTo).not.toHaveBeenCalled();
	});

	it("does nothing without a #t- hash", async () => {
		renderWithHash("");
		await new Promise((r) => setTimeout(r, 60));
		expect(window.scrollTo).not.toHaveBeenCalled();
	});

	it("rejects a malformed hash without crashing", async () => {
		renderWithHash("#t-<script>");
		await new Promise((r) => setTimeout(r, 60));
		expect(window.scrollTo).not.toHaveBeenCalled();
	});
});
