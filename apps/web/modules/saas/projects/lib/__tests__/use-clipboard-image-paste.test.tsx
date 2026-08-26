/**
 * Unit tests for `useClipboardImagePaste`.
 *
 * Covers the contract documented in `.claude/specs/2026-04-30-paste-image-everywhere/spec.md`
 * §5 (shared client utility) and §7/§8 (cross-cutting policy + non-functional
 * requirements). Tests are authored TDD-style: they are written before the
 * implementation file (`../use-clipboard-image-paste.ts`) exists so the first
 * run is RED.
 */

import { act, renderHook } from "@testing-library/react";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";

// Mock toast surface — copy strings are asserted exactly per spec §7/§8.6.
vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
		message: vi.fn(),
	},
}));

import { toast } from "sonner";
import { useClipboardImagePaste } from "../use-clipboard-image-paste";

// --- helpers ----------------------------------------------------------------

function makeFile(name: string, bytes: number, type: string): File {
	// JSDOM File honours the `size` getter from the underlying buffer.
	const buffer = new ArrayBuffer(bytes);
	return new File([buffer], name, { type });
}

/**
 * Build a `FileList`-like object the hook can iterate via `Array.from`.
 * JSDOM does not ship `DataTransfer`, so we synthesise the shape the hook
 * actually consumes (`length` + numeric indices + `Symbol.iterator`).
 */
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

function makeClipboardEvent(files: File[]): ClipboardEvent {
	const event = new Event("paste", {
		bubbles: true,
		cancelable: true,
	}) as ClipboardEvent;
	Object.defineProperty(event, "clipboardData", {
		value: { files: makeFileList(files) },
		writable: false,
	});
	return event;
}

function makeDragEvent(type: "drop" | "dragover", files: File[]): DragEvent {
	const event = new Event(type, {
		bubbles: true,
		cancelable: true,
	}) as DragEvent;
	Object.defineProperty(event, "dataTransfer", {
		value: { files: makeFileList(files) },
		writable: false,
	});
	return event;
}

const DOCUMENT_MIME_ALLOWLIST = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

const NEXUS_MIME_ALLOWLIST = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/tiff",
]);

const DOCUMENT_MAX = 5 * 1024 * 1024;
const NEXUS_MAX = 10 * 1024 * 1024;

// Capture console.log telemetry without polluting test output.
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
	logSpy.mockRestore();
});

// --- tests ------------------------------------------------------------------

describe("useClipboardImagePaste — MIME allow/deny", () => {
	it("uploads a PNG that matches the surface allowlist", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const file = makeFile("photo.png", 1024, "image/png");
		const event = makeClipboardEvent([file]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).toHaveBeenCalledTimes(1);
		expect(uploader).toHaveBeenCalledWith(file, expect.any(AbortSignal));
	});

	it("rejects an unsupported BMP and does not call the uploader", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([
			makeFile("logo.bmp", 1024, "image/bmp"),
		]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).not.toHaveBeenCalled();
	});

	it("HEIC paste shows the friendly toast copy verbatim from spec §7", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([
			makeFile("vacation.heic", 1024, "image/heic"),
		]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith(
			"HEIC images aren't supported yet — please paste as PNG or JPEG (Cmd-Shift-4 on Mac saves PNG).",
		);
	});

	it("treats image/heif identically to image/heic", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "nexus",
				maxSizeBytes: NEXUS_MAX,
				allowedMimeTypes: NEXUS_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([
			makeFile("vacation.heif", 1024, "image/heif"),
		]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith(
			"HEIC images aren't supported yet — please paste as PNG or JPEG (Cmd-Shift-4 on Mac saves PNG).",
		);
	});

	it("nexus surface accepts TIFF (extra MIME for chats)", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "nexus",
				maxSizeBytes: NEXUS_MAX,
				allowedMimeTypes: NEXUS_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const file = makeFile("scan.tiff", 1024, "image/tiff");
		const event = makeClipboardEvent([file]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).toHaveBeenCalledTimes(1);
		expect(uploader).toHaveBeenCalledWith(file, expect.any(AbortSignal));
	});

	it("document surface rejects TIFF (not in document allowlist)", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([
			makeFile("scan.tiff", 1024, "image/tiff"),
		]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).not.toHaveBeenCalled();
	});
});

describe("useClipboardImagePaste — size allow/deny", () => {
	it("rejects a 6MB image on the 5MB document surface with the size-limit toast", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([
			makeFile("huge.png", 6 * 1024 * 1024, "image/png"),
		]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith(
			"Image is too large (max 5MB). Try compressing it first.",
		);
	});

	it("rejects a 12MB image on the 10MB nexus surface with the 10MB toast", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "nexus",
				maxSizeBytes: NEXUS_MAX,
				allowedMimeTypes: NEXUS_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([
			makeFile("huge.png", 12 * 1024 * 1024, "image/png"),
		]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith(
			"Image is too large (max 10MB).",
		);
	});

	it("accepts a file exactly at maxSizeBytes (boundary)", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([
			makeFile("edge.png", DOCUMENT_MAX, "image/png"),
		]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).toHaveBeenCalledTimes(1);
	});
});

describe("useClipboardImagePaste — 5-image cap", () => {
	it("uploads first 5 of 7 and surfaces the 'Pasted 5 of N' toast", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const files = Array.from({ length: 7 }, (_, i) =>
			makeFile(`img-${i}.png`, 1024, "image/png"),
		);
		const event = makeClipboardEvent(files);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).toHaveBeenCalledTimes(5);
		expect(toast.message).toHaveBeenCalledWith(
			"Pasted 5 of 7 images — upload the rest separately.",
		);
	});

	it("does not surface the cap toast when image count is at or below the cap", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const files = Array.from({ length: 5 }, (_, i) =>
			makeFile(`img-${i}.png`, 1024, "image/png"),
		);
		const event = makeClipboardEvent(files);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).toHaveBeenCalledTimes(5);
		expect(toast.message).not.toHaveBeenCalled();
	});

	it("respects a host-supplied maxFilesPerPaste lower than 5", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				maxFilesPerPaste: 2,
				uploader,
			}),
		);

		const files = Array.from({ length: 4 }, (_, i) =>
			makeFile(`img-${i}.png`, 1024, "image/png"),
		);
		const event = makeClipboardEvent(files);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).toHaveBeenCalledTimes(2);
		expect(toast.message).toHaveBeenCalledWith(
			"Pasted 2 of 4 images — upload the rest separately.",
		);
	});
});

describe("useClipboardImagePaste — mixed Files split", () => {
	it("uploads images and forwards non-images to onNonImageFiles", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const onNonImageFiles = vi.fn();
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "nexus",
				maxSizeBytes: NEXUS_MAX,
				allowedMimeTypes: NEXUS_MIME_ALLOWLIST,
				uploader,
				onNonImageFiles,
			}),
		);

		const png = makeFile("photo.png", 1024, "image/png");
		const pdf = makeFile("doc.pdf", 1024, "application/pdf");
		const event = makeClipboardEvent([png, pdf]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).toHaveBeenCalledTimes(1);
		expect(uploader).toHaveBeenCalledWith(png, expect.any(AbortSignal));
		expect(onNonImageFiles).toHaveBeenCalledTimes(1);
		expect(onNonImageFiles).toHaveBeenCalledWith([pdf]);
	});

	it("drops non-images silently when onNonImageFiles is not provided", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "nexus",
				maxSizeBytes: NEXUS_MAX,
				allowedMimeTypes: NEXUS_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const png = makeFile("photo.png", 1024, "image/png");
		const pdf = makeFile("doc.pdf", 1024, "application/pdf");
		const event = makeClipboardEvent([png, pdf]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(uploader).toHaveBeenCalledTimes(1);
		expect(uploader).toHaveBeenCalledWith(png, expect.any(AbortSignal));
	});
});

describe("useClipboardImagePaste — telemetry", () => {
	it("emits exactly one [PasteImage] log line per successful image", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "story",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const files = [
			makeFile("a.png", 100, "image/png"),
			makeFile("b.jpg", 200, "image/jpeg"),
		];
		const event = makeClipboardEvent(files);

		await act(async () => {
			result.current.handlePaste(event);
		});

		const lines = (logSpy.mock.calls as unknown[][])
			.map((c) => String(c[0]))
			.filter((line) => line.includes("[PasteImage]"));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^\[PasteImage\]/);
		expect(lines[0]).toContain("surface=story");
		expect(lines[0]).toContain("status=ok");
		expect(lines[0]).toMatch(/size=\d+/);
		expect(lines[0]).toMatch(/mime=image\/(png|jpeg)/);
		expect(lines[0]).toMatch(/durationMs=\d+/);
	});

	it("emits a status=error telemetry line with errorCode when uploader rejects", async () => {
		const uploader = vi.fn().mockRejectedValue(new Error("boom"));
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "loom",
				maxSizeBytes: NEXUS_MAX,
				allowedMimeTypes: NEXUS_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([makeFile("a.png", 100, "image/png")]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		const lines = (logSpy.mock.calls as unknown[][])
			.map((c) => String(c[0]))
			.filter((line) => line.includes("[PasteImage]"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("status=error");
		expect(lines[0]).toContain("errorCode=");
		expect(lines[0]).toContain("surface=loom");
	});

	it("surfaces the friendly network toast on uploader failure (no raw provider error leaks)", async () => {
		const uploader = vi
			.fn()
			.mockRejectedValue(new Error("503 Service Unavailable from S3"));
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([makeFile("a.png", 100, "image/png")]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(toast.error).toHaveBeenCalledWith(
			"Couldn't upload — please try again.",
		);
		const errorMock = toast.error as Mock;
		for (const call of errorMock.mock.calls) {
			expect(String(call[0])).not.toContain("503");
			expect(String(call[0])).not.toContain("S3");
		}
	});
});

describe("useClipboardImagePaste — handler stability (NFR §8.3)", () => {
	it("returns referentially stable handlers across renders", () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const options = {
			surface: "document" as const,
			maxSizeBytes: DOCUMENT_MAX,
			allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
			uploader,
		};
		const { result, rerender } = renderHook(
			(p: typeof options) => useClipboardImagePaste(p),
			{ initialProps: options },
		);

		const first = {
			handlePaste: result.current.handlePaste,
			handleDrop: result.current.handleDrop,
			handleDragOver: result.current.handleDragOver,
		};

		// Re-render with the same options object → handlers must keep identity.
		rerender(options);

		expect(result.current.handlePaste).toBe(first.handlePaste);
		expect(result.current.handleDrop).toBe(first.handleDrop);
		expect(result.current.handleDragOver).toBe(first.handleDragOver);
	});
});

describe("useClipboardImagePaste — abort propagation", () => {
	it("aborts the AbortSignal handed to the uploader when the host unmounts", async () => {
		let capturedSignal: AbortSignal | null = null;
		const uploader = vi
			.fn()
			.mockImplementation(async (_file: File, signal: AbortSignal) => {
				capturedSignal = signal;
				// Wait until aborted, then reject like a fetch would.
				return new Promise<void>((_, reject) => {
					signal.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				});
			});

		const { result, unmount } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([makeFile("a.png", 100, "image/png")]);

		act(() => {
			result.current.handlePaste(event);
		});

		// Let the uploader actually start
		await act(async () => {
			await Promise.resolve();
		});

		expect(capturedSignal).not.toBeNull();
		expect(capturedSignal?.aborted).toBe(false);

		unmount();

		expect(capturedSignal?.aborted).toBe(true);
	});

	// Regression: after the host unmounts (HMR / React StrictMode double-mount /
	// any remount cycle), a fresh hook instance must hand the uploader a NEW,
	// non-aborted signal. Previously the hook reused a stale aborted controller
	// and every subsequent paste short-circuited silently with `status=ok`.
	it("hands a fresh non-aborted signal to a remounted hook instance", async () => {
		const seenSignals: AbortSignal[] = [];
		const uploader = vi
			.fn()
			.mockImplementation(async (_file: File, signal: AbortSignal) => {
				seenSignals.push(signal);
			});

		const opts = {
			surface: "story" as const,
			maxSizeBytes: DOCUMENT_MAX,
			allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
			uploader,
		};

		// First mount: paste, then unmount (which aborts the controller).
		const first = renderHook(() => useClipboardImagePaste(opts));
		await act(async () => {
			first.result.current.handlePaste(
				makeClipboardEvent([makeFile("first.png", 100, "image/png")]),
			);
			await Promise.resolve();
		});
		first.unmount();

		// Second mount on a fresh hook instance — must NOT inherit the aborted signal.
		const second = renderHook(() => useClipboardImagePaste(opts));
		await act(async () => {
			second.result.current.handlePaste(
				makeClipboardEvent([makeFile("second.png", 100, "image/png")]),
			);
			await Promise.resolve();
		});

		expect(seenSignals).toHaveLength(2);
		expect(seenSignals[0].aborted).toBe(true); // first signal aborted on unmount
		expect(seenSignals[1].aborted).toBe(false); // remount got a fresh signal
		second.unmount();
	});
});

describe("useClipboardImagePaste — parallel upload", () => {
	it("kicks off all uploads concurrently with Promise.allSettled semantics", async () => {
		let activeAtPeak = 0;
		let active = 0;
		const uploader = vi.fn().mockImplementation(async () => {
			active += 1;
			activeAtPeak = Math.max(activeAtPeak, active);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active -= 1;
		});
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const files = [
			makeFile("a.png", 100, "image/png"),
			makeFile("b.png", 100, "image/png"),
			makeFile("c.png", 100, "image/png"),
		];
		const event = makeClipboardEvent(files);

		await act(async () => {
			result.current.handlePaste(event);
			// Let microtasks + the 10ms uploads settle.
			await new Promise((resolve) => setTimeout(resolve, 50));
		});

		expect(uploader).toHaveBeenCalledTimes(3);
		expect(activeAtPeak).toBeGreaterThan(1);
	});

	it("does not throw when one of several uploads fails", async () => {
		const uploader = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const files = [
			makeFile("a.png", 100, "image/png"),
			makeFile("b.png", 100, "image/png"),
			makeFile("c.png", 100, "image/png"),
		];
		const event = makeClipboardEvent(files);

		await expect(
			act(async () => {
				result.current.handlePaste(event);
			}),
		).resolves.not.toThrow();

		expect(uploader).toHaveBeenCalledTimes(3);
	});
});

describe("useClipboardImagePaste — drop / dragover semantics", () => {
	it("handleDrop processes images from dataTransfer.files and calls preventDefault", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const file = makeFile("dropped.png", 1024, "image/png");
		const event = makeDragEvent("drop", [file]);
		const preventSpy = vi.spyOn(event, "preventDefault");

		await act(async () => {
			result.current.handleDrop(event);
		});

		expect(preventSpy).toHaveBeenCalled();
		expect(uploader).toHaveBeenCalledWith(file, expect.any(AbortSignal));
	});

	it("handleDragOver always preventDefault so the drop fires", () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeDragEvent("dragover", []);
		const preventSpy = vi.spyOn(event, "preventDefault");

		act(() => {
			result.current.handleDragOver(event);
		});

		expect(preventSpy).toHaveBeenCalled();
	});

	it("handlePaste returns false when no clipboard files are present", () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([]);

		let returned = true;
		act(() => {
			returned = result.current.handlePaste(event);
		});

		expect(returned).toBe(false);
		expect(uploader).not.toHaveBeenCalled();
	});

	it("handlePaste returns true (event was consumed) when at least one image is processed", async () => {
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
			}),
		);

		const event = makeClipboardEvent([makeFile("a.png", 100, "image/png")]);

		let returned = false;
		await act(async () => {
			returned = result.current.handlePaste(event);
		});

		expect(returned).toBe(true);
	});
});

describe("useClipboardImagePaste — accessibility announce", () => {
	it("invokes announce('Uploading image…') and announce('Image uploaded.') on success", async () => {
		const announce = vi.fn();
		const uploader = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
				announce,
			}),
		);

		const event = makeClipboardEvent([makeFile("a.png", 100, "image/png")]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(announce).toHaveBeenCalledWith("Uploading image…");
		expect(announce).toHaveBeenCalledWith("Image uploaded.");
	});

	it("invokes announce('Image upload failed.') on uploader error", async () => {
		const announce = vi.fn();
		const uploader = vi.fn().mockRejectedValue(new Error("boom"));
		const { result } = renderHook(() =>
			useClipboardImagePaste({
				surface: "document",
				maxSizeBytes: DOCUMENT_MAX,
				allowedMimeTypes: DOCUMENT_MIME_ALLOWLIST,
				uploader,
				announce,
			}),
		);

		const event = makeClipboardEvent([makeFile("a.png", 100, "image/png")]);

		await act(async () => {
			result.current.handlePaste(event);
		});

		expect(announce).toHaveBeenCalledWith("Image upload failed.");
	});
});
