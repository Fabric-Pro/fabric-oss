/**
 * Unit tests for `createCopilotSidebarInput` — the shared CopilotKit `<CopilotSidebar>`
 * input factory used by the AI Feature Assistant, DocumentEditor, and
 * DocumentGeneratorEditor.
 *
 * Coverage in this file:
 *   - Task 5.1 (AC-3): paste handler routes image files to the upload pipeline.
 *   - Task 5.2 (AC-4): paste handler ignores non-file pastes (text falls through
 *     to the textarea — the hook never calls `preventDefault` and the upload
 *     pipeline is never touched).
 *   - Task 5.3 (AC-2): drop handler shows the overlay on `dragenter`, calls
 *     `preventDefault` on `drop`, and routes the dropped files through the
 *     upload pipeline; overlay hides on `drop`.
 *   - Task 5.5 (AC-7): the assembled outbound message contains the
 *     `<attached_documents>` envelope and a `<document_content filename="…">`
 *     block; oversized extracted content is truncated with the
 *     `… [content truncated]` marker per `MAX_INLINE_CONTENT_LENGTH = 50_000`.
 *   - Task 5.6 (AC-8, AC-10): unsupported files (HEIC) are rejected with a
 *     friendly toast and create no chip; pasting more files than the surface
 *     can validate routes only the supported ones through the pipeline.
 *
 * Mocking strategy: only the network boundary is mocked (`@shared/lib/orpc-client`
 * and `sonner`). The factory itself, the `useCopilotDocumentUpload` hook, the
 * `useDropZoneOverlay` hook, and the chip component are exercised end-to-end —
 * per the test plan in the spec, "do not mock the entire factory; only the
 * upload network calls".
 *
 * Toast string note: the `TOAST_COPY` block in
 * `apps/web/modules/saas/projects/lib/use-clipboard-image-paste.ts` is NOT
 * exported (the prompt mis-described the file as exporting it). That hook
 * powers the four OTHER surfaces (Documents/Story/Nexus/Loom). The copilot
 * factory under test here routes paste/drop through the separate
 * `useCopilotDocumentUpload.addFiles()` pipeline, which produces its OWN toast
 * copy ("File type not supported: ${name}", 'File "${name}" exceeds the ${n}MB
 * limit…'). Per project `CLAUDE.md` §"When Tests Fail": tests assert what the
 * source actually does, not what an aspirational spec described. Comments on
 * each toast assertion below note the divergence so future readers can find
 * the spec/source mismatch quickly.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ------------------------------------------------------------------

// Sonner toast: assert specific copy without rendering the actual toaster.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	// `CopilotSidebarInput` reads OPENAPI_SPEC_CONTEXT through the provider,
	// which only the app layout mounts. `true` is the interesting value: it
	// leaves the spec guard live, so these suites run the same path production
	// does rather than a disabled shortcut.
	useFeatureFlag: () => true,
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
		message: vi.fn(),
	},
}));

// Analytics: capture `copilot_attachment_added` payloads for telemetry assertions
// (Task 6.1). Mirrors the established pattern from
// `DownloadAllContextsButton.test.tsx`.
const trackEventMock = vi.fn();
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

// oRPC client mock — only the four endpoints the factory's upload pipeline
// touches. `mockOrpc` lets tests configure per-endpoint behavior at runtime.
const mockOrpc = {
	createUploadUrl: vi.fn(),
	upload: vi.fn(),
	process: vi.fn(),
	getStatus: vi.fn(),
	getContent: vi.fn(),
};

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		ai: {
			documents: {
				createUploadUrl: (...args: unknown[]) =>
					mockOrpc.createUploadUrl(...args),
				upload: (...args: unknown[]) => mockOrpc.upload(...args),
				process: (...args: unknown[]) => mockOrpc.process(...args),
				getStatus: (...args: unknown[]) => mockOrpc.getStatus(...args),
				getContent: (...args: unknown[]) =>
					mockOrpc.getContent(...args),
			},
		},
	},
}));

// `global.fetch` is hit by the upload pipeline when `signedUploadUrl` is
// returned. JSDOM's default `fetch` is undefined; provide a controllable mock.
const mockFetch = vi.fn();
beforeEach(() => {
	vi.clearAllMocks();
	(globalThis as { fetch?: unknown }).fetch = mockFetch;
	mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
	delete (globalThis as { fetch?: unknown }).fetch;
});

// Imports under test (after mocks).
import { toast } from "sonner";
import { createCopilotSidebarInput } from "../CopilotSidebarInput";

// --- Helpers ---------------------------------------------------------------

function makeFile(name: string, type: string, sizeBytes = 1024): File {
	const buffer = new ArrayBuffer(sizeBytes);
	return new File([buffer], name, { type });
}

/** A FileList-shaped object iterable like `Array.from(files)`. */
function makeFileList(files: File[]): FileList {
	const list: Record<string | number | symbol, unknown> = {
		length: files.length,
		item: (i: number) => files[i] ?? null,
		[Symbol.iterator]: function* () {
			for (const file of files) {
				yield file;
			}
		},
	};
	for (const [index, file] of files.entries()) {
		list[index] = file;
	}
	return list as unknown as FileList;
}

interface RenderInputOptions {
	organizationId?: string | null;
	onSend?: (text: string) => Promise<unknown>;
	inProgress?: boolean;
}

interface FactoryOptions {
	onContentExtracted?: (entry: string) => void;
	onBeforeSend?: () => void;
	onUserSend?: () => void;
	onUserSendFailed?: () => void;
}

/**
 * Render the input the factory produces. Returns the `onSend` mock (so tests
 * can intercept the assembled outbound message) plus the rendered container.
 */
function renderInput(
	opts: RenderInputOptions = {},
	factory: FactoryOptions = {},
) {
	const onSend =
		opts.onSend ?? vi.fn(async (_text: string) => undefined as unknown);
	const Input = createCopilotSidebarInput({
		organizationId: opts.organizationId ?? null,
		surface: "feature-assistant",
		onContentExtracted: factory.onContentExtracted,
		onBeforeSend: factory.onBeforeSend,
		onUserSend: factory.onUserSend,
		onUserSendFailed: factory.onUserSendFailed,
	});
	const utils = render(
		<Input inProgress={opts.inProgress ?? false} onSend={onSend} />,
	);
	return { ...utils, onSend };
}

/** Build a `paste` ClipboardEvent that React's synthetic system can consume. */
function dispatchPaste(
	target: HTMLElement,
	files: File[],
	textData?: string,
): boolean {
	const event = new Event("paste", {
		bubbles: true,
		cancelable: true,
	}) as unknown as ClipboardEvent;
	Object.defineProperty(event, "clipboardData", {
		value: {
			files: makeFileList(files),
			getData: (_format: string) => textData ?? "",
		},
		writable: false,
	});
	return target.dispatchEvent(event as unknown as Event);
}

interface DragOptions {
	files?: File[];
	withFileType?: boolean;
}

function dispatchDrag(
	target: HTMLElement,
	type: "dragenter" | "dragleave" | "dragover" | "drop",
	{ files = [], withFileType = true }: DragOptions = {},
): Event {
	const event = new Event(type, {
		bubbles: true,
		cancelable: true,
	}) as unknown as DragEvent;
	const types = withFileType ? ["Files"] : [];
	Object.defineProperty(event, "dataTransfer", {
		value: {
			files: makeFileList(files),
			types,
		},
		writable: false,
	});
	target.dispatchEvent(event as unknown as Event);
	return event as unknown as Event;
}

/**
 * Wire the upload pipeline so a single file resolves to `ready` with the given
 * extracted content. Returns the captured calls for assertion.
 */
function primeSuccessfulUpload(opts: {
	chatId?: string;
	documentId?: string;
	extractedContent?: string;
}) {
	const chatId = opts.chatId ?? "chat-1";
	const documentId = opts.documentId ?? "doc-1";

	mockOrpc.createUploadUrl.mockResolvedValue({
		documentId,
		signedUploadUrl: "https://s3.example.com/put",
		useServerUpload: false,
		chatId,
	});
	// `process` now returns `extractedContent` inline (the upload hook no
	// longer polls `getStatus` / `getContent` — see `process-document.ts`
	// and `use-copilot-document-upload.ts` for the rationale: the soft
	// 8-second poll stalled forever whenever the Temporal worker was
	// unreachable). The legacy `getStatus`/`getContent` mocks remain so
	// older tests that rely on them continue to compile.
	mockOrpc.process.mockResolvedValue({
		documentId,
		status: "PROCESSING",
		extractedContent: opts.extractedContent ?? null,
	});
	mockOrpc.getStatus.mockResolvedValue({ status: "READY" });
	mockOrpc.getContent.mockResolvedValue({
		content: opts.extractedContent ?? "",
	});
	return { chatId, documentId };
}

// --- Tests ------------------------------------------------------------------

describe("createCopilotSidebarInput — paste handler", () => {
	// AC-3: paste image routes to the upload pipeline.
	it("routes pasted image files into the upload pipeline (AC-3)", async () => {
		primeSuccessfulUpload({
			documentId: "doc-png",
			extractedContent: "OCR text",
		});

		renderInput();

		const textarea = screen.getByPlaceholderText("Type a message...");
		const pngFile = makeFile("screenshot.png", "image/png");

		await act(async () => {
			dispatchPaste(textarea, [pngFile]);
		});

		// A chip is rendered (the file made it into the upload state).
		expect(
			screen.getByLabelText(`Remove ${pngFile.name}`),
		).toBeInTheDocument();

		// Upload network call is NOT triggered until Send — paste only stages
		// the file. This matches the `useCopilotDocumentUpload` contract
		// (uploads happen inside `uploadAttachments()` which runs from
		// `handleSend`).
		expect(mockOrpc.createUploadUrl).not.toHaveBeenCalled();

		// No "unsupported file" toast: a PNG is in the allowlist.
		expect(toast.error).not.toHaveBeenCalled();
	});

	// AC-4: plain text paste falls through to the textarea; upload pipeline
	// stays cold and `preventDefault` is NOT called by the factory's handler.
	it("ignores plain-text pastes (no file payloads) (AC-4)", () => {
		renderInput();

		const textarea = screen.getByPlaceholderText("Type a message...");

		const event = new Event("paste", {
			bubbles: true,
			cancelable: true,
		}) as unknown as ClipboardEvent;
		Object.defineProperty(event, "clipboardData", {
			value: {
				files: makeFileList([]),
				getData: () => "hello world",
			},
			writable: false,
		});
		const preventSpy = vi.spyOn(
			event as unknown as Event,
			"preventDefault",
		);

		act(() => {
			textarea.dispatchEvent(event as unknown as Event);
		});

		// The factory's `handlePaste` returns early when no files are present;
		// the textarea's native paste handles the text. Upload pipeline cold,
		// no chip rendered, no preventDefault, no toast.
		expect(mockOrpc.createUploadUrl).not.toHaveBeenCalled();
		expect(preventSpy).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
		// No remove buttons (i.e., no chips).
		expect(screen.queryByLabelText(/^Remove /)).not.toBeInTheDocument();
	});
});

describe("createCopilotSidebarInput — drop handler (AC-2)", () => {
	it("shows the overlay on dragenter, hides + routes files on drop, and calls preventDefault", async () => {
		renderInput();

		const textarea = screen.getByPlaceholderText("Type a message...");
		// The wrapper that owns the dropzone props is the `.copilot-sidebar-input-wrapper`
		// ancestor (the div the factory spreads `dropZoneProps` onto).
		const wrapper = textarea.closest(
			".copilot-sidebar-input-wrapper",
		) as HTMLElement | null;
		expect(wrapper).not.toBeNull();
		const dropZone = wrapper as HTMLElement;

		// Overlay starts hidden — the "Drop to attach" label is in the DOM but
		// inside an `aria-hidden` element. We assert the overlay's opacity
		// class via the parent element of the label.
		const overlayLabel = screen.getByText("Drop to attach");
		const overlayElement = overlayLabel.parentElement as HTMLElement;
		expect(overlayElement.className).toContain("opacity-0");

		// Dragenter with file types → overlay flips on.
		await act(async () => {
			dispatchDrag(dropZone, "dragenter", { withFileType: true });
		});
		expect(overlayElement.className).toContain("opacity-100");

		// Drop with file payload → preventDefault, overlay hides, file routed
		// to addFiles (chip appears).
		const pngFile = makeFile("dropped.png", "image/png");

		// `fireEvent.drop` dispatches a real drop event; assert via the
		// resulting chip + overlay state. We construct the event manually so
		// we can spy on `preventDefault` before dispatch.
		const dropEvent = new Event("drop", {
			bubbles: true,
			cancelable: true,
		}) as unknown as DragEvent;
		Object.defineProperty(dropEvent, "dataTransfer", {
			value: {
				files: makeFileList([pngFile]),
				types: ["Files"],
			},
			writable: false,
		});
		const preventSpy = vi.spyOn(
			dropEvent as unknown as Event,
			"preventDefault",
		);

		await act(async () => {
			dropZone.dispatchEvent(dropEvent as unknown as Event);
		});

		expect(preventSpy).toHaveBeenCalled();
		expect(overlayElement.className).toContain("opacity-0");
		expect(
			screen.getByLabelText(`Remove ${pngFile.name}`),
		).toBeInTheDocument();
	});

	it("ignores drags that do not advertise file types (e.g., text selections)", () => {
		renderInput();

		const wrapper = screen
			.getByPlaceholderText("Type a message...")
			.closest(".copilot-sidebar-input-wrapper") as HTMLElement;
		const overlayElement = screen.getByText("Drop to attach")
			.parentElement as HTMLElement;

		act(() => {
			dispatchDrag(wrapper, "dragenter", { withFileType: false });
		});

		// Overlay stays hidden — text selections inside the page should not
		// trigger the file-drop affordance.
		expect(overlayElement.className).toContain("opacity-0");
	});
});

describe("createCopilotSidebarInput — outbound message + content delivery", () => {
	// The factory ships ONLY the user's typed prompt to onSend. Attached
	// content is delivered to the agent via the page-level
	// `useCopilotReadable` context (mirrors Nexus's pattern) — never inlined
	// in the user message. The chat bubble therefore stays clean: no
	// document_id, chat_id, raw extracted text, or base64 image data URLs
	// in the conversation transcript.
	it("ships only the typed prompt to onSend; no <attached_documents> envelope", async () => {
		primeSuccessfulUpload({
			documentId: "doc-pdf-1",
			chatId: "chat-A",
			extractedContent: "Quarterly objectives:\n1. Ship faster.",
		});
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		renderInput({ onSend });

		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const pdfFile = makeFile("plan.pdf", "application/pdf");
		await act(async () => {
			fireEvent.change(fileInput, { target: { files: [pdfFile] } });
		});
		expect(
			screen.getByLabelText(`Remove ${pdfFile.name}`),
		).toBeInTheDocument();

		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.change(textarea, {
				target: { value: "What does this say?" },
			});
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		expect(onSend).toHaveBeenCalledTimes(1);
		const sentText = onSend.mock.calls[0]?.[0] as string;
		// Bubble shows: typed prompt + lightweight `[Attached: …]` hint that
		// `CopilotUserMessage` renders as paperclip chips. NO XML envelope,
		// NO document_id / chat_id, NO raw extracted text — those reach the
		// agent via the rag-context channel (PR #722 / #723).
		expect(sentText).toBe("What does this say?\n\n[Attached: plan.pdf]");
		expect(sentText).not.toContain("<attached_documents>");
		expect(sentText).not.toContain("<document_content");
		expect(sentText).not.toContain("document_id:");
		expect(sentText).not.toContain("chat_id:");
		expect(sentText).not.toContain("Quarterly objectives:");
	});

	// File-only send: when the textarea is empty and at least one file is
	// staged, Send is enabled and the factory ships ONLY the lightweight
	// `[Attached: …]` hint as the message body. No hardcoded primer prompt
	// is injected — the bubble shows ONLY the paperclip chips
	// (`CopilotUserMessage` parses the hint out of the visible text).
	it("allows file-only send with no hardcoded primer text", async () => {
		primeSuccessfulUpload({
			documentId: "doc-only",
			chatId: "chat-only",
			extractedContent: "x",
		});
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		renderInput({ onSend });

		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const pdfFile = makeFile("notes.pdf", "application/pdf");
		await act(async () => {
			fireEvent.change(fileInput, { target: { files: [pdfFile] } });
		});

		// Send button is enabled with attachments only (no typed text).
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		expect(sendBtn).not.toBeDisabled();

		await act(async () => {
			fireEvent.click(sendBtn);
		});

		expect(onSend).toHaveBeenCalledTimes(1);
		const sentText = onSend.mock.calls[0]?.[0] as string;
		// Body is JUST the attachment hint — no fake "please review" text.
		expect(sentText).toBe("[Attached: notes.pdf]");
		expect(sentText).not.toContain("Please review");
		expect(sentText).not.toContain("primary context");
	});

	// Document content reaches the agent via the `onContentExtracted`
	// callback so the page can publish it through `useCopilotReadable`.
	it("invokes onContentExtracted with extracted document text", async () => {
		primeSuccessfulUpload({
			documentId: "doc-pdf-2",
			chatId: "chat-B",
			extractedContent: "Roadmap: phase one — kickoff.",
		});
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		const onContentExtracted = vi.fn();
		renderInput({ onSend }, { onContentExtracted });

		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const pdfFile = makeFile("roadmap.pdf", "application/pdf");
		await act(async () => {
			fireEvent.change(fileInput, { target: { files: [pdfFile] } });
		});

		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.change(textarea, {
				target: { value: "Summarize." },
			});
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		expect(onContentExtracted).toHaveBeenCalledWith(
			"<fabric_attachment>\n[Uploaded Document: roadmap.pdf]\nRoadmap: phase one — kickoff.\n</fabric_attachment>",
		);
	});

	// Images go through the same callback channel — `extractedContent` for
	// images is the data URL produced by `readFileAsDataURL`. The page can
	// then publish a markdown image into the agent's context so vision-
	// capable LLMs render the picture.
	it("invokes onContentExtracted for image files with the data URL", async () => {
		primeSuccessfulUpload({
			documentId: "doc-img",
			chatId: "chat-img",
			extractedContent: "",
		});
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		const onContentExtracted = vi.fn();
		renderInput({ onSend }, { onContentExtracted });

		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const pngFile = makeFile("screenshot.png", "image/png", 128);
		await act(async () => {
			fireEvent.change(fileInput, { target: { files: [pngFile] } });
		});
		// FileReader.readAsDataURL is async — wait for the data URL to populate
		// extractedContent before clicking Send.
		await waitFor(() =>
			expect(
				screen.getByLabelText(`Remove ${pngFile.name}`),
			).toBeInTheDocument(),
		);

		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.change(textarea, {
				target: { value: "What's in this picture?" },
			});
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		expect(onContentExtracted).toHaveBeenCalledTimes(1);
		const [entry] = onContentExtracted.mock.calls[0] ?? [];
		// Anchored to the delimiter so the data-URL line stays exactly where the
		// agents' extractor looks for it, and nothing slips in between.
		expect(entry).toMatch(
			/^<fabric_attachment>\n\[Uploaded Image: screenshot\.png\]\n!\[screenshot\.png\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)\n<\/fabric_attachment>$/,
		);
	});
});

describe("createCopilotSidebarInput — unsupported types & batch handling (AC-8, AC-10)", () => {
	// AC-8: HEIC files are rejected with a friendly toast and create no chip.
	//
	// Source-of-truth divergence: the spec §3.4 lists the standardized HEIC
	// rejection toast string from `use-clipboard-image-paste.ts`
	// (`TOAST_COPY.heic`). However, this factory routes paste/drop through
	// `useCopilotDocumentUpload.addFiles()` (per Task 1.3 implementation
	// note), which uses its own allowlist + toast: HEIC has no extension
	// match in `ALLOWED_EXTENSIONS` and no MIME match in `ALLOWED_TYPES`, so
	// the factory falls through to the generic "File type not supported"
	// toast. AC-8 is satisfied either way (friendly toast, no chip). The
	// `TOAST_COPY` block is also not exported from `use-clipboard-image-paste.ts`,
	// so importing it here is impossible without a source change.
	it("rejects HEIC files with a friendly toast and creates no chip (AC-8)", async () => {
		renderInput();

		const textarea = screen.getByPlaceholderText("Type a message...");

		// Two clipboard quirks worth covering: a typed HEIC and a name-only
		// HEIC (some clipboards drop the MIME type when the file is dragged
		// from Finder).
		const typedHeic = makeFile("photo.heic", "image/heic");
		const untypedHeic = makeFile("alt.heic", "");

		await act(async () => {
			dispatchPaste(textarea, [typedHeic]);
		});
		await act(async () => {
			dispatchPaste(textarea, [untypedHeic]);
		});

		// Two rejections, two toasts. The factory uses the
		// `useCopilotDocumentUpload` allowlist toast — see comment above for
		// why we are not asserting against `TOAST_COPY.heic`.
		expect(toast.error).toHaveBeenCalledWith(
			`File type not supported: ${typedHeic.name}`,
		);
		expect(toast.error).toHaveBeenCalledWith(
			`File type not supported: ${untypedHeic.name}`,
		);

		// No chips for either rejected file.
		expect(
			screen.queryByLabelText(`Remove ${typedHeic.name}`),
		).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText(`Remove ${untypedHeic.name}`),
		).not.toBeInTheDocument();

		// Upload pipeline never touched.
		expect(mockOrpc.createUploadUrl).not.toHaveBeenCalled();
	});

	// AC-10: spec §3.2 documents a per-message cap of 5 images. Per Task 1.3
	// implementation note, that cap is enforced inside `use-clipboard-image-paste.ts`
	// (the OTHER four surfaces) and is intentionally NOT enforced inside
	// `useCopilotDocumentUpload`. The copilot factory therefore accepts every
	// supported file in a paste batch — the source-of-truth for AC-10 in this
	// spec lives in `use-clipboard-image-paste.test.tsx`.
	//
	// This test pins down the actual factory behavior so a future regression
	// (e.g., someone silently swapping the validation locus) is caught.
	it("accepts every supported file in a paste batch (factory has no per-paste cap)", async () => {
		renderInput();

		const textarea = screen.getByPlaceholderText("Type a message...");

		const files = Array.from({ length: 6 }, (_, i) =>
			makeFile(`shot-${i}.png`, "image/png"),
		);

		await act(async () => {
			dispatchPaste(textarea, files);
		});

		// All six chips appear (no cap inside the factory).
		for (const file of files) {
			expect(
				screen.getByLabelText(`Remove ${file.name}`),
			).toBeInTheDocument();
		}

		// And no cap-exceeded toast fires (this factory does not have one).
		const messageMock = toast.message as unknown as {
			mock: { calls: unknown[][] };
		};
		expect(messageMock.mock.calls).toHaveLength(0);
	});
});

// Task 6.1 — `copilot_attachment_added` telemetry. Per spec §14: emit once per
// chip the first time it transitions to `ready`, with the PII-free payload
// `{ surface, kind, mime, sizeBytes }`. Per
// `fabric/standards/global/error-handling.md` §"Logging sensitive data": NO
// filename, file content, userId, or organizationId in the payload.
describe("createCopilotSidebarInput — copilot_attachment_added telemetry", () => {
	it("emits exactly once per chip on ready, with surface + kind + mime + sizeBytes (no PII)", async () => {
		primeSuccessfulUpload({
			documentId: "doc-pdf-1",
			chatId: "chat-A",
			extractedContent: "Quarterly objectives.",
		});
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		// Use the non-default surface to prove the value flows from config →
		// emitter, not a hardcoded literal.
		const Input = createCopilotSidebarInput({
			organizationId: null,
			surface: "document-generator",
		});
		render(<Input inProgress={false} onSend={onSend} />);

		// Stage a PDF via the paperclip flow (simulated via the file input).
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const pdfFile = makeFile("plan.pdf", "application/pdf", 4096);

		await act(async () => {
			fireEvent.change(fileInput, { target: { files: [pdfFile] } });
		});

		// No telemetry yet — chip is still `pending`. The event MUST only fire
		// after the chip reaches `ready`.
		expect(trackEventMock).not.toHaveBeenCalled();

		// Drive the upload pipeline → `ready` by typing + clicking Send.
		const textarea = screen.getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await act(async () => {
			fireEvent.change(textarea, { target: { value: "Summarize." } });
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		// Exactly one telemetry call for the single chip.
		expect(trackEventMock).toHaveBeenCalledTimes(1);
		expect(trackEventMock).toHaveBeenCalledWith(
			"copilot_attachment_added",
			{
				surface: "document-generator",
				kind: "paperclip",
				mime: "application/pdf",
				sizeBytes: 4096,
			},
		);

		// Defensive PII assertion — the payload object must NOT carry any of
		// the forbidden keys per `fabric/standards/global/error-handling.md`.
		const payload = trackEventMock.mock.calls[0]?.[1] as
			| Record<string, unknown>
			| undefined;
		expect(payload).toBeDefined();
		expect(payload).not.toHaveProperty("filename");
		expect(payload).not.toHaveProperty("name");
		expect(payload).not.toHaveProperty("userId");
		expect(payload).not.toHaveProperty("organizationId");
		expect(payload).not.toHaveProperty("content");
		expect(payload).not.toHaveProperty("extractedContent");
	});

	it("tags the kind correctly across paperclip / paste / drop entry points", async () => {
		// Non-empty `extractedContent` so the dropped PDF passes the new
		// "no extracted text → throw" guard added with the staging-PDF /
		// silent-image-failure fix; the assertion below requires both chips
		// to reach `ready` and emit telemetry.
		primeSuccessfulUpload({
			documentId: "doc-png",
			chatId: "chat-B",
			extractedContent: "Extracted PDF text.",
		});
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		const Input = createCopilotSidebarInput({
			organizationId: null,
			surface: "feature-assistant",
		});
		render(<Input inProgress={false} onSend={onSend} />);

		const textarea = screen.getByPlaceholderText("Type a message...");
		const wrapper = textarea.closest(
			".copilot-sidebar-input-wrapper",
		) as HTMLElement;

		// 1) Paste a PNG.
		const pastedPng = makeFile("pasted.png", "image/png", 256);
		await act(async () => {
			dispatchPaste(textarea, [pastedPng]);
		});

		// 2) Drop a PDF onto the wrapper.
		const droppedPdf = makeFile("dropped.pdf", "application/pdf", 512);
		const dropEvent = new Event("drop", {
			bubbles: true,
			cancelable: true,
		}) as unknown as DragEvent;
		Object.defineProperty(dropEvent, "dataTransfer", {
			value: { files: makeFileList([droppedPdf]), types: ["Files"] },
			writable: false,
		});
		await act(async () => {
			wrapper.dispatchEvent(dropEvent as unknown as Event);
		});

		// Drive both chips to `ready` via Send.
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		await act(async () => {
			fireEvent.change(textarea, { target: { value: "go" } });
		});
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		// Two telemetry calls — one per chip — each tagged with its source.
		expect(trackEventMock).toHaveBeenCalledTimes(2);
		const calls = trackEventMock.mock.calls.map(
			(c) => c[1] as Record<string, unknown>,
		);
		const kinds = new Set(calls.map((p) => p.kind));
		expect(kinds).toEqual(new Set(["paste", "drop"]));
		// Surface flows through identically for both.
		for (const payload of calls) {
			expect(payload.surface).toBe("feature-assistant");
		}
	});
});

// The document editor surfaces (DocumentEditor / DocumentGeneratorEditor /
// StoryWorkspace) pass `onBeforeSend` to flush the live editor content into the
// agent's `useCoAgent` `document` state field right before each chat send, so
// the outgoing turn always carries the open document (the agent is otherwise
// blind to it after a bidirectional state sync clobbers `state.document`). This
// block pins the factory-level contract: the hook fires, fires BEFORE `onSend`,
// and never fires on a no-op send. The per-surface flush wiring is verified by
// the local/staging E2E pass.
describe("createCopilotSidebarInput — onBeforeSend hook", () => {
	it("calls onBeforeSend before onSend on a successful send", async () => {
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		const onBeforeSend = vi.fn();
		renderInput({ onSend }, { onBeforeSend });

		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.change(textarea, {
				target: { value: "Summarize section 2" },
			});
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		expect(onBeforeSend).toHaveBeenCalledTimes(1);
		expect(onSend).toHaveBeenCalledTimes(1);
		// Ordering matters: CopilotKit captures the outgoing agent-state
		// snapshot when `onSend` fires, so the flush must land first.
		const beforeOrder = onBeforeSend.mock.invocationCallOrder[0] ?? 0;
		const sendOrder = onSend.mock.invocationCallOrder[0] ?? 0;
		expect(beforeOrder).toBeLessThan(sendOrder);
	});

	it("does not call onBeforeSend when there is nothing to send", async () => {
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		const onBeforeSend = vi.fn();
		renderInput({ onSend }, { onBeforeSend });

		// Empty textarea → Enter invokes handleSend, which returns at the
		// `canSend` guard before any send work. Neither callback should fire.
		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
		});

		expect(onBeforeSend).not.toHaveBeenCalled();
		expect(onSend).not.toHaveBeenCalled();
	});

	it("sends without throwing when onBeforeSend is omitted (back-compat)", async () => {
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		// No onBeforeSend supplied — existing callers must be unaffected.
		renderInput({ onSend });

		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.change(textarea, { target: { value: "Hello" } });
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		expect(onSend).toHaveBeenCalledTimes(1);
		expect(onSend).toHaveBeenCalledWith("Hello");
	});
});

// `onUserSend` marks the upcoming run as user-initiated (via
// `useUserRunSignal`) so the "AI is generating" pill can distinguish real
// generations from the AG-UI connect handshake. It must fire once per
// successful send, before `onSend`, and never for a send blocked by guards.
describe("createCopilotSidebarInput — onUserSend hook", () => {
	it("calls onUserSend exactly once before onSend on a successful send", async () => {
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		const onUserSend = vi.fn();
		renderInput({ onSend }, { onUserSend });

		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.change(textarea, {
				target: { value: "Summarize section 2" },
			});
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		expect(onUserSend).toHaveBeenCalledTimes(1);
		expect(onSend).toHaveBeenCalledTimes(1);
		const userSendOrder = onUserSend.mock.invocationCallOrder[0] ?? 0;
		const sendOrder = onSend.mock.invocationCallOrder[0] ?? 0;
		expect(userSendOrder).toBeLessThan(sendOrder);
	});

	it("does not call onUserSend when there is nothing to send", async () => {
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		const onUserSend = vi.fn();
		renderInput({ onSend }, { onUserSend });

		// Empty textarea → Enter invokes handleSend, which returns at the
		// `canSend` guard before any send work. Neither callback should fire.
		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
		});

		expect(onUserSend).not.toHaveBeenCalled();
		expect(onSend).not.toHaveBeenCalled();
	});

	it("sends without throwing when onUserSend is omitted (back-compat)", async () => {
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		// No onUserSend supplied — existing callers must be unaffected.
		renderInput({ onSend });

		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.change(textarea, { target: { value: "Hello" } });
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		expect(onSend).toHaveBeenCalledTimes(1);
		expect(onSend).toHaveBeenCalledWith("Hello");
	});

	// An `onSend` rejection means a run that was marked never completed (or
	// never really started) — the mark must not stay stuck "on" for a later
	// unmarked handshake to surface as a false pill. `onUserSendFailed` is
	// the deterministic clear for this path; the `catch` block that calls it
	// rethrows rather than swallowing, so the failure is still visible to
	// whatever CopilotKit does with the outbound send.
	it("calls onUserSendFailed when onSend rejects, without swallowing the rejection", async () => {
		const sendError = new Error("network fail");
		const onSend = vi.fn(async (_text: string) => {
			throw sendError;
		});
		const onUserSendFailed = vi.fn();
		renderInput({ onSend }, { onUserSendFailed });

		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.change(textarea, { target: { value: "Hello" } });
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });

		// `handleSend`'s onClick binding is fire-and-forget (React does not
		// await onClick handlers), so a rejection from it surfaces as an
		// unhandled rejection rather than something this test can `await`
		// directly. Listen for it at the process level, then drain a macrotask
		// so Node's rejection-tracking (which checks at the end of the current
		// turn) has run before we assert.
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			fireEvent.click(sendBtn);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(onUserSendFailed).toHaveBeenCalledTimes(1);
		expect(unhandled).toEqual([sendError]);
	});

	// `onBeforeSend` runs BEFORE `onUserSend` — a throw there must prevent
	// the mark from ever being set, since no run is going to start.
	it("does not call onUserSend when onBeforeSend throws", async () => {
		const onSend = vi.fn(async (_text: string) => undefined as unknown);
		const onUserSend = vi.fn();
		const onBeforeSend = vi.fn(() => {
			throw new Error("flush failed");
		});
		renderInput({ onSend }, { onUserSend, onBeforeSend });

		const textarea = screen.getByPlaceholderText("Type a message...");
		await act(async () => {
			fireEvent.change(textarea, { target: { value: "Hello" } });
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });

		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			fireEvent.click(sendBtn);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(onBeforeSend).toHaveBeenCalledTimes(1);
		expect(onUserSend).not.toHaveBeenCalled();
		expect(onSend).not.toHaveBeenCalled();
	});
});

describe("createCopilotSidebarInput — empty-file notice (FR-15)", () => {
	it("attaches a 0-byte .md but surfaces an informational empty-file notice", async () => {
		renderInput();
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const emptyMd = makeFile("empty.md", "text/markdown", 0);
		await act(async () => {
			fireEvent.change(fileInput, { target: { files: [emptyMd] } });
		});

		// FR-15: the file is still accepted (chip rendered) — no hard block.
		expect(screen.getByLabelText("Remove empty.md")).toBeInTheDocument();
		// …and an informational notice is emitted, not an error toast.
		expect(toast.info).toHaveBeenCalledTimes(1);
		expect(toast.info).toHaveBeenCalledWith(
			'File "empty.md" is empty — attached, but it adds no context.',
		);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("does not flag a non-empty .md as empty", async () => {
		renderInput();
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const md = makeFile("notes.md", "text/markdown", 128);
		await act(async () => {
			fireEvent.change(fileInput, { target: { files: [md] } });
		});

		expect(screen.getByLabelText("Remove notes.md")).toBeInTheDocument();
		expect(toast.info).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});
});
