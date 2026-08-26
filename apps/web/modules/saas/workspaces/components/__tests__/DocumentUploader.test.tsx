/**
 * Component tests for `DocumentUploader` — Group 4 of the workspace-document
 * upload bug-fix spec.
 *
 * Spec: specs/2026-05-14-workspace-document-upload-failed-fetch/spec.md
 *   §6d  – per-row state machine + Retry button
 *   §7.2 – six required test cases (covered 1:1 below)
 * Tasks: tasks.md Group 4, Task 4.4
 *
 * Mocks the oRPC client at `@shared/lib/orpc-query-utils` and global `fetch`
 * so the pipeline (`createUploadUrl → fetch PUT → confirmUpload`) is fully
 * deterministic in jsdom. No real network or auth is involved.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ──────────────────────────────────────────────────────
// Radix Dialog focus-trap + ScrollArea sizing rely on browser APIs jsdom
// does not implement.
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
	if (!HTMLElement.prototype.hasPointerCapture) {
		HTMLElement.prototype.hasPointerCapture = (() => false) as never;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────

const { createUploadUrlMock, confirmUploadMock, serverUploadMock } = vi.hoisted(
	() => ({
		createUploadUrlMock: vi.fn(),
		confirmUploadMock: vi.fn(),
		serverUploadMock: vi.fn(),
	}),
);

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		documentWorkspaces: {
			documents: {
				createUploadUrl: {
					call: (input: unknown) => createUploadUrlMock(input),
				},
				confirmUpload: {
					call: (input: unknown) => confirmUploadMock(input),
				},
				serverUpload: {
					call: (input: unknown) => serverUploadMock(input),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import {
	WORKSPACE_DOCUMENT_ACCEPT_ATTR,
	WORKSPACE_DOCUMENT_FORMAT_LABELS,
} from "@repo/utils";
import { toast } from "sonner";
import { DocumentUploader } from "../DocumentUploader";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function makePdf(name = "sample.pdf", contents = "%PDF-1.4 fake") {
	return new File([contents], name, { type: "application/pdf" });
}

async function selectFile(
	user: ReturnType<typeof userEvent.setup>,
	file: File,
) {
	const input = document.getElementById("file-upload") as HTMLInputElement;
	expect(input).toBeTruthy();
	await user.upload(input, file);
}

const happyPresign = {
	uploadUrl: "https://r2.example.com/bucket/key?signature=abc",
	s3Bucket: "workspace-documents",
	s3Path: "ws_1/123-sample.pdf",
	useServerUpload: false,
};

// ── Tests ────────────────────────────────────────────────────────────────

describe("DocumentUploader — upload pipeline + retry UI", () => {
	beforeEach(() => {
		createUploadUrlMock.mockReset();
		confirmUploadMock.mockReset();
		serverUploadMock.mockReset();
		vi.mocked(toast.error).mockClear();
		vi.mocked(toast.success).mockClear();
		vi.stubGlobal("fetch", vi.fn());
		// Silence the intentional console.error in uploadOne's catch path.
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	// (1) Spec §7.2 test 1 — bulk happy path.
	it("transitions pending → uploading → success on a successful upload", async () => {
		createUploadUrlMock.mockResolvedValue(happyPresign);
		confirmUploadMock.mockResolvedValue({ documentId: "doc_1" });
		(
			globalThis.fetch as unknown as ReturnType<typeof vi.fn>
		).mockResolvedValue(new Response(null, { status: 200 }));

		const onSuccess = vi.fn();
		const user = userEvent.setup();
		wrap(
			<DocumentUploader
				open
				onOpenChange={vi.fn()}
				workspaceId="ws_1"
				onSuccess={onSuccess}
			/>,
		);

		await selectFile(user, makePdf());

		// Row reaches "pending" state, file size is rendered.
		expect(await screen.findByText("sample.pdf")).toBeInTheDocument();

		// Click the bulk Upload button.
		await user.click(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		);

		// Pipeline calls fire in order.
		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledTimes(1);
		});
		await waitFor(() => {
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		});
		await waitFor(() => {
			expect(confirmUploadMock).toHaveBeenCalledTimes(1);
		});

		// Bulk-success path calls onSuccess once.
		await waitFor(() => {
			expect(onSuccess).toHaveBeenCalledTimes(1);
		});
	});

	// (2) Spec §7.2 test 2 — fetch throws TypeError → NETWORK_OR_CORS.
	it("renders the NETWORK_OR_CORS friendly message when PUT throws TypeError", async () => {
		createUploadUrlMock.mockResolvedValue(happyPresign);
		(
			globalThis.fetch as unknown as ReturnType<typeof vi.fn>
		).mockRejectedValue(new TypeError("Failed to fetch"));

		const user = userEvent.setup();
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		await selectFile(user, makePdf());
		await user.click(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		);

		// The mapped friendly message renders verbatim via role="alert".
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"Could not reach storage. Check your connection or contact support if this persists.",
		);

		// The raw "Failed to fetch" string MUST NOT appear in the row.
		expect(screen.queryByText(/Failed to fetch/i)).not.toBeInTheDocument();

		// confirmUpload is NEVER called when the PUT throws.
		expect(confirmUploadMock).not.toHaveBeenCalled();
	});

	// (3) Spec §7.2 test 3 — Retry button presence + a11y.
	it("renders a keyboard-focusable Retry button on error rows", async () => {
		createUploadUrlMock.mockResolvedValue(happyPresign);
		(
			globalThis.fetch as unknown as ReturnType<typeof vi.fn>
		).mockRejectedValue(new TypeError("Failed to fetch"));

		const user = userEvent.setup();
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		await selectFile(user, makePdf());
		await user.click(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		);

		// Wait for the error state to settle.
		await screen.findByRole("alert");

		// The Retry button is inside the role="group" action cluster.
		const group = screen.getByRole("group", { name: /File actions/i });
		const retryBtn = within(group).getByRole("button", {
			name: /Retry upload/i,
		});
		expect(retryBtn).toBeInTheDocument();
		expect(retryBtn).not.toBeDisabled();

		// Reachable by Tab — focusing programmatically and checking the
		// activeElement is a stable proxy for the Tab-reachability promise
		// since the button is a native <button> with default tabindex.
		retryBtn.focus();
		expect(document.activeElement).toBe(retryBtn);

		// Remove button also lives in the same group with the correct label.
		expect(
			within(group).getByRole("button", { name: /Remove file/i }),
		).toBeInTheDocument();
	});

	// (4) Spec §7.2 test 4 — retry success path fires onSuccess exactly once.
	it("transitions error → retrying → success when Retry succeeds; onSuccess fires once", async () => {
		// First PUT fails, second PUT succeeds.
		createUploadUrlMock.mockResolvedValue(happyPresign);
		confirmUploadMock.mockResolvedValue({ documentId: "doc_1" });
		(globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));

		const onSuccess = vi.fn();
		const user = userEvent.setup();
		wrap(
			<DocumentUploader
				open
				onOpenChange={vi.fn()}
				workspaceId="ws_1"
				onSuccess={onSuccess}
			/>,
		);

		await selectFile(user, makePdf());
		await user.click(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		);

		// Wait for failure state. Bulk path may or may not call onSuccess
		// (it only fires on success); confirm the row is in error.
		await screen.findByRole("alert");
		expect(onSuccess).not.toHaveBeenCalled();

		// Click Retry.
		const retryBtn = screen.getByRole("button", { name: /Retry upload/i });
		await user.click(retryBtn);

		// confirmUpload eventually fires for the second pipeline run.
		await waitFor(() => {
			expect(confirmUploadMock).toHaveBeenCalledTimes(1);
		});

		// Retry-success calls the parent's onSuccess EXACTLY once.
		await waitFor(() => {
			expect(onSuccess).toHaveBeenCalledTimes(1);
		});

		// The error alert is cleared.
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	// (5) Spec §7.2 test 5 — retry failure path keeps error, onSuccess NOT called.
	it("returns to error with a fresh message when Retry also fails; onSuccess is not called", async () => {
		createUploadUrlMock.mockResolvedValue(happyPresign);
		// Both PUT attempts fail — first with TypeError, second with 403.
		(globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(new Response(null, { status: 403 }));

		const onSuccess = vi.fn();
		const user = userEvent.setup();
		wrap(
			<DocumentUploader
				open
				onOpenChange={vi.fn()}
				workspaceId="ws_1"
				onSuccess={onSuccess}
			/>,
		);

		await selectFile(user, makePdf());
		await user.click(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		);

		// Initial error message is NETWORK_OR_CORS copy.
		const firstAlert = await screen.findByRole("alert");
		expect(firstAlert).toHaveTextContent(/Could not reach storage/i);

		// Retry → second PUT returns 403 → STORAGE_REJECTED copy.
		await user.click(screen.getByRole("button", { name: /Retry upload/i }));

		await waitFor(() => {
			expect(screen.getByRole("alert")).toHaveTextContent(
				/Upload was rejected by storage/i,
			);
		});

		// onSuccess is never called when retry also fails.
		expect(onSuccess).not.toHaveBeenCalled();

		// confirmUpload is also never called.
		expect(confirmUploadMock).not.toHaveBeenCalled();
	});

	// (6) Spec §7.2 test 6 — removing an error row clears it from the DOM.
	it("removes an error row from the DOM when the Remove button is clicked", async () => {
		createUploadUrlMock.mockResolvedValue(happyPresign);
		(
			globalThis.fetch as unknown as ReturnType<typeof vi.fn>
		).mockRejectedValue(new TypeError("Failed to fetch"));

		const user = userEvent.setup();
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		await selectFile(user, makePdf("doomed.pdf"));
		await user.click(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		);

		expect(await screen.findByText("doomed.pdf")).toBeInTheDocument();
		await screen.findByRole("alert");

		// Click Remove.
		const group = screen.getByRole("group", { name: /File actions/i });
		await user.click(
			within(group).getByRole("button", { name: /Remove file/i }),
		);

		// The row is gone — file name no longer in the DOM.
		await waitFor(() => {
			expect(screen.queryByText("doomed.pdf")).not.toBeInTheDocument();
		});
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

/**
 * Fizzy #2139 — a file the operating system has no MIME registration for.
 *
 * The browser leaves `File.type` empty in that case (and on most
 * drag-and-drops), which the picker used to read as "unsupported": `.md` was
 * refused by the same dialog that advertised MD as supported. The picker now
 * identifies the file by its extension and sends the resolved type onward.
 */
describe("DocumentUploader — untyped files and the shared vocabulary", () => {
	beforeEach(() => {
		createUploadUrlMock.mockReset();
		confirmUploadMock.mockReset();
		serverUploadMock.mockReset();
		vi.mocked(toast.error).mockClear();
		vi.mocked(toast.success).mockClear();
		vi.stubGlobal("fetch", vi.fn());
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	function untypedMarkdown(name = "design.md") {
		// The exact shape the defect produces: a real .md file whose reported
		// type is empty because the OS has no registration for the extension.
		return new File(["# Design"], name, { type: "" });
	}

	it("accepts an untyped design.md and sends text/markdown to every hop", async () => {
		createUploadUrlMock.mockResolvedValue(happyPresign);
		confirmUploadMock.mockResolvedValue({ documentId: "doc_md" });
		(
			globalThis.fetch as unknown as ReturnType<typeof vi.fn>
		).mockResolvedValue(new Response(null, { status: 200 }));

		const user = userEvent.setup();
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		await selectFile(user, untypedMarkdown());

		// Validation passed: the row exists and no rejection toast fired.
		expect(await screen.findByText("design.md")).toBeInTheDocument();
		expect(toast.error).not.toHaveBeenCalled();

		await user.click(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		);

		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: "design.md",
					mimeType: "text/markdown",
				}),
			);
		});

		// The direct browser PUT must carry the resolved type too, or the
		// stored object keeps a Content-Type extraction cannot use.
		await waitFor(() => {
			expect(globalThis.fetch).toHaveBeenCalledWith(
				happyPresign.uploadUrl,
				expect.objectContaining({
					headers: { "Content-Type": "text/markdown" },
				}),
			);
		});

		await waitFor(() => {
			expect(confirmUploadMock).toHaveBeenCalledWith(
				expect.objectContaining({
					originalFilename: "design.md",
					mimeType: "text/markdown",
				}),
			);
		});
	});

	it("sends the resolved type on the server-upload path as well", async () => {
		createUploadUrlMock.mockResolvedValue({
			uploadUrl: null,
			s3Bucket: "workspace-documents",
			s3Path: "ws_1/123-design.md",
			useServerUpload: true,
		});
		serverUploadMock.mockResolvedValue({ documentId: "doc_md" });

		const user = userEvent.setup();
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		await selectFile(user, untypedMarkdown());
		await user.click(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		);

		await waitFor(() => {
			expect(serverUploadMock).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: "design.md",
					mimeType: "text/markdown",
				}),
			);
		});
	});

	it("advertises dotted extensions in accept, not only MIME strings", () => {
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		const input = document.getElementById(
			"file-upload",
		) as HTMLInputElement;
		const accept = input.getAttribute("accept") ?? "";

		expect(accept).toBe(WORKSPACE_DOCUMENT_ACCEPT_ATTR);
		expect(accept.split(",")).toContain(".md");
		for (const entry of accept.split(",")) {
			// A MIME-only accept is what greys .md out of the OS dialog.
			expect(entry.startsWith(".")).toBe(true);
			expect(entry).not.toContain("/");
		}
	});

	// AE4 — the copy and the `accept` attribute are two projections of one
	// vocabulary, so the dialog cannot name a format the picker will not offer.
	it("names every accepted format in the dialog copy", () => {
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		const description = screen.getByText(/Supported formats:/i);
		expect(description).toHaveTextContent(
			`Supported formats: ${WORKSPACE_DOCUMENT_FORMAT_LABELS.join(", ")}.`,
		);

		// The vocabulary is exactly eleven formats. It carried five until CSV,
		// XLSX, HTML, JSON, XML and YAML were admitted — every one of them
		// extractable long before this picker offered it (Fizzy #2149). Asserted
		// as an exact set, not `toContain`: a format silently added or dropped
		// here changes what the product accepts and must fail this test.
		expect([...WORKSPACE_DOCUMENT_FORMAT_LABELS]).toEqual([
			"PDF",
			"DOCX",
			"DOC",
			"TXT",
			"MD",
			"HTML",
			"CSV",
			"XLSX",
			"JSON",
			"XML",
			"YAML",
		]);
		expect(WORKSPACE_DOCUMENT_FORMAT_LABELS).toHaveLength(11);

		// Every label the copy names is an extension the picker advertises.
		const advertised = new Set(
			WORKSPACE_DOCUMENT_ACCEPT_ATTR.split(",").map((entry) =>
				entry.replace(/^\./, "").toUpperCase(),
			),
		);
		for (const label of WORKSPACE_DOCUMENT_FORMAT_LABELS) {
			expect(advertised.has(label)).toBe(true);
		}
	});

	// AE5 — the newly admitted formats are offered, and this document library
	// still offers no image format (that is the project-context surface's extra).
	it("offers the newly admitted formats and no image format", () => {
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		const input = document.getElementById(
			"file-upload",
		) as HTMLInputElement;
		const accept = (input.getAttribute("accept") ?? "").split(",");

		for (const extension of [
			".csv",
			".xlsx",
			".html",
			".json",
			".xml",
			".yaml",
			// The alias spelling. Deriving `accept` from the MIME->extension map
			// rather than each entry's own extension list would drop it while
			// every label assertion still passed.
			".yml",
		]) {
			expect(accept).toContain(extension);
		}

		for (const image of [
			".png",
			".jpg",
			".jpeg",
			".gif",
			".webp",
			".svg",
		]) {
			expect(accept).not.toContain(image);
		}
	});

	it("still refuses a genuinely unsupported file", async () => {
		// `applyAccept: false` bypasses user-event's own accept filter, which
		// stands in for the paths the attribute never guards: drag-and-drop.
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		await selectFile(
			user,
			new File(["binary"], "archive.zip", { type: "application/zip" }),
		);

		// R19 — the refusal is a row, not a toast that scrolls away: it stays on
		// screen next to the name it refused until the user removes it.
		expect(await screen.findByText("archive.zip")).toBeInTheDocument();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"archive.zip is not a supported file type (application/zip).",
		);
		expect(createUploadUrlMock).not.toHaveBeenCalled();
	});

	it("reports the unsupported file in a mixed batch instead of dropping it silently", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		const input = document.getElementById(
			"file-upload",
		) as HTMLInputElement;
		await user.upload(input, [
			untypedMarkdown(),
			new File(["binary"], "archive.zip", { type: "application/zip" }),
		]);

		// The supported file is queued…
		expect(await screen.findByText("design.md")).toBeInTheDocument();
		// …and the unsupported one is named rather than quietly discarded.
		expect(screen.getByText("archive.zip")).toBeInTheDocument();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/archive\.zip is not a supported file type/,
		);

		// The batch reports one file to upload, not two: the refused row is not
		// pending, so it never reaches the pipeline.
		expect(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		).toBeInTheDocument();
	});
});

/**
 * Fizzy #2149 — the expanded vocabulary, the batch-capacity guard, and how a
 * refusal is presented.
 *
 * The picker used to gate through `resolveAttachmentMime` against the workspace
 * allowlist. That bypasses this surface's own forced-extension layer, which is
 * the only rescue path for `.xml`, `.json`, `.yaml` and `.yml` — the shared
 * `EXTENSION_MIME` map deliberately carries no keys for them — so the dialog
 * advertised four new formats and then refused every one of them.
 */
describe("DocumentUploader — expanded vocabulary, capacity, and refusals", () => {
	beforeEach(() => {
		createUploadUrlMock.mockReset();
		confirmUploadMock.mockReset();
		serverUploadMock.mockReset();
		vi.mocked(toast.error).mockClear();
		vi.mocked(toast.success).mockClear();
		vi.stubGlobal("fetch", vi.fn());
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	function pdfNamed(name: string) {
		return new File([`%PDF-1.4 ${name}`], name, {
			type: "application/pdf",
		});
	}

	function fileInput() {
		return document.getElementById("file-upload") as HTMLInputElement;
	}

	/** Over the 50MB ceiling, without allocating 50MB to prove it. */
	function oversized(file: File) {
		Object.defineProperty(file, "size", { value: 51 * 1024 * 1024 });
		return file;
	}

	function announcerText() {
		return (
			screen.getByTestId("workspace-document-upload-announcer")
				.textContent ?? ""
		);
	}

	// AE6 — the regression test for the wrong-resolver bug. Both files fail the
	// gate when it runs through `resolveAttachmentMime`: `.yml` because the
	// browser reports no type at all and the shared extension map has no `yml`
	// key, `.xml` because browsers report `text/xml` while the allowlist carries
	// `application/xml`. Only the forced-extension layer rescues them.
	it("accepts an untyped .yml and a text/xml-typed .xml", async () => {
		createUploadUrlMock.mockResolvedValue(happyPresign);
		confirmUploadMock.mockResolvedValue({ documentId: "doc_1" });
		(
			globalThis.fetch as unknown as ReturnType<typeof vi.fn>
		).mockResolvedValue(new Response(null, { status: 200 }));

		const user = userEvent.setup();
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		await user.upload(fileInput(), [
			new File(["service: api"], "compose.yml", { type: "" }),
			new File(["<feed/>"], "feed.xml", { type: "text/xml" }),
		]);

		expect(await screen.findByText("compose.yml")).toBeInTheDocument();
		expect(screen.getByText("feed.xml")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(toast.error).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: /Upload 2 Files/i }),
		).toBeInTheDocument();

		// And the canonical type — not the declared one — reaches the pipeline,
		// so the stored row and the extractor's input agree.
		await user.click(
			screen.getByRole("button", { name: /Upload 2 Files/i }),
		);

		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: "compose.yml",
					mimeType: "application/yaml",
				}),
			);
		});
		expect(createUploadUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				filename: "feed.xml",
				mimeType: "application/xml",
			}),
		);
	});

	// AE9 — the gate stays fail-closed after the resolver swap. `.pptx` resolves
	// to a real MIME, so a gate that tested the resolver's result for null would
	// admit it; only the allowlist lookup refuses it.
	it("still refuses a .pptx after the resolver swap", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		await selectFile(
			user,
			new File(["binary"], "deck.pptx", {
				type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			}),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/deck\.pptx is not a supported file type/,
		);
		// Nothing is queued for upload, and the Upload button stays disabled.
		expect(
			screen.getByRole("button", { name: /Upload 0 Files/i }),
		).toBeDisabled();
		expect(createUploadUrlMock).not.toHaveBeenCalled();
	});

	// R14 — a refusal names all three things: which file, what it was refused
	// as, and what would have been accepted. The bare "Unsupported file type"
	// it replaces named none of them.
	it("names the file, the refused type and the accepted formats", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		await selectFile(
			user,
			new File(["binary"], "archive.zip", { type: "application/zip" }),
		);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("archive.zip");
		expect(alert).toHaveTextContent("(application/zip)");
		expect(alert).toHaveTextContent(
			`Supported formats: ${WORKSPACE_DOCUMENT_FORMAT_LABELS.join(", ")}.`,
		);
	});

	// R19 — the refusal persists as a removable entry, and is NOT retryable:
	// the gate is deterministic, so a Retry could only refuse the file again.
	it("keeps a refusal as a removable, non-retryable row", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		await selectFile(
			user,
			new File(["binary"], "archive.zip", { type: "application/zip" }),
		);

		expect(await screen.findByText("archive.zip")).toBeInTheDocument();

		const group = screen.getByRole("group", { name: /File actions/i });
		expect(
			within(group).queryByRole("button", { name: /Retry upload/i }),
		).not.toBeInTheDocument();

		await user.click(
			within(group).getByRole("button", { name: /Remove file/i }),
		);

		await waitFor(() => {
			expect(screen.queryByText("archive.zip")).not.toBeInTheDocument();
		});
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	// The second gate. A file of an admitted type still has to clear the size
	// ceiling, and that branch is presented exactly like a type refusal: a row
	// that names the file and its limit, spoken once, removable but never
	// retryable — retrying a 51MB file only measures it again.
	it("refuses an oversize file of an admitted type as a removable, non-retryable row", async () => {
		const user = userEvent.setup();
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		const region = screen.getByTestId(
			"workspace-document-upload-announcer",
		);
		expect(region.textContent).toBe("");

		// PDF is admitted, so this clears the type gate and fails on size alone.
		// The size is stubbed rather than allocated: a real 51MB buffer costs
		// the suite 51MB of heap to assert one comparison.
		await selectFile(user, oversized(makePdf("huge.pdf")));

		const message = "huge.pdf is too large (maximum 50MB).";

		// The row names the file and the ceiling it exceeded — not a bare
		// "File too large" the user cannot act on.
		expect(await screen.findByText("huge.pdf")).toBeInTheDocument();
		expect(await screen.findByRole("alert")).toHaveTextContent(message);

		// And it reaches assistive technology, like every other refusal.
		await waitFor(() => {
			expect(announcerText()).toContain(message);
		});

		// Non-retryable: the size gate is deterministic, so a Retry could only
		// refuse the same bytes again. Removable, so it does not wedge the queue.
		const group = screen.getByRole("group", { name: /File actions/i });
		expect(
			within(group).queryByRole("button", { name: /Retry upload/i }),
		).not.toBeInTheDocument();

		// Nothing was queued for upload and nothing was signed.
		expect(
			screen.getByRole("button", { name: /Upload 0 Files/i }),
		).toBeDisabled();
		expect(createUploadUrlMock).not.toHaveBeenCalled();

		await user.click(
			within(group).getByRole("button", { name: /Remove file/i }),
		);
		await waitFor(() => {
			expect(screen.queryByText("huge.pdf")).not.toBeInTheDocument();
		});
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	// R20 — a row inserted already carrying its message is not announced by
	// assistive technology; the mounted live region is what makes it audible.
	// `announce` alternates a trailing space on a repeated identical string, so
	// this matches rather than compares.
	it("announces the refusal to assistive technology", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		// The region is mounted before any file can be picked — an inserted
		// region carrying its final text would be skipped.
		const region = screen.getByTestId(
			"workspace-document-upload-announcer",
		);
		expect(region).toHaveAttribute("aria-live", "polite");
		expect(region.textContent).toBe("");

		await selectFile(
			user,
			new File(["binary"], "archive.zip", { type: "application/zip" }),
		);

		await waitFor(() => {
			expect(announcerText()).toMatch(
				/archive\.zip is not a supported file type \(application\/zip\)/,
			);
		});
		expect(announcerText()).toMatch(/Supported formats: PDF, DOCX/);
	});

	// R20, second occurrence. Writing the identical string into the region a
	// second time leaves the text node byte-identical, no mutation reaches the
	// accessibility tree, and the repeat is silent — the user drops the same
	// wrong file twice and hears about it once. `announce`'s trailing-space
	// toggle is the whole defence, so this asserts the raw textContent actually
	// changed rather than that it still matches.
	it("re-announces when the same file is refused a second time", async () => {
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		const user = userEvent.setup();
		const dropZone = screen
			.getByText(/Drag and drop files here/i)
			.closest("div") as HTMLElement;
		const dropZip = () =>
			fireEvent.drop(dropZone, {
				dataTransfer: {
					files: [
						new File(["binary"], "archive.zip", {
							type: "application/zip",
						}),
					],
					types: ["Files"],
				},
			});

		dropZip();
		await waitFor(() => {
			expect(announcerText()).toMatch(/archive\.zip is not a supported/);
		});
		const first = announcerText();

		// Clear the row, or the second drop is deduplicated and never refused.
		await user.click(
			within(
				screen.getByRole("group", { name: /File actions/i }),
			).getByRole("button", { name: /Remove file/i }),
		);
		await waitFor(() => {
			expect(screen.queryByText("archive.zip")).not.toBeInTheDocument();
		});

		dropZip();
		await waitFor(() => {
			expect(screen.getByText("archive.zip")).toBeInTheDocument();
		});

		// Same words, different DOM text: that difference is the announcement.
		await waitFor(() => {
			expect(announcerText()).not.toBe(first);
		});
		expect(announcerText().trim()).toBe(first.trim());
	});

	// AE8 — with five of the ten batch slots remaining, selecting seven valid
	// documents accepts five and refuses two. The guard used to run before
	// per-file validation and `return` for the whole batch, discarding the five
	// that fit along with the two that did not.
	it("accepts what fits and refuses only the excess", async () => {
		const user = userEvent.setup();
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		// Fill five of the ten slots.
		await user.upload(
			fileInput(),
			[1, 2, 3, 4, 5].map((n) => pdfNamed(`first-${n}.pdf`)),
		);
		expect(
			await screen.findByRole("button", { name: /Upload 5 Files/i }),
		).toBeInTheDocument();

		// Then select seven more valid documents.
		await user.upload(
			fileInput(),
			[1, 2, 3, 4, 5, 6, 7].map((n) => pdfNamed(`second-${n}.pdf`)),
		);

		// Five are accepted — the batch is not discarded.
		expect(
			await screen.findByRole("button", { name: /Upload 10 Files/i }),
		).toBeInTheDocument();
		for (const n of [1, 2, 3, 4, 5]) {
			expect(screen.getByText(`second-${n}.pdf`)).toBeInTheDocument();
		}

		// Only the two that do not fit are refused, and the reason names them.
		for (const n of [6, 7]) {
			expect(
				screen.queryByText(`second-${n}.pdf`),
			).not.toBeInTheDocument();
		}
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringContaining("second-6.pdf, second-7.pdf"),
		);
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringContaining("up to 10 files can be queued at once"),
		);
		expect(announcerText()).toMatch(/second-6\.pdf, second-7\.pdf/);
	});

	// A duplicate never becomes a row, so it costs the queue nothing to hold and
	// must not consume a capacity slot — otherwise re-picking a folder refuses
	// the genuinely new files in it.
	it("does not charge a capacity slot to a duplicate", async () => {
		const user = userEvent.setup();
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		const first = [1, 2, 3, 4, 5, 6].map((n) => pdfNamed(`doc-${n}.pdf`));
		await user.upload(fileInput(), first);
		expect(
			await screen.findByRole("button", { name: /Upload 6 Files/i }),
		).toBeInTheDocument();

		// Re-pick the same six plus four new ones. Six duplicates + four new is
		// ten files against four remaining slots; charging the duplicates would
		// refuse every new file.
		await user.upload(fileInput(), [
			...first.map((f) => pdfNamed(f.name)),
			...[7, 8, 9, 10].map((n) => pdfNamed(`doc-${n}.pdf`)),
		]);

		expect(
			await screen.findByRole("button", { name: /Upload 10 Files/i }),
		).toBeInTheDocument();
		expect(toast.error).not.toHaveBeenCalled();
	});

	// A refused row can never become an upload, so — like a duplicate — it costs
	// the queue nothing to hold and must not consume a capacity slot. The guard
	// counted `selectedFiles.length`, refusals included, so a run of refusals
	// filled the ten slots and the next valid pick was discarded into the
	// over-capacity branch: the user watched their documents vanish into a toast
	// about a queue that holds nothing uploadable.
	//
	// The guard itself is alive and is asserted from the other direction by
	// "accepts what fits and refuses only the excess" above, where five *valid*
	// occupants do consume five slots. The only difference between the two
	// tests is the `refused` flag on the occupying rows.
	it("does not charge a capacity slot to a refused row", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		// Four refusals. Distinct filenames — the queue dedupes on `name:size`,
		// so four copies of one name would collapse into a single row and prove
		// nothing about capacity.
		await user.upload(
			fileInput(),
			[1, 2, 3, 4].map(
				(n) =>
					new File(["binary"], `archive-${n}.zip`, {
						type: "application/zip",
					}),
			),
		);

		await waitFor(() => {
			expect(screen.getByText("archive-4.zip")).toBeInTheDocument();
		});
		// Four rows, none of them uploadable.
		expect(
			screen.getByRole("button", { name: /Upload 0 Files/i }),
		).toBeDisabled();

		// Now a full queue's worth of valid documents. Charging the four
		// refusals leaves six slots and silently discards four of these.
		await user.upload(
			fileInput(),
			[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
				pdfNamed(`doc-${n}.pdf`),
			),
		);

		expect(
			await screen.findByRole("button", { name: /Upload 10 Files/i }),
		).toBeInTheDocument();
		for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
			expect(screen.getByText(`doc-${n}.pdf`)).toBeInTheDocument();
		}

		// Nothing was refused for capacity — no toast, no announcement.
		expect(toast.error).not.toHaveBeenCalled();
		expect(announcerText()).not.toMatch(/can be queued at once/);

		// And the refusals are still on screen: not consuming a slot is not the
		// same as being dropped.
		expect(screen.getByText("archive-1.zip")).toBeInTheDocument();
	});

	// The picker's own input has to be cleared after every selection. A file
	// input's `value` is unchanged when the user re-picks the same file, so the
	// browser fires no `change` event at all and the picker appears to ignore
	// them — the exact moment a user is most likely to re-pick is right after
	// removing the row they just added by mistake.
	it("admits the same file again through the input after its row is removed", async () => {
		const user = userEvent.setup();
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		// One `File` instance, picked twice. Identity is what the browser (and
		// user-event, faithfully) compares to decide the selection changed — a
		// freshly constructed twin would fire `change` either way and prove
		// nothing.
		const file = pdfNamed("second-thoughts.pdf");

		await user.upload(fileInput(), file);
		expect(
			await screen.findByText("second-thoughts.pdf"),
		).toBeInTheDocument();

		await user.click(
			within(
				screen.getByRole("group", { name: /File actions/i }),
			).getByRole("button", { name: /Remove file/i }),
		);
		await waitFor(() => {
			expect(
				screen.queryByText("second-thoughts.pdf"),
			).not.toBeInTheDocument();
		});

		// Re-picking the very same file is admitted a second time.
		await user.upload(fileInput(), file);

		expect(
			await screen.findByText("second-thoughts.pdf"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		).toBeInTheDocument();
	});

	// The picker and the drop zone share `handleFileSelect`, so every gate above
	// guards both. Drag-and-drop is the path the `accept` attribute never
	// filters, which is exactly why it must refuse identically.
	it("gates drag-and-drop identically to the file picker", async () => {
		wrap(
			<DocumentUploader open onOpenChange={vi.fn()} workspaceId="ws_1" />,
		);

		const dropZone = screen
			.getByText(/Drag and drop files here/i)
			.closest("div") as HTMLElement;

		fireEvent.drop(dropZone, {
			dataTransfer: {
				files: [
					new File(["service: api"], "compose.yml", { type: "" }),
					new File(["binary"], "archive.zip", {
						type: "application/zip",
					}),
				],
				types: ["Files"],
			},
		});

		// The supported file queues…
		expect(await screen.findByText("compose.yml")).toBeInTheDocument();
		// …and the unsupported one is refused with the same named reason.
		expect(screen.getByText("archive.zip")).toBeInTheDocument();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/archive\.zip is not a supported file type \(application\/zip\)/,
		);
		expect(
			screen.getByRole("button", { name: /Upload 1 File/i }),
		).toBeInTheDocument();
	});
});
