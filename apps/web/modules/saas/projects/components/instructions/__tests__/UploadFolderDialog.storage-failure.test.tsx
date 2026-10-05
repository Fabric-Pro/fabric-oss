/**
 * An upload whose browser could not reach storage (Fizzy #2878 follow-up). The
 * snapshot `begin` registered stays RECEIVING with nothing to move it, the tab
 * then waits on it for hours, and Upload is hidden. So the dialog deletes the
 * snapshot it began when a PUT gives up, says in one plain sentence that
 * nothing was kept, and leaves the tab as it was. Every other failure still
 * keeps the snapshot for a resume.
 *
 * `uploadSnapshot` and the raw client are the mocked seams; copy is the real
 * `en.json`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const mocks = vi.hoisted(() => ({
	uploadSnapshot: vi.fn(),
	deleteSnapshot: vi.fn(),
}));

vi.mock("../../../lib/upload-snapshot", () => ({
	uploadSnapshot: (...a: unknown[]) => mocks.uploadSnapshot(...a),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			instructions: {
				delete: (...a: unknown[]) => mocks.deleteSnapshot(...a),
			},
		},
	},
}));

import { StorageUploadError } from "../../../lib/upload-storage-error";
import { UploadFolderDialog } from "../UploadFolderDialog";

const UNREACHABLE =
	"The upload could not reach storage; nothing was kept. Try again.";
const UNREACHABLE_KEPT =
	"The upload could not reach storage, and the unfinished upload could not be discarded. Try again, or discard it from the tab.";

function pick(path: string, content = "x") {
	const file = new File([content], path.slice(path.lastIndexOf("/") + 1));
	Object.defineProperty(file, "webkitRelativePath", { value: path });
	return file;
}

async function renderAndUpload() {
	const onUploaded = vi.fn();
	const onDiscarded = vi.fn();
	const user = userEvent.setup();
	render(
		<UploadFolderDialog
			projectId="proj_1"
			open
			onOpenChange={() => undefined}
			onUploaded={onUploaded}
			onDiscarded={onDiscarded}
		/>,
	);
	await user.upload(
		screen.getByLabelText("Choose folder") as HTMLInputElement,
		[pick("repo/CLAUDE.md", "# x")],
	);
	await user.click(
		await screen.findByRole("button", { name: /Upload 1 files/ }),
	);
	return { user, onUploaded, onDiscarded };
}

/** An `uploadSnapshot` that begins snapshot_1 and then fails with `error`. */
function beginsThenFails(error: unknown) {
	mocks.uploadSnapshot.mockImplementationOnce(
		async (input: { onSnapshotStarted?: (id: string) => void }) => {
			input.onSnapshotStarted?.("snap_begun");
			throw error;
		},
	);
}

beforeEach(() => {
	mocks.uploadSnapshot.mockReset();
	mocks.deleteSnapshot.mockReset();
	mocks.deleteSnapshot.mockResolvedValue({ deleted: true });
});

describe("UploadFolderDialog when storage cannot be reached", () => {
	it("deletes the snapshot it began, says nothing was kept, and does not report an upload", async () => {
		beginsThenFails(
			new StorageUploadError("CLAUDE.md", new TypeError("x")),
		);
		const { onUploaded, onDiscarded } = await renderAndUpload();

		expect(await screen.findByText(UNREACHABLE)).toBeInTheDocument();

		expect(mocks.deleteSnapshot).toHaveBeenCalledWith({
			projectId: "proj_1",
			snapshotId: "snap_begun",
		});
		expect(onUploaded).not.toHaveBeenCalled();
		// The tab re-reads, so the row the begin wrote is gone from it too.
		expect(onDiscarded).toHaveBeenCalledTimes(1);
	});

	it("starts the next attempt from scratch rather than resuming the discarded snapshot", async () => {
		beginsThenFails(
			new StorageUploadError("CLAUDE.md", new TypeError("x")),
		);
		const { user } = await renderAndUpload();
		await screen.findByText(UNREACHABLE);
		mocks.uploadSnapshot.mockResolvedValueOnce({
			snapshotId: "snap_new",
			serverExcludedPaths: [],
		});

		await user.click(
			screen.getByRole("button", { name: /Upload 1 files/ }),
		);

		await waitFor(() =>
			expect(mocks.uploadSnapshot).toHaveBeenCalledTimes(2),
		);
		expect(
			mocks.uploadSnapshot.mock.lastCall?.[0].resumeSnapshotId,
		).toBeUndefined();
	});

	it("also discards a snapshot a previous attempt left, when that is the one whose PUT failed", async () => {
		mocks.uploadSnapshot.mockImplementationOnce(
			async (input: { onSnapshotStarted?: (id: string) => void }) => {
				input.onSnapshotStarted?.("snap_first");
				throw new Error("signing refused");
			},
		);
		const { user } = await renderAndUpload();
		await screen.findByText("Upload failed");
		expect(mocks.deleteSnapshot).not.toHaveBeenCalled();
		mocks.uploadSnapshot.mockImplementationOnce(
			async (input: {
				resumeSnapshotId?: string;
				onSnapshotStarted?: (id: string) => void;
			}) => {
				input.onSnapshotStarted?.(input.resumeSnapshotId ?? "none");
				throw new StorageUploadError("CLAUDE.md", new TypeError("x"));
			},
		);

		await user.click(
			screen.getByRole("button", { name: /Upload 1 files/ }),
		);

		await waitFor(() =>
			expect(mocks.deleteSnapshot).toHaveBeenCalledWith({
				projectId: "proj_1",
				snapshotId: "snap_first",
			}),
		);
	});

	it("keeps the snapshot for a resume, and says so, when it cannot be deleted either", async () => {
		beginsThenFails(
			new StorageUploadError("CLAUDE.md", new TypeError("x")),
		);
		mocks.deleteSnapshot.mockRejectedValue(new Error("network down"));
		const { onDiscarded, user } = await renderAndUpload();

		expect(await screen.findByText(UNREACHABLE_KEPT)).toBeInTheDocument();
		// The tab still re-reads: the server deletes the rows before the
		// stored objects, so a refused delete may have taken the row anyway.
		expect(onDiscarded).toHaveBeenCalledTimes(1);
		mocks.uploadSnapshot.mockResolvedValueOnce({
			snapshotId: "snap_begun",
			serverExcludedPaths: [],
		});

		await user.click(
			screen.getByRole("button", { name: /Upload 1 files/ }),
		);

		await waitFor(() =>
			expect(mocks.uploadSnapshot).toHaveBeenCalledTimes(2),
		);
		expect(mocks.uploadSnapshot.mock.lastCall?.[0].resumeSnapshotId).toBe(
			"snap_begun",
		);
	});

	it("does not discard a snapshot for a failure that is not storage's", async () => {
		beginsThenFails(new Error("The server refused the upload"));
		const { onDiscarded } = await renderAndUpload();

		await screen.findByText("Upload failed");

		expect(mocks.deleteSnapshot).not.toHaveBeenCalled();
		expect(onDiscarded).not.toHaveBeenCalled();
		expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
	});

	it("has nothing to delete when storage failed before any snapshot was begun", async () => {
		mocks.uploadSnapshot.mockRejectedValueOnce(
			new StorageUploadError("CLAUDE.md", new TypeError("x")),
		);
		await renderAndUpload();

		expect(await screen.findByText(UNREACHABLE)).toBeInTheDocument();
		expect(mocks.deleteSnapshot).not.toHaveBeenCalled();
	});
});
