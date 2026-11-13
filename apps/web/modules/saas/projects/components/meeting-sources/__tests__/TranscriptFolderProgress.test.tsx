/**
 * @vitest-environment jsdom
 */

/**
 * Folder import progress in the Meeting Digest and on the Context tab (Fizzy
 * #3507, FR15): counts while a folder imports, found-so-far until it is
 * listed in full, a stopped folder named with its reason, and a refresh when
 * the last import finishes.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	folders: [] as Array<Record<string, unknown>>,
}));

vi.mock("../TranscriptFolderSettings", () => ({
	isFolderImporting: (folder: {
		discoveryComplete: boolean;
		counts: { inProgress: number };
	}) => !folder.discoveryComplete || folder.counts.inProgress > 0,
	useTranscriptFolders: () => ({ folders: mocks.folders, isLoading: false }),
}));

import { TranscriptFolderProgress } from "../TranscriptFolderProgress";

function folder(overrides: Record<string, unknown> = {}) {
	return {
		id: "folder-1",
		name: "Transcripts",
		lastSyncError: null,
		discoveryComplete: true,
		counts: {
			discovered: 10,
			imported: 4,
			skipped: 1,
			failed: 0,
			inProgress: 5,
		},
		...overrides,
	};
}

beforeEach(() => {
	mocks.folders = [];
});

afterEach(() => {
	cleanup();
});

describe("TranscriptFolderProgress", () => {
	it("says nothing when no folder is importing or stopped", () => {
		mocks.folders = [
			folder({
				counts: {
					discovered: 3,
					imported: 3,
					skipped: 0,
					failed: 0,
					inProgress: 0,
				},
			}),
		];
		const { container } = render(
			<TranscriptFolderProgress projectId="p1" organizationId="o1" />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("counts an import in progress, in text", () => {
		mocks.folders = [folder()];
		render(<TranscriptFolderProgress projectId="p1" organizationId="o1" />);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Importing from OneDrive. Transcripts: 5 of 10 files done.",
		);
	});

	it("keeps the total provisional while files are still being found", () => {
		mocks.folders = [folder({ discoveryComplete: false })];
		render(<TranscriptFolderProgress projectId="p1" organizationId="o1" />);

		expect(screen.getByRole("status")).toHaveTextContent(
			"5 of 10 found so far done, still looking for more",
		);
	});

	it("names a stopped folder and its reason, with a way to fix it", () => {
		const onReview = vi.fn();
		mocks.folders = [
			folder({
				lastSyncError:
					"Reconnect the folder to keep importing from it.",
				counts: {
					discovered: 2,
					imported: 2,
					skipped: 0,
					failed: 0,
					inProgress: 0,
				},
			}),
		];
		render(
			<TranscriptFolderProgress
				projectId="p1"
				organizationId="o1"
				onReview={onReview}
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Transcripts: Reconnect the folder to keep importing from it.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Review folders" }));
		expect(onReview).toHaveBeenCalledTimes(1);
	});

	it("tells the page when the last import finishes", () => {
		const onFinished = vi.fn();
		mocks.folders = [folder()];
		const { rerender } = render(
			<TranscriptFolderProgress
				projectId="p1"
				organizationId="o1"
				onFinished={onFinished}
			/>,
		);
		expect(onFinished).not.toHaveBeenCalled();

		mocks.folders = [
			folder({
				counts: {
					discovered: 10,
					imported: 9,
					skipped: 1,
					failed: 0,
					inProgress: 0,
				},
			}),
		];
		rerender(
			<TranscriptFolderProgress
				projectId="p1"
				organizationId="o1"
				onFinished={onFinished}
			/>,
		);
		expect(onFinished).toHaveBeenCalledTimes(1);
	});
});

describe("TranscriptFolderProgress — as files land", () => {
	it("tells the page each time more files are imported", () => {
		const onImported = vi.fn();
		mocks.folders = [folder()];
		const { rerender } = render(
			<TranscriptFolderProgress
				projectId="p1"
				organizationId="o1"
				onImported={onImported}
			/>,
		);
		expect(onImported).not.toHaveBeenCalled();

		mocks.folders = [
			folder({
				counts: {
					discovered: 10,
					imported: 6,
					skipped: 1,
					failed: 0,
					inProgress: 3,
				},
			}),
		];
		rerender(
			<TranscriptFolderProgress
				projectId="p1"
				organizationId="o1"
				onImported={onImported}
			/>,
		);
		expect(onImported).toHaveBeenCalledTimes(1);
	});
});
