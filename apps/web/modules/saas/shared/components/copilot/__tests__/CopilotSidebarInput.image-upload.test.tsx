/**
 * Unit tests for the new image-upload guardrails added for F-239:
 *
 *   - `allowedImageTypes` config narrows the per-surface image allowlist
 *     (AI Feature Assistant: PNG/JPEG only). Other surfaces keep the
 *     default (PNG/JPEG/GIF/WEBP).
 *   - `maxImageCount` caps the per-session image count (AI Feature
 *     Assistant: 5). Exceeding the cap shows a toast and skips the
 *     extra files; non-image files are unaffected.
 *   - `attachmentDisabled` renders the paperclip disabled inside a
 *     tooltip wrapper (AC-10 read-only viewer).
 *
 * Mock surface mirrors the sibling test file `CopilotSidebarInput.test.tsx`:
 * only `@shared/lib/orpc-client`, `sonner`, and `@analytics` are mocked.
 */

import { DEFAULT_AI_CHAT_MAX_FILE_BYTES } from "@repo/utils/ai-chat-attachment";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ------------------------------------------------------------------

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

// Capture telemetry events so AC-14 regression-lock tests can assert the exact
// payload shape and that no PII leaks (mirrors the pattern in the sibling
// `CopilotSidebarInput.test.tsx`).
const trackEventMock = vi.fn();
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

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

// `compressImage` is canvas-based; in JSDOM the Image/Canvas pipeline is not
// fully functional. Mock it to a pass-through so the hook's compression slot
// does not throw and the chip still gets created. Option-forwarding tests
// (Group 1.5) inspect `vi.mocked(compressImage).mock.calls`.
vi.mock("@saas/projects/lib/image-upload-utils", () => ({
	prepareImageForAi: vi.fn(async (file: File) => ({
		ok: true as const,
		file,
	})),
	compressImage: vi.fn(async (file: File) => file),
	// Must be mocked too: the upload hook calls it after compressImage, and an
	// undefined here would throw inside the preparation step where it is easy
	// to mistake a silent no-op for a passing test.
	compressImageToBudget: vi.fn(async (file: File) => ({
		file,
		withinBudget: true,
	})),
}));

beforeEach(() => {
	vi.clearAllMocks();
	(globalThis as { fetch?: unknown }).fetch = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
	});
});

afterEach(() => {
	delete (globalThis as { fetch?: unknown }).fetch;
});

import { compressImage } from "@saas/projects/lib/image-upload-utils";
// Imports under test (after mocks).
import { toast } from "sonner";
import { createCopilotSidebarInput } from "../CopilotSidebarInput";

// --- Helpers ----------------------------------------------------------------

function makeFile(name: string, type: string, sizeBytes = 1024): File {
	return new File([new ArrayBuffer(sizeBytes)], name, { type });
}

function makeFileList(files: File[]): FileList {
	const list: Record<string | number | symbol, unknown> = {
		length: files.length,
		item: (i: number) => files[i] ?? null,
		[Symbol.iterator]: function* () {
			for (const f of files) {
				yield f;
			}
		},
	};
	for (const [i, f] of files.entries()) {
		list[i] = f;
	}
	return list as unknown as FileList;
}

interface FactoryConfig {
	allowedImageTypes?: readonly string[];
	maxImageCount?: number;
	attachmentDisabled?: boolean;
	attachmentDisabledReason?: string;
	compressionMaxDimension?: number;
	compressionQuality?: number;
}

function renderInputWithConfig(config: FactoryConfig) {
	const onSend = vi.fn(async () => undefined as unknown);
	const Input = createCopilotSidebarInput({
		organizationId: null,
		surface: "feature-assistant",
		...config,
	});
	const utils = render(<Input inProgress={false} onSend={onSend} />);
	return { ...utils, onSend };
}

function getFileInput(container: HTMLElement): HTMLInputElement {
	const input = container.querySelector(
		'input[type="file"]',
	) as HTMLInputElement | null;
	if (!input) {
		throw new Error("File input not found");
	}
	return input;
}

async function triggerFileSelect(input: HTMLInputElement, files: File[]) {
	Object.defineProperty(input, "files", {
		value: makeFileList(files),
		configurable: true,
	});
	// `addFiles` is async (compression). Wrap in act so React state updates
	// scheduled by `setAttachedFiles` are flushed before we proceed — without
	// this, the next call reads a stale `attachedFilesRef.current`.
	await act(async () => {
		fireEvent.change(input);
		// Yield twice: once for the compression promise, once for the
		// follow-on setAttachedFiles batch.
		await Promise.resolve();
		await Promise.resolve();
	});
}

// --- Tests ------------------------------------------------------------------

/**
 * The provider measures an image AFTER base64 encoding, which costs a third
 * more than the file on disk. An image can therefore clear this surface's raw
 * upload cap and still be refused by the model — historically surfacing much
 * later as a failed AI request with nothing the user could act on.
 *
 * This is the surface the ticket is about: the AI Feature Assistant and the
 * copilot sidebar both attach through this hook.
 */
describe("CopilotSidebarInput — provider image budget", () => {
	it("rejects an image that cannot be brought under the budget, and does not attach it", async () => {
		const { prepareImageForAi } = await import(
			"@saas/projects/lib/image-upload-utils"
		);
		(
			prepareImageForAi as unknown as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			ok: false,
			error: '"huge.png" is too detailed to send to the AI, even after shrinking it. Try a smaller crop, or save it as a JPEG first.',
		});

		const { container } = renderInputWithConfig({});
		await triggerFileSelect(getFileInput(container), [
			makeFile("huge.png", "image/png"),
		]);

		expect(toast.error).toHaveBeenCalledTimes(1);
		const msg = (toast.error as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(msg).toMatch(/huge\.png/);
		// Actionable, not a raw provider error.
		expect(msg).toMatch(/smaller crop|JPEG/i);
	});

	it("tells a GIF user why shrinking is not an option", async () => {
		const { prepareImageForAi } = await import(
			"@saas/projects/lib/image-upload-utils"
		);
		(
			prepareImageForAi as unknown as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			ok: false,
			error: '"loop.gif" is too large to send to the AI. Shrinking it would lose the animation — try a shorter clip or a still frame.',
		});

		const { container } = renderInputWithConfig({});
		await triggerFileSelect(getFileInput(container), [
			makeFile("loop.gif", "image/gif"),
		]);

		expect(toast.error).toHaveBeenCalledTimes(1);
		const msg = (toast.error as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(msg).toMatch(/animation/i);
	});

	it("attaches normally when the image fits", async () => {
		const { container } = renderInputWithConfig({});
		await triggerFileSelect(getFileInput(container), [
			makeFile("fine.png", "image/png"),
		]);
		expect(toast.error).not.toHaveBeenCalled();
	});
});

describe("CopilotSidebarInput — allowedImageTypes", () => {
	it("rejects GIF when allowlist is PNG/JPEG only", async () => {
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
		});
		await triggerFileSelect(getFileInput(container), [
			makeFile("animation.gif", "image/gif"),
		]);

		expect(toast.error).toHaveBeenCalledTimes(1);
		const callArgs = (toast.error as unknown as ReturnType<typeof vi.fn>)
			.mock.calls[0][0];
		expect(callArgs).toMatch(/animation\.gif/);
		expect(callArgs).toMatch(/PNG.*JPEG|JPEG.*PNG/);
	});

	it("rejects WEBP when allowlist is PNG/JPEG only", async () => {
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
		});
		await triggerFileSelect(getFileInput(container), [
			makeFile("art.webp", "image/webp"),
		]);
		expect(toast.error).toHaveBeenCalledTimes(1);
	});

	it("accepts PNG when allowlist is PNG/JPEG", async () => {
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
		});
		await triggerFileSelect(getFileInput(container), [
			makeFile("wireframe.png", "image/png"),
		]);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("accepts JPEG when allowlist is PNG/JPEG", async () => {
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
		});
		await triggerFileSelect(getFileInput(container), [
			makeFile("photo.jpg", "image/jpeg"),
		]);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("does NOT constrain non-image files (PDF still accepted)", async () => {
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
		});
		await triggerFileSelect(getFileInput(container), [
			makeFile("spec.pdf", "application/pdf"),
		]);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("falls back to the default allowlist when not provided", async () => {
		const { container } = renderInputWithConfig({});
		await triggerFileSelect(getFileInput(container), [
			makeFile("animation.gif", "image/gif"),
		]);
		// Default allowlist accepts GIF — no toast error
		expect(toast.error).not.toHaveBeenCalled();
	});
});

describe("CopilotSidebarInput — maxImageCount", () => {
	it("rejects the image that would exceed the cap", async () => {
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
			maxImageCount: 2,
		});
		// Three images at once — the third should be rejected.
		await triggerFileSelect(getFileInput(container), [
			makeFile("a.png", "image/png"),
			makeFile("b.png", "image/png"),
			makeFile("c.png", "image/png"),
		]);
		expect(toast.error).toHaveBeenCalledTimes(1);
		const msg = (toast.error as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(msg).toMatch(/2 images/);
	});

	it("counts only existing image chips against the cap", async () => {
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
			maxImageCount: 2,
		});
		// First batch: 2 images (at cap)
		await triggerFileSelect(getFileInput(container), [
			makeFile("a.png", "image/png"),
			makeFile("b.png", "image/png"),
		]);
		expect(toast.error).not.toHaveBeenCalled();

		// Second batch: 1 more image — should be rejected
		await triggerFileSelect(getFileInput(container), [
			makeFile("c.png", "image/png"),
		]);
		expect(toast.error).toHaveBeenCalledTimes(1);
	});

	it("does not enforce a cap for non-image files", async () => {
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
			maxImageCount: 1,
		});
		await triggerFileSelect(getFileInput(container), [
			makeFile("a.png", "image/png"),
			makeFile("doc1.pdf", "application/pdf"),
			makeFile("doc2.pdf", "application/pdf"),
		]);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("counts in-flight images against the cap during compression", async () => {
		// Stall compression so we can interleave a second batch while the
		// first is still pending. Without the in-flight reservation, the
		// second batch's cap check would see an empty `attachedFilesRef`
		// and incorrectly accept past the cap.
		const { compressImage } = await import(
			"@saas/projects/lib/image-upload-utils"
		);
		let releaseCompression: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseCompression = resolve;
		});
		(
			compressImage as unknown as ReturnType<typeof vi.fn>
		).mockImplementation(async (file: File) => {
			await gate;
			return file;
		});

		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
			maxImageCount: 2,
		});
		const input = getFileInput(container);

		// Batch A — paste-like; do NOT await it.
		Object.defineProperty(input, "files", {
			value: makeFileList([
				makeFile("a.png", "image/png"),
				makeFile("b.png", "image/png"),
			]),
			configurable: true,
		});
		fireEvent.change(input);

		// Batch B fires before Batch A's compression resolves. Cap is 2 and
		// Batch A reserved 2 → Batch B should be rejected.
		await triggerFileSelect(input, [makeFile("c.png", "image/png")]);
		expect(toast.error).toHaveBeenCalledTimes(1);

		// Drain Batch A and let chips land.
		await act(async () => {
			releaseCompression();
			await Promise.resolve();
			await Promise.resolve();
		});
	});
});

describe("CopilotSidebarInput — attachmentDisabled (AC-10)", () => {
	it("renders the paperclip in a disabled state", () => {
		const { container } = renderInputWithConfig({
			attachmentDisabled: true,
			attachmentDisabledReason: "You need edit access to attach images.",
		});
		const buttons = container.querySelectorAll(
			"button[aria-label]",
		) as NodeListOf<HTMLButtonElement>;
		const paperclip = Array.from(buttons).find((b) =>
			/attach|edit access/i.test(b.getAttribute("aria-label") || ""),
		);
		expect(paperclip).toBeDefined();
		expect(paperclip?.disabled).toBe(true);
		expect(paperclip?.getAttribute("aria-disabled")).toBe("true");
	});

	it("uses the provided disabledReason as the aria-label", () => {
		const { container } = renderInputWithConfig({
			attachmentDisabled: true,
			attachmentDisabledReason: "Custom reason for disable.",
		});
		const btn = container.querySelector(
			'button[aria-disabled="true"]',
		) as HTMLButtonElement | null;
		expect(btn?.getAttribute("aria-label")).toBe(
			"Custom reason for disable.",
		);
	});

	it("renders the active paperclip when not disabled", () => {
		const { container } = renderInputWithConfig({});
		const disabled = container.querySelector(
			'button[aria-disabled="true"]',
		);
		expect(disabled).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Group 1.5 — Surface-scoped compression option forwarding
// ---------------------------------------------------------------------------
//
// The AI Feature Assistant surface passes 1024 / 0.80 (per StoryWorkspace
// wiring); document editor surfaces pass nothing and inherit `compressImage`'s
// existing 2000 / 0.85 defaults. These tests anchor the forwarding contract:
// when either option is set on the factory config, BOTH values are forwarded
// to `compressImage` as a single options arg. When neither is set, the call
// is exactly `compressImage(file)` — preserving the default-path test
// footprint of the document editor.

describe("CopilotSidebarInput — compression option forwarding (AC-6)", () => {
	it("forwards compressionMaxDimension + compressionQuality to compressImage when set", async () => {
		// Arrange — feature-assistant surface with PM-locked compression overrides.
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
			compressionMaxDimension: 1024,
			compressionQuality: 0.8,
		});

		// Act — drop a PNG through the paperclip pipeline so the hook reaches
		// the compression call.
		await triggerFileSelect(getFileInput(container), [
			makeFile("wireframe.png", "image/png"),
		]);

		// Assert — compressImage was called with (File, { maxDimension, quality })
		// and the option values match the PM-locked spec §5.1 numbers exactly.
		const mockedCompressImage = vi.mocked(compressImage);
		expect(mockedCompressImage).toHaveBeenCalledTimes(1);
		const [fileArg, optionsArg] = mockedCompressImage.mock.calls[0];
		expect(fileArg).toBeInstanceOf(File);
		expect(fileArg.name).toBe("wireframe.png");
		expect(optionsArg).toEqual({ maxDimension: 1024, quality: 0.8 });
	});

	it("calls compressImage with no options arg when both compression options are undefined", async () => {
		// Arrange — document-editor-style call: no compression overrides set.
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
		});

		// Act — drop a PNG through the paperclip pipeline.
		await triggerFileSelect(getFileInput(container), [
			makeFile("photo.png", "image/png"),
		]);

		// Assert — compressImage was called with exactly one arg (the File).
		// The second arg must be `undefined` so the function falls back to its
		// module-level 2000 / 0.85 defaults — the document-editor path.
		const mockedCompressImage = vi.mocked(compressImage);
		expect(mockedCompressImage).toHaveBeenCalledTimes(1);
		const callArgs = mockedCompressImage.mock.calls[0];
		expect(callArgs[0]).toBeInstanceOf(File);
		expect(callArgs[0].name).toBe("photo.png");
		expect(callArgs[1]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Group 3.1 — AC-14 telemetry payload contract regression lock
// ---------------------------------------------------------------------------
//
// AC-14 locks the `copilot_attachment_added` payload shape to exactly
// `{ surface, kind, mime, sizeBytes }`. Per
// `fabric/standards/global/error-handling.md`: NO `filename`, `userId`,
// `organizationId`, or `chatId`. A future refactor that quietly adds a
// `filename` field would silently regress the contract — this test catches it.

describe("AC-14 — copilot_attachment_added telemetry payload contract", () => {
	it("fires exactly once per chip→ready with the locked payload shape and no PII", async () => {
		// Arrange — wire the upload pipeline so a PNG can reach `ready`. Mirror
		// the `primeSuccessfulUpload` helper from `CopilotSidebarInput.test.tsx`.
		mockOrpc.createUploadUrl.mockResolvedValue({
			documentId: "doc-png-1",
			signedUploadUrl: "https://s3.example.com/put",
			useServerUpload: false,
			chatId: "chat-1",
		});
		mockOrpc.process.mockResolvedValue({
			documentId: "doc-png-1",
			status: "PROCESSING",
			extractedContent: null,
		});

		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
		});

		// Stage a PNG via the paperclip flow.
		const pngFile = makeFile("wireframe.png", "image/png", 2048);
		await triggerFileSelect(getFileInput(container), [pngFile]);

		// Pre-send: telemetry has NOT fired yet (the chip is still `pending`).
		expect(trackEventMock).not.toHaveBeenCalled();

		// Act — drive the upload pipeline → `ready` by typing + clicking Send.
		const textarea = screen.getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await act(async () => {
			fireEvent.change(textarea, {
				target: { value: "What's in this?" },
			});
		});
		const sendBtn = screen.getByRole("button", { name: "sendMessage" });
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		// Assert — exactly one telemetry call for the single chip.
		expect(trackEventMock).toHaveBeenCalledTimes(1);

		// The first arg is the event name.
		expect(trackEventMock.mock.calls[0][0]).toBe(
			"copilot_attachment_added",
		);

		// The second arg is the locked payload: exactly four keys, no more,
		// no less. `Object.keys().sort()` makes the assertion order-stable.
		const payload = trackEventMock.mock.calls[0][1] as Record<
			string,
			unknown
		>;
		expect(Object.keys(payload).sort()).toEqual([
			"kind",
			"mime",
			"sizeBytes",
			"surface",
		]);

		// Field-by-field value checks.
		expect(payload.surface).toBe("feature-assistant");
		expect(payload.kind).toBe("paperclip");
		expect(payload.mime).toBe("image/png");
		expect(typeof payload.sizeBytes).toBe("number");

		// Defensive PII assertion — none of the forbidden keys leak in.
		expect(payload).not.toHaveProperty("filename");
		expect(payload).not.toHaveProperty("name");
		expect(payload).not.toHaveProperty("userId");
		expect(payload).not.toHaveProperty("organizationId");
		expect(payload).not.toHaveProperty("chatId");
		expect(payload).not.toHaveProperty("id");
	});
});

// ---------------------------------------------------------------------------
// Group 3.4 — AC-10 RBAC tooltip copy lock
// ---------------------------------------------------------------------------
//
// AC-10 locks the disabled-paperclip tooltip copy to:
// "You need edit access to attach images." Today the string is rendered
// correctly but no test asserts the exact text — these tests catch a future
// silent rewrite.

describe("AC-10 — RBAC tooltip copy lock", () => {
	it("renders the exact disabled tooltip copy: 'You need edit access to attach images.'", async () => {
		// Arrange — read-only feature-assistant surface with the locked copy.
		const { container } = renderInputWithConfig({
			attachmentDisabled: true,
			attachmentDisabledReason: "You need edit access to attach images.",
		});

		// The disabled paperclip lives inside a `<span tabIndex={0}>` wrapper
		// (Radix Tooltip pattern — `CopilotSidebarInput.tsx:503`). The wrapper
		// is the tooltip trigger; focusing it should reveal the tooltip content.
		const disabledBtn = container.querySelector(
			'button[aria-disabled="true"]',
		) as HTMLButtonElement | null;
		expect(disabledBtn).not.toBeNull();
		const wrapper = disabledBtn?.parentElement as HTMLSpanElement | null;
		expect(wrapper?.tagName).toBe("SPAN");
		expect(wrapper?.getAttribute("tabindex")).toBe("0");

		// Assert — the locked copy lives on the disabled button's `aria-label`,
		// which IS the screen-reader-accessible version of the tooltip
		// (`CopilotSidebarInput.tsx:516-519` passes `attachmentDisabledReason`
		// to both the `aria-label` AND the `TooltipContent`). The aria-label
		// is the WCAG 2.1 AA source of truth for icon-only controls per
		// `fabric/standards/frontend/tooltips.md`, so locking it locks the
		// tooltip copy without depending on Radix's portal/pointer event
		// behaviour, which doesn't reliably fire on programmatic focus in
		// jsdom. Sighted-user tooltip rendering is covered by the
		// `apps/web/tests/ai-feature-assistant-attachments.spec.ts`
		// Playwright spec, which exercises the live Radix runtime.
		expect(disabledBtn?.getAttribute("aria-label")).toBe(
			"You need edit access to attach images.",
		);
	});

	it("the disabled paperclip wrapper is keyboard-focusable via Tab", () => {
		// Arrange.
		const { container } = renderInputWithConfig({
			attachmentDisabled: true,
			attachmentDisabledReason: "You need edit access to attach images.",
		});

		const disabledBtn = container.querySelector(
			'button[aria-disabled="true"]',
		) as HTMLButtonElement | null;
		const wrapper = disabledBtn?.parentElement as HTMLSpanElement | null;

		// Assert — the wrapper carries `tabIndex={0}` so a keyboard user can
		// reach the tooltip even though the underlying `<button disabled>`
		// would be skipped in the focus order.
		expect(wrapper?.getAttribute("tabindex")).toBe("0");

		// Act — programmatically focus the wrapper (simulates Tab landing on it).
		wrapper?.focus();

		// Assert — focus actually landed on the wrapper.
		expect(document.activeElement).toBe(wrapper);
	});
});

// ---------------------------------------------------------------------------
// Group 3.5 — AC-4 and AC-5 toast copy regression locks
// ---------------------------------------------------------------------------
//
// AC-4 locks the unsupported-image-type toast copy. AC-5 locks the >10MB
// toast copy. Both strings are hardcoded English today (i18n routing deferred
// to a P2 ticket) — these tests catch any silent rewrite before the i18n move.

describe("AC-4 / AC-5 — toast copy lock", () => {
	it("AC-4: rejects GIF on feature-assistant surface with the exact unsupported-type toast", async () => {
		// Arrange — feature-assistant surface with PNG/JPEG-only allowlist.
		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
		});

		// Act — drop a GIF.
		await triggerFileSelect(getFileInput(container), [
			makeFile("test.gif", "image/gif"),
		]);

		// Assert — the locked AC-4 toast string is emitted verbatim. The
		// "JPEG, PNG" order reflects the production order in
		// `allowedImageTypes` (`["image/jpeg", "image/png"]`); the hook
		// preserves caller order in the formatted toast.
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledWith(
			"File type not supported: test.gif. Supported image formats: JPEG, PNG.",
		);
	});

	it("AC-5: rejects an oversized PNG with the exact over-cap toast", async () => {
		// Arrange — build a File whose `size` reports past the cap. The hook
		// reads `file.size` directly, so a defineProperty override is sufficient
		// and avoids allocating the Blob in the test harness.
		//
		// The threshold is derived from the shared cap rather than written out:
		// the cap moved from 10MB to 25MB and a hardcoded 11MB fixture silently
		// became a *legitimate* file, so this test stopped exercising rejection
		// at all while still passing its own name.
		const sizeBytes = DEFAULT_AI_CHAT_MAX_FILE_BYTES + 1024 * 1024;
		const file = makeFile("huge.png", "image/png", 1);
		Object.defineProperty(file, "size", {
			value: sizeBytes,
			configurable: true,
		});

		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
		});

		// Act.
		await triggerFileSelect(getFileInput(container), [file]);

		// Assert — the locked AC-5 toast string, with the limit named from the
		// same constant the check uses so the sentence cannot lie about the cap.
		const capMb = Math.round(
			DEFAULT_AI_CHAT_MAX_FILE_BYTES / (1024 * 1024),
		);
		const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledWith(
			`File "huge.png" exceeds the ${capMb}MB limit (${sizeMb}MB)`,
		);
	});

	it("AC-5b: admits a file that the old 10MB cap would have refused", async () => {
		// R14. The point of the cap change — pinned so a revert is visible here
		// rather than only in the constant.
		const file = makeFile("large.png", "image/png", 1);
		Object.defineProperty(file, "size", {
			value: 11 * 1024 * 1024,
			configurable: true,
		});

		// The default mock is a pass-through, so without this the file arrives
		// at the request-budget check still 11 MB and is refused there — a
		// different rejection than the one this test is about. Production
		// shrinks an image before that check, so shrink it here too and the
		// assertion stays about the per-file cap alone.
		const shrunk = makeFile("large.png", "image/png", 1);
		Object.defineProperty(shrunk, "size", {
			value: 512 * 1024,
			configurable: true,
		});
		vi.mocked(compressImage).mockResolvedValueOnce(shrunk);

		const { container } = renderInputWithConfig({
			allowedImageTypes: ["image/jpeg", "image/png"],
		});

		await triggerFileSelect(getFileInput(container), [file]);

		expect(toast.error).not.toHaveBeenCalled();
	});
});
