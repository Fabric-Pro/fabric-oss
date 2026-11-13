/**
 * @vitest-environment jsdom
 */

/**
 * The Meeting Digest's line about uploads in progress (Fizzy #3507, FR11).
 *
 * An upload reaches the calendar only once it has been read. Until then this is
 * the only sign of it on the page, and a file that failed has to say so here
 * rather than stay "in progress" or vanish.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	uploads: [] as Array<Record<string, unknown>>,
	/** What the server still has, removed rows included. */
	storedIds: null as string | null,
}));

vi.mock("@saas/projects/components/TranscriptFileUpload", async () => {
	const isProcessing = (row: { extractionStatus: string }) =>
		row.extractionStatus === "PENDING" ||
		row.extractionStatus === "EXTRACTING";
	return {
		isProcessing,
		uploadedTranscriptTitle: (row: {
			originalFilename?: string;
			metadata?: { meetingSubject?: string };
		}) =>
			row.metadata?.meetingSubject ??
			row.originalFilename ??
			"Transcript",
		useUploadedTranscripts: () => ({
			uploads: mocks.uploads,
			storedIds:
				mocks.storedIds ?? mocks.uploads.map((row) => row.id).join(","),
			isLoading: false,
		}),
	};
});

import { UploadedTranscriptProgress } from "../UploadedTranscriptProgress";

function upload(id: string, extractionStatus: string, extra = {}) {
	return {
		id,
		type: "MEETING_TRANSCRIPT",
		extractionStatus,
		originalFilename: `${id}.vtt`,
		metadata: { provider: "file-upload", meetingSubject: `Meeting ${id}` },
		...extra,
	};
}

function renderProgress(props: {
	onFinished?: () => void;
	onReview?: () => void;
}) {
	return render(
		<UploadedTranscriptProgress
			projectId="project-1"
			organizationId="org-1"
			{...props}
		/>,
	);
}

beforeEach(() => {
	mocks.uploads = [];
	mocks.storedIds = null;
});

afterEach(() => {
	cleanup();
});

describe("UploadedTranscriptProgress", () => {
	it("says nothing when no upload is in progress or failed", () => {
		mocks.uploads = [upload("a", "COMPLETED")];
		const { container } = renderProgress({});
		expect(container).toBeEmptyDOMElement();
	});

	it("names the one file being read, in text and not only a spinner", () => {
		mocks.uploads = [upload("a", "EXTRACTING"), upload("b", "COMPLETED")];
		renderProgress({});
		expect(screen.getByRole("status")).toHaveTextContent(
			"Reading Meeting a. They appear on the calendar once read.",
		);
	});

	it("counts several files being read", () => {
		mocks.uploads = [upload("a", "PENDING"), upload("b", "EXTRACTING")];
		renderProgress({});
		expect(screen.getByRole("status")).toHaveTextContent(
			"Reading 2 uploaded transcripts.",
		);
	});

	it("says why a file failed and offers the uploader to fix it", () => {
		const onReview = vi.fn();
		mocks.uploads = [
			upload("a", "FAILED", { extractionError: "The file is empty." }),
		];
		renderProgress({ onReview });
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Meeting a could not be processed: The file is empty.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Review uploads" }));
		expect(onReview).toHaveBeenCalledTimes(1);
	});

	it("tells the page when the last file finishes, and only then", () => {
		const onFinished = vi.fn();
		mocks.uploads = [upload("a", "COMPLETED")];
		const { rerender } = renderProgress({ onFinished });
		// Nothing was in progress, so nothing finished.
		expect(onFinished).not.toHaveBeenCalled();

		mocks.uploads = [upload("a", "COMPLETED"), upload("b", "EXTRACTING")];
		rerender(
			<UploadedTranscriptProgress
				projectId="project-1"
				organizationId="org-1"
				onFinished={onFinished}
			/>,
		);
		expect(onFinished).not.toHaveBeenCalled();

		mocks.uploads = [upload("a", "COMPLETED"), upload("b", "COMPLETED")];
		rerender(
			<UploadedTranscriptProgress
				projectId="project-1"
				organizationId="org-1"
				onFinished={onFinished}
			/>,
		);
		expect(onFinished).toHaveBeenCalledTimes(1);
	});

	it("refreshes the digest when a removed file is really gone, not when it is removed", () => {
		const onFinished = vi.fn();
		const props = {
			projectId: "project-1",
			organizationId: "org-1",
			onFinished,
		};
		mocks.uploads = [upload("a", "COMPLETED"), upload("b", "COMPLETED")];
		const { rerender } = render(<UploadedTranscriptProgress {...props} />);

		// Removed: hidden at once, but the worker has not deleted it yet, so
		// its meeting is still in the digest.
		mocks.uploads = [upload("a", "COMPLETED")];
		mocks.storedIds = "a,b";
		rerender(<UploadedTranscriptProgress {...props} />);
		expect(onFinished).not.toHaveBeenCalled();

		// The worker deleted it.
		mocks.storedIds = "a";
		rerender(<UploadedTranscriptProgress {...props} />);
		expect(onFinished).toHaveBeenCalledTimes(1);
	});
});
