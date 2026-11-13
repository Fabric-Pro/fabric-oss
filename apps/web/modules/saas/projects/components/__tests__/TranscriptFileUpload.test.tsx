/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	deleteContext: vi.fn(),
	upload: vi.fn(),
	confirm: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: mocks.confirm }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { contexts: { delete: mocks.deleteContext } } },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					key: () => ["contexts"],
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["contexts", input],
						queryFn: () => mocks.list(input),
					}),
				},
			},
		},
	},
}));

vi.mock(
	"@saas/projects/lib/upload-transcript-file",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		uploadTranscriptFile: mocks.upload,
	}),
);

import {
	TranscriptFileUpload,
	transcriptListPollInterval,
	useUploadedTranscripts,
} from "../TranscriptFileUpload";

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "context-1",
		type: "MEETING_TRANSCRIPT",
		extractionStatus: "COMPLETED",
		extractionError: null,
		originalFilename: "Planning.vtt",
		metadata: { provider: "file-upload", meetingSubject: "Planning" },
		...overrides,
	};
}

function renderUpload(props: { canEdit?: boolean } = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<TranscriptFileUpload
			projectId="project-1"
			organizationId="org-1"
			{...props}
		/>,
		{ wrapper },
	);
}

function pickFiles(...files: File[]) {
	const input = screen.getByLabelText(
		"Upload transcript files",
	) as HTMLInputElement;
	fireEvent.change(input, { target: { files } });
}

const VTT = new File(["hello"], "Planning.vtt");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.list.mockResolvedValue({ contexts: [] });
	mocks.upload.mockResolvedValue({ status: "started" });
	mocks.deleteContext.mockResolvedValue({});
});

afterEach(() => {
	cleanup();
});

describe("transcriptListPollInterval", () => {
	const none = new Set<string>();

	it("rests when everything has settled", () => {
		expect(transcriptListPollInterval([row()], none)).toBe(false);
		expect(transcriptListPollInterval([], none)).toBe(false);
	});

	it("keeps reading while a file is being processed", () => {
		expect(
			transcriptListPollInterval(
				[row({ extractionStatus: "PENDING" })],
				none,
			),
		).toBeGreaterThan(0);
	});

	it("keeps reading until a removed row has really gone", () => {
		const removed = new Set(["context-1"]);

		expect(transcriptListPollInterval([row()], removed)).toBeGreaterThan(0);
		expect(transcriptListPollInterval([], removed)).toBe(false);
	});
});

describe("TranscriptFileUpload", () => {
	it("says what to do when nothing has been added", async () => {
		renderUpload();

		expect(
			await screen.findByText(/No transcripts uploaded yet/),
		).toBeTruthy();
		expect(screen.getByText(/\.txt, \.vtt, \.docx/)).toBeTruthy();
		expect(screen.getByText(/25MB/)).toBeTruthy();
	});

	it("asks the file picker for the accepted formats only", () => {
		renderUpload();

		const input = screen.getByLabelText(
			"Upload transcript files",
		) as HTMLInputElement;
		expect(input.accept).toBe(".txt,.vtt,.docx");
		expect(input.multiple).toBe(true);
	});

	it("reads this project's transcripts", async () => {
		renderUpload();

		await waitFor(() => {
			expect(mocks.list).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				type: "MEETING_TRANSCRIPT",
			});
		});
	});

	it("lists uploads with their source, and leaves Teams transcripts out", async () => {
		mocks.list.mockResolvedValue({
			contexts: [
				row(),
				row({
					id: "context-2",
					metadata: { provider: "microsoft-teams" },
				}),
			],
		});

		renderUpload();

		expect(await screen.findByText("Planning")).toBeTruthy();
		expect(screen.getByText("Uploaded file")).toBeTruthy();
		expect(screen.getAllByRole("listitem")).toHaveLength(1);
	});

	it("shows a file that is still being read", async () => {
		mocks.list.mockResolvedValue({
			contexts: [row({ extractionStatus: "EXTRACTING" })],
		});

		renderUpload();

		expect(await screen.findByText("Processing")).toBeTruthy();
	});

	it("shows why a file failed", async () => {
		mocks.list.mockResolvedValue({
			contexts: [
				row({
					extractionStatus: "FAILED",
					extractionError: "There is no text in this file.",
				}),
			],
		});

		renderUpload();

		expect(
			await screen.findByText("There is no text in this file."),
		).toBeTruthy();
	});

	it("warns when part of a file could not be read", async () => {
		mocks.list.mockResolvedValue({
			contexts: [
				row({
					metadata: {
						provider: "file-upload",
						meetingSubject: "Planning",
						unreadableParts: 3,
					},
				}),
			],
		});

		renderUpload();

		expect(
			await screen.findByText(/Part of this file could not be read/),
		).toBeTruthy();
	});

	it("uploads what was picked", async () => {
		renderUpload();

		pickFiles(VTT);

		await waitFor(() => {
			expect(mocks.upload).toHaveBeenCalledWith({
				file: VTT,
				projectId: "project-1",
				organizationId: "org-1",
			});
		});
		await waitFor(() => {
			expect(mocks.toastSuccess).toHaveBeenCalled();
		});
	});

	it("refuses a bad file without sending it, and still sends the good one", async () => {
		renderUpload();

		pickFiles(new File(["x"], "Planning.pdf"), VTT);

		await waitFor(() => {
			expect(mocks.toastError).toHaveBeenCalledWith(
				expect.stringContaining("Planning.pdf"),
			);
		});
		await waitFor(() => {
			expect(mocks.upload).toHaveBeenCalledTimes(1);
		});
		expect(mocks.upload.mock.calls[0]?.[0].file).toBe(VTT);
	});

	it("reports a failed upload and carries on with the next file", async () => {
		mocks.upload
			.mockRejectedValueOnce(
				new Error("Planning.vtt could not be uploaded."),
			)
			.mockResolvedValueOnce({ status: "started" });

		renderUpload();
		pickFiles(VTT, new File(["other"], "Review.vtt"));

		await waitFor(() => {
			expect(mocks.upload).toHaveBeenCalledTimes(2);
		});
		await waitFor(() => {
			expect(mocks.toastError).toHaveBeenCalledWith(
				"Planning.vtt could not be uploaded.",
			);
		});
	});

	describe("a file the project already has", () => {
		beforeEach(() => {
			mocks.upload.mockResolvedValueOnce({
				status: "duplicate",
				meetingSubject: "Planning",
				addedAt: new Date("2026-10-30T10:00:00Z"),
			});
		});

		it("asks whether to process it again or skip it", async () => {
			renderUpload();
			pickFiles(VTT);

			await waitFor(() => {
				expect(mocks.confirm).toHaveBeenCalledTimes(1);
			});
			const prompt = mocks.confirm.mock.calls[0]?.[0];
			expect(prompt.message).toContain("Planning.vtt");
			expect(prompt.confirmLabel).toBe("Process again");
			expect(prompt.cancelLabel).toBe("Skip");
			expect(mocks.upload).toHaveBeenCalledTimes(1);
		});

		it("processes it again only when told to", async () => {
			mocks.upload.mockResolvedValueOnce({ status: "reprocessing" });
			renderUpload();
			pickFiles(VTT);
			await waitFor(() => {
				expect(mocks.confirm).toHaveBeenCalled();
			});

			await act(async () => {
				await mocks.confirm.mock.calls[0]?.[0].onConfirm();
			});

			expect(mocks.upload).toHaveBeenLastCalledWith({
				file: VTT,
				projectId: "project-1",
				organizationId: "org-1",
				reprocess: true,
			});
		});
	});

	describe("without permission to change settings", () => {
		it("shows the list and offers no upload or removal", async () => {
			mocks.list.mockResolvedValue({ contexts: [row()] });

			renderUpload({ canEdit: false });

			expect(await screen.findByText("Planning")).toBeTruthy();
			expect(
				screen.queryByLabelText("Upload transcript files"),
			).toBeNull();
			expect(
				screen.queryByRole("button", { name: "Remove Planning" }),
			).toBeNull();
		});
	});

	it("says so when an upload cannot be removed, and keeps showing it", async () => {
		mocks.list.mockResolvedValue({ contexts: [row()] });
		mocks.deleteContext.mockRejectedValue(new Error("offline"));
		renderUpload();

		fireEvent.click(
			await screen.findByRole("button", { name: "Remove Planning" }),
		);
		await act(async () => {
			await mocks.confirm.mock.calls[0]?.[0].onConfirm();
		});

		expect(mocks.toastError).toHaveBeenCalledWith(
			expect.stringContaining("Planning"),
		);
		expect(screen.getByText("Planning")).toBeTruthy();
	});

	it("hides a removed upload at once, though the worker deletes it later", async () => {
		// `delete` returns when the workflow has started, so the row is still
		// in the list on the next read.
		mocks.list.mockResolvedValue({ contexts: [row()] });
		renderUpload();

		fireEvent.click(
			await screen.findByRole("button", { name: "Remove Planning" }),
		);
		await act(async () => {
			await mocks.confirm.mock.calls[0]?.[0].onConfirm();
		});

		await waitFor(() => {
			expect(screen.queryByText("Planning")).toBeNull();
		});
	});

	it("keeps a removal after the uploader closes, until the row is really gone (#3507)", async () => {
		// The uploader also lives in a dialog now, and the digest's progress
		// line reads the same rows. Closing the dialog mid-removal must not
		// bring the removed file back there.
		mocks.list.mockResolvedValue({ contexts: [row()] });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);
		const uploader = render(
			<TranscriptFileUpload
				projectId="project-1"
				organizationId="org-1"
			/>,
			{ wrapper },
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Remove Planning" }),
		);
		await act(async () => {
			await mocks.confirm.mock.calls[0]?.[0].onConfirm();
		});
		uploader.unmount();

		function Reader() {
			const { uploads, storedIds } = useUploadedTranscripts({
				projectId: "project-1",
				organizationId: "org-1",
			});
			return (
				<p>
					shown:{uploads.map((u) => u.id).join(",")} stored:
					{storedIds}
				</p>
			);
		}
		render(<Reader />, { wrapper });
		await screen.findByText("shown: stored:context-1");

		// The worker has deleted it: the record is dropped with the row.
		mocks.list.mockResolvedValue({ contexts: [] });
		await act(async () => {
			await client.invalidateQueries({ queryKey: ["contexts"] });
		});
		await screen.findByText("shown: stored:");
		expect(
			client.getQueryData(["uploaded-transcript-removals", "project-1"]),
		).toEqual(new Set());
	});

	it("confirms before removing an upload", async () => {
		mocks.list.mockResolvedValue({ contexts: [row()] });
		renderUpload();

		fireEvent.click(
			await screen.findByRole("button", { name: "Remove Planning" }),
		);

		expect(mocks.deleteContext).not.toHaveBeenCalled();
		const prompt = mocks.confirm.mock.calls[0]?.[0];
		expect(prompt.destructive).toBe(true);

		await act(async () => {
			await prompt.onConfirm();
		});

		expect(mocks.deleteContext).toHaveBeenCalledWith({
			id: "context-1",
			projectId: "project-1",
		});
	});
});
