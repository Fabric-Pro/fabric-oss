/**
 * Component tests for the wizard's context uploader.
 *
 * The wizard is the second context-upload surface, and until Fizzy #2139 it had
 * no test file at all — which is precisely how the defect this covers survived
 * on one surface after being fixed on another. These pin the untyped-file
 * behaviour: a file the operating system gave the browser no MIME for must be
 * sized by the type the server will resolve, not by the `application/octet-stream`
 * placeholder the client substitutes.
 */

import {
	CONTEXT_UPLOAD_ACCEPT_ATTR,
	CONTEXT_UPLOAD_FORMAT_LABELS,
} from "@repo/utils";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ──────────────────────────────────────────────────────
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────

const { createUploadUrlMock, processFileMock, getStatusMock, toastErrorMock } =
	vi.hoisted(() => ({
		createUploadUrlMock: vi.fn(),
		processFileMock: vi.fn(),
		getStatusMock: vi.fn(),
		toastErrorMock: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		wizard: {
			tempContexts: {
				createUploadUrl: (...args: unknown[]) =>
					createUploadUrlMock(...args),
				process: (...args: unknown[]) => processFileMock(...args),
				getStatus: (...args: unknown[]) => getStatusMock(...args),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		error: (...args: unknown[]) => toastErrorMock(...args),
		success: vi.fn(),
	},
}));

import { type UploadedFile, WizardFileUploader } from "../WizardFileUploader";

function makeFile(name: string, type: string, sizeBytes = 1024): File {
	return new File([new Uint8Array(sizeBytes)], name, { type });
}

/**
 * The uploader is a controlled component — its rows live in the parent's state.
 * The mock-setter harness below is enough to assert what was *requested*, but a
 * refusal that has to persist as a removable row has to actually be rendered,
 * so these tests mount a real stateful host.
 */
function StatefulUploader() {
	const [files, setFiles] = useState<UploadedFile[]>([]);
	return (
		<WizardFileUploader
			sessionId="sess_1"
			onFileUploaded={vi.fn()}
			onFileRemoved={vi.fn()}
			uploadedFiles={files}
			setUploadedFiles={setFiles}
		/>
	);
}

/** The row a file is rendered in, found by the filename it displays. */
async function rowFor(filename: string): Promise<HTMLElement> {
	return waitFor(() => {
		const row = screen.getByText(filename).closest("div.rounded-lg");
		if (!row) {
			throw new Error(`row for ${filename} not rendered yet`);
		}
		return row as HTMLElement;
	});
}

/** A type this surface does not admit, and never has. */
const PPTX_MIME =
	"application/vnd.openxmlformats-officedocument.presentationml.presentation";

function renderUploader() {
	const setUploadedFiles = vi.fn();
	render(
		<WizardFileUploader
			sessionId="sess_1"
			onFileUploaded={vi.fn()}
			onFileRemoved={vi.fn()}
			uploadedFiles={[]}
			setUploadedFiles={setUploadedFiles}
		/>,
	);
	return { setUploadedFiles };
}

function fileInput(): HTMLInputElement {
	const input = document.querySelector(
		'input[type="file"]',
	) as HTMLInputElement | null;
	if (!input) {
		throw new Error("wizard file input not found");
	}
	return input;
}

beforeEach(() => {
	vi.clearAllMocks();
	createUploadUrlMock.mockResolvedValue({
		contextId: "ctx_1",
		signedUploadUrl: "https://storage.example.com/signed",
		useServerUpload: false,
	});
	processFileMock.mockResolvedValue({});
	getStatusMock.mockResolvedValue({ extractionStatus: "COMPLETED" });
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: true, statusText: "OK" }),
	);
});

describe("WizardFileUploader untyped files", () => {
	it("refuses an untyped oversize image against the image limit", async () => {
		const user = userEvent.setup();
		renderUploader();

		// 15 MB is under the 20 MB FILE limit the octet-stream placeholder
		// would resolve to, and over the 10 MB IMAGE limit the extension
		// resolves to. Categorizing on the placeholder lets this reach the
		// server and fail after upload.
		await user.upload(
			fileInput(),
			makeFile("photo.png", "", 15 * 1024 * 1024),
		);

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith(
				expect.stringContaining("too large"),
			);
		});
		expect(createUploadUrlMock).not.toHaveBeenCalled();
	});

	it("accepts an untyped markdown file at the larger file limit", async () => {
		const user = userEvent.setup();
		renderUploader();

		await user.upload(
			fileInput(),
			makeFile("design.md", "", 15 * 1024 * 1024),
		);

		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledWith(
				expect.objectContaining({ filename: "design.md" }),
			);
		});
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	it("uploads an untyped document rather than refusing it", async () => {
		const user = userEvent.setup();
		renderUploader();

		await user.upload(fileInput(), makeFile("spec.docx", ""));

		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledWith(
				expect.objectContaining({ filename: "spec.docx" }),
			);
		});
	});

	it("PUTs the type the server resolved", async () => {
		const user = userEvent.setup();
		createUploadUrlMock.mockResolvedValue({
			contextId: "ctx_1",
			signedUploadUrl: "https://storage.example.com/signed",
			useServerUpload: false,
			contentType: "text/markdown",
		});
		renderUploader();

		await user.upload(fileInput(), makeFile("design.md", ""));

		await waitFor(() => {
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"https://storage.example.com/signed",
				expect.objectContaining({
					method: "PUT",
					headers: { "Content-Type": "text/markdown" },
				}),
			);
		});
	});

	it("falls back to the locally resolved type when the server omits it", async () => {
		const user = userEvent.setup();
		// A new bundle against a deployment that predates the `contentType`
		// field — the default mock already omits it.
		renderUploader();

		await user.upload(fileInput(), makeFile("design.md", ""));

		await waitFor(() => {
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"https://storage.example.com/signed",
				expect.objectContaining({
					method: "PUT",
					headers: { "Content-Type": "text/markdown" },
				}),
			);
		});
	});

	it("advertises extensions on the picker so untyped files stay selectable", () => {
		renderUploader();
		const accept = fileInput().accept;
		expect(accept).toContain(".md");
		expect(accept).toContain(".pdf");
	});
});

/**
 * Pre-flight refusal. The wizard used to check size only and push the row
 * straight to `uploading`: an unsupported file started an upload, showed
 * "Uploading…", and only turned into "Failed: Unsupported file type" once the
 * server's 400 came back — one wasted round-trip per refused file. An oversize
 * file was worse: a toast and no row at all, so it vanished silently.
 *
 * `applyAccept: false` is the stand-in for drag-and-drop, which never consults
 * the `accept` attribute — the path a refused type actually arrives by.
 */
describe("WizardFileUploader pre-flight refusal", () => {
	// ── R13: refused before the network ──
	it("refuses an unsupported type without issuing an upload request", async () => {
		const user = userEvent.setup({ applyAccept: false });
		renderUploader();

		await user.upload(fileInput(), makeFile("deck.pptx", PPTX_MIME));

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith(
				expect.stringContaining("deck.pptx"),
			);
		});
		// The gate is the point: nothing was signed, and nothing was PUT.
		expect(createUploadUrlMock).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	// ── R14 + R19 + R20: the refusal names three things, persists, and speaks ──
	it("persists the refusal as a removable row and announces it", async () => {
		const user = userEvent.setup({ applyAccept: false });
		render(<StatefulUploader />);

		// The region is mounted before anything is picked — a screen reader
		// announces updates to an existing live region, not inserted nodes.
		const announcer = screen.getByTestId("wizard-upload-announcer");
		expect(announcer).toHaveAttribute("aria-live", "polite");
		expect(announcer).toBeEmptyDOMElement();

		await user.upload(fileInput(), makeFile("deck.pptx", PPTX_MIME));

		// R14 — the row names the file, the refused type, and what would have
		// been accepted.
		const row = await rowFor("deck.pptx");
		expect(row).toHaveTextContent("deck.pptx");
		expect(row).toHaveTextContent(PPTX_MIME);
		for (const label of CONTEXT_UPLOAD_FORMAT_LABELS) {
			expect(row).toHaveTextContent(label);
		}

		// R20 — the same three things reach assistive technology. Matched as a
		// substring: the announcer alternates a trailing space so a repeated
		// message still mutates the DOM.
		await waitFor(() => {
			expect(announcer).toHaveTextContent("deck.pptx");
		});
		expect(announcer).toHaveTextContent(PPTX_MIME);
		expect(announcer).toHaveTextContent(
			CONTEXT_UPLOAD_FORMAT_LABELS.join(", "),
		);

		// R19 — it is a row the user can remove, not a message that scrolls
		// away. Removing a never-uploaded row takes no delete round-trip.
		const remove = screen.getByRole("button", { name: "Remove deck.pptx" });
		await user.click(remove);
		await waitFor(() => {
			expect(screen.queryByText("deck.pptx")).not.toBeInTheDocument();
		});
	});

	// An oversize file used to produce a toast and no row whatsoever.
	it("keeps an oversize file visible as a failed row", async () => {
		const user = userEvent.setup({ applyAccept: false });
		render(<StatefulUploader />);

		await user.upload(
			fileInput(),
			makeFile("photo.png", "image/png", 15 * 1024 * 1024),
		);

		const row = await rowFor("photo.png");
		expect(row).toHaveTextContent(/too large/i);
		expect(row).toHaveTextContent("10MB maximum");
		expect(createUploadUrlMock).not.toHaveBeenCalled();
	});

	// R20 — the size gate speaks too. A refusal that only ever reached the
	// screen as an inserted `failed` row is unspoken, and the oversize path was
	// the one refusal never asserted against the live region on this surface.
	it("announces an oversize refusal too, not only an unsupported type", async () => {
		const user = userEvent.setup({ applyAccept: false });
		render(<StatefulUploader />);

		// Grabbed before the pick: assistive technology announces updates to a
		// region already in the tree, not a node inserted with its final text.
		const announcer = screen.getByTestId("wizard-upload-announcer");
		expect(announcer).toBeEmptyDOMElement();

		await user.upload(
			fileInput(),
			makeFile("photo.png", "image/png", 15 * 1024 * 1024),
		);

		await waitFor(() => {
			expect(announcer).toHaveTextContent("photo.png");
		});
		expect(announcer).toHaveTextContent(/too large/i);
	});

	// ── R3: what the vocabulary admits, this surface admits ──
	it("uploads a newly admitted XML file", async () => {
		const user = userEvent.setup({ applyAccept: false });
		renderUploader();

		// Browsers report `.xml` as `text/xml`; the vocabulary allowlists
		// `application/xml` and forces the resolution by extension.
		await user.upload(fileInput(), makeFile("sitemap.xml", "text/xml"));

		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledWith(
				expect.objectContaining({ filename: "sitemap.xml" }),
			);
		});
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	// Each file is judged on its own — a refused sibling never blocks the batch.
	it("uploads the supported files in a mixed batch and refuses only the rest", async () => {
		const user = userEvent.setup({ applyAccept: false });
		render(<StatefulUploader />);

		await user.upload(fileInput(), [
			makeFile("brief.pdf", "application/pdf"),
			makeFile("deck.pptx", PPTX_MIME),
			makeFile("notes.md", "text/markdown"),
		]);

		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledTimes(2);
		});
		const requested = createUploadUrlMock.mock.calls.map(
			(call) => (call[0] as { filename: string }).filename,
		);
		expect(requested).toEqual(["brief.pdf", "notes.md"]);

		const refused = await rowFor("deck.pptx");
		expect(refused).toHaveTextContent(PPTX_MIME);
	});

	// ── R3: the helper copy is derived from the same vocabulary as `accept` ──
	it("advertises exactly the formats the accept attribute carries", () => {
		renderUploader();
		expect(fileInput().accept).toBe(CONTEXT_UPLOAD_ACCEPT_ATTR);

		const helper = screen.getByText(/MB maximum/i);
		const advertised = CONTEXT_UPLOAD_ACCEPT_ATTR.split(",").map((ext) =>
			ext.replace(/^\./, "").toUpperCase(),
		);
		for (const label of CONTEXT_UPLOAD_FORMAT_LABELS) {
			// Every canonical label the vocabulary exposes is both advertised
			// by `accept` and named in the visible copy.
			expect(advertised).toContain(label);
			expect(helper).toHaveTextContent(label);
		}

		// Both size buckets survive the derivation.
		expect(helper).toHaveTextContent(/20MB maximum/);
		expect(helper).toHaveTextContent(/10MB maximum/);

		// And the old hand-written list is gone — it named six formats while
		// the surface accepted sixteen.
		expect(helper.textContent).not.toMatch(/images and spreadsheets/i);
	});
});
