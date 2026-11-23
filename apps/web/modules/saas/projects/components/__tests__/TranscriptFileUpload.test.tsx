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
		uploadTranscriptFile: async (params: {
			onStored?: (contextId: string) => void;
		}) => {
			const outcome = await mocks.upload(params);
			if (outcome.status === "started") {
				params.onStored?.(outcome.contextId);
			}
			return outcome;
		},
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

function renderUpload(props: { canEdit?: boolean; onClose?: () => void } = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const view = render(
		<TranscriptFileUpload
			projectId="project-1"
			organizationId="org-1"
			{...props}
		/>,
		{ wrapper },
	);
	return { ...view, client };
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
	mocks.upload.mockResolvedValue({
		status: "started",
		contextId: "context-1",
	});
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

const closeButton = () =>
	screen.queryByRole("button", { name: "Close", exact: true });

async function sendFiles(...files: File[]) {
	pickFiles(...files);
	await waitFor(() => {
		expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
	});
}

describe("upload session completion", () => {
	it("waits for a missing row to appear, then announces completion from polling", async () => {
		const onClose = vi.fn();
		renderUpload({ onClose });
		await screen.findByText(/No transcripts uploaded yet/);
		await sendFiles(VTT);
		expect(closeButton()).toBeNull();

		mocks.list.mockResolvedValue({
			contexts: [row({ extractionStatus: "PENDING" })],
		});
		await screen.findByText("Processing", {}, { timeout: 4500 });
		expect(closeButton()).toBeNull();

		mocks.list.mockResolvedValue({ contexts: [row()] });
		const status = await screen.findByText(
			"Transcript read. It now appears in the Meeting Digest and on the Context tab.",
			{},
			{ timeout: 4500 },
		);
		expect(status.closest("output")?.querySelector("svg")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(mocks.deleteContext).not.toHaveBeenCalled();
		expect(mocks.upload).toHaveBeenCalledOnce();
	}, 10_000);

	it.each(["PENDING", "FAILED", "CANCELLED"])(
		"does not confirm a %s upload",
		async (extractionStatus) => {
			mocks.list.mockResolvedValue({
				contexts: [
					row({
						extractionStatus,
						extractionError: "Nothing could be read.",
					}),
				],
			});
			renderUpload({ onClose: vi.fn() });
			await screen.findByText("Planning");
			await sendFiles(VTT);
			expect(closeButton()).toBeNull();
			if (extractionStatus === "FAILED") {
				expect(screen.getByRole("alert")).toHaveTextContent(
					"Nothing could be read.",
				);
			}
		},
	);

	it("keeps a stored upload pending when ingestion fails to start", async () => {
		const error = "Failed to start processing this transcript";
		mocks.list.mockResolvedValue({
			contexts: [
				row(),
				row({
					id: "context-2",
					extractionStatus: "PENDING",
					metadata: {
						provider: "file-upload",
						meetingSubject: "Review",
					},
				}),
			],
		});
		mocks.upload
			.mockResolvedValueOnce({
				status: "started",
				contextId: "context-1",
			})
			.mockImplementationOnce(async ({ onStored }) => {
				onStored?.("context-2");
				throw new Error(error);
			});

		renderUpload({ onClose: vi.fn() });
		await screen.findByText("Processing");
		await sendFiles(VTT, new File(["other"], "Review.vtt"));

		expect(mocks.toastError).toHaveBeenCalledWith(error);
		expect(closeButton()).toBeNull();
		expect(screen.queryByText(/Transcripts? read/)).toBeNull();
	});

	it("waits for both uploads and stops counting a removed row", async () => {
		const second = row({
			id: "context-2",
			extractionStatus: "EXTRACTING",
			metadata: { provider: "file-upload", meetingSubject: "Review" },
		});
		mocks.list.mockResolvedValue({ contexts: [row(), second] });
		mocks.upload
			.mockResolvedValueOnce({
				status: "started",
				contextId: "context-1",
			})
			.mockResolvedValueOnce({
				status: "started",
				contextId: "context-2",
			});
		renderUpload({ onClose: vi.fn() });
		await screen.findByText("Review");
		await sendFiles(VTT, new File(["other"], "Review.vtt"));
		expect(closeButton()).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Remove Review" }));
		await act(async () => {
			await mocks.confirm.mock.calls[0]?.[0].onConfirm();
		});
		expect(closeButton()).toBeInTheDocument();
	});

	it("hides completion while another upload starts and confirms both when read", async () => {
		mocks.list.mockResolvedValue({ contexts: [row()] });
		renderUpload({ onClose: vi.fn() });
		await screen.findByText("Planning");
		await sendFiles(VTT);
		expect(closeButton()).toBeInTheDocument();

		let finishUpload!: (outcome: {
			status: string;
			contextId: string;
		}) => void;
		mocks.upload.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishUpload = resolve;
				}),
		);
		pickFiles(new File(["other"], "Review.vtt"));
		expect(closeButton()).toBeNull();
		await act(async () => {
			finishUpload({ status: "started", contextId: "context-2" });
		});
		expect(closeButton()).toBeNull();

		mocks.list.mockResolvedValue({
			contexts: [row(), row({ id: "context-2" })],
		});
		expect(
			await screen.findByText(
				/Transcripts read\. They now appear/,
				{},
				{ timeout: 4500 },
			),
		).toBeInTheDocument();
	});

	it("ignores an earlier session's completed upload", async () => {
		mocks.list.mockResolvedValue({ contexts: [row()] });
		renderUpload({ onClose: vi.fn() });
		await screen.findByText("Planning");
		expect(closeButton()).toBeNull();
		expect(screen.queryByText(/Transcript read/)).toBeNull();
	});

	it("does not offer completion in settings after sending a completed file", async () => {
		mocks.list.mockResolvedValue({ contexts: [row()] });
		renderUpload();
		await screen.findByText("Planning");
		await sendFiles(VTT);
		expect(closeButton()).toBeNull();
		expect(screen.queryByText(/Transcript read/)).toBeNull();
	});

	it.each([
		{ status: "reprocessing", contextId: null },
		{ status: "reprocessing" },
	])(
		"keeps existing completion when a retry returns no context ID (%j)",
		async (outcome) => {
			mocks.list.mockResolvedValue({ contexts: [row()] });
			renderUpload({ onClose: vi.fn() });
			await screen.findByText("Planning");
			await sendFiles(VTT);

			mocks.upload
				.mockResolvedValueOnce({ status: "duplicate" })
				.mockResolvedValueOnce(outcome);
			pickFiles(VTT);
			await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
			await act(async () => {
				await mocks.confirm.mock.calls[0]?.[0].onConfirm();
			});
			expect(closeButton()).toBeInTheDocument();
		},
	);

	it.each([true, false])(
		"waits for each Process again request before confirming a dialog batch (dialog: %s)",
		async (inDialog) => {
			mocks.list.mockResolvedValue({
				contexts: [row(), row({ id: "context-2" })],
			});
			let finishUpload!: (outcome: {
				status: string;
				contextId: string;
			}) => void;
			mocks.upload
				.mockResolvedValueOnce({ status: "duplicate" })
				.mockResolvedValueOnce({ status: "duplicate" })
				.mockResolvedValueOnce({
					status: "reprocessing",
					contextId: "context-1",
				})
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finishUpload = resolve;
						}),
				);
			renderUpload({ onClose: inDialog ? vi.fn() : undefined });
			pickFiles(VTT, new File(["other"], "Review.vtt"));
			await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());

			let processing: Promise<void> | undefined;
			await act(async () => {
				processing = mocks.confirm.mock.calls[0]?.[0].onConfirm();
			});
			expect(mocks.upload).toHaveBeenCalledTimes(4);
			expect(closeButton()).toBeNull();
			const uploadButton = screen.getByRole("button", { name: "Upload" });
			if (inDialog) {
				expect(uploadButton).toBeDisabled();
			} else {
				expect(uploadButton).toBeEnabled();
			}

			await act(async () => {
				finishUpload({
					status: "reprocessing",
					contextId: "context-2",
				});
				await processing;
			});
			expect(uploadButton).toBeEnabled();
			if (inDialog) {
				expect(closeButton()).toBeInTheDocument();
			} else {
				expect(closeButton()).toBeNull();
			}
		},
	);

	it("counts a previously read upload only after Process again is accepted", async () => {
		mocks.list.mockResolvedValue({ contexts: [row()] });
		mocks.upload
			.mockResolvedValueOnce({ status: "duplicate" })
			.mockResolvedValueOnce({
				status: "reprocessing",
				contextId: "context-1",
			});
		renderUpload({ onClose: vi.fn() });
		await screen.findByText("Planning");
		pickFiles(VTT);
		await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
		expect(closeButton()).toBeNull();

		await act(async () => {
			await mocks.confirm.mock.calls[0]?.[0].onConfirm();
		});
		expect(closeButton()).toBeInTheDocument();
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
		expect(input.accept).toBe(".txt,.vtt,.docx,.md");
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
			.mockResolvedValueOnce({
				status: "started",
				contextId: "context-1",
			});

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
			mocks.upload.mockResolvedValueOnce({
				status: "reprocessing",
				contextId: "context-1",
			});
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
