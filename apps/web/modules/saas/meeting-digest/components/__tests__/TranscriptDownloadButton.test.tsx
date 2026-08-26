import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	TranscriptDownloadButton,
	transcriptFilename,
} from "../TranscriptDownloadButton";

describe("transcriptFilename", () => {
	it("slugifies subject + date", () => {
		expect(
			transcriptFilename("Sprint Review: Q3!", "2026-07-01T10:00:00Z"),
		).toBe("sprint-review-q3-2026-07-01.md");
	});
	it("accepts a Date object", () => {
		expect(
			transcriptFilename("Standup", new Date("2026-07-01T00:00:00Z")),
		).toBe("standup-2026-07-01.md");
	});
	it("falls back when subject and date are missing", () => {
		expect(transcriptFilename(null, null)).toBe("meeting-transcript.md");
	});
});

describe("TranscriptDownloadButton", () => {
	beforeEach(() => {
		URL.createObjectURL = vi.fn().mockReturnValue("blob:x");
		URL.revokeObjectURL = vi.fn();
	});
	it("downloads the content as a markdown blob", () => {
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		render(<TranscriptDownloadButton content="# T" filename="t.md" />);
		fireEvent.click(
			screen.getByRole("button", { name: "Download transcript" }),
		);
		expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
		expect(click).toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
	});
});
