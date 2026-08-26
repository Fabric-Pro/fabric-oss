/**
 * The request body budget, and the image cap that is supposed to be per-session
 * (Fizzy #2167).
 *
 * The reported bug was not "an image was too big". Every attachment in the
 * repro satisfied every per-file rule. They broke the request TOGETHER, and
 * because the entries stay in the conversation's context, the turn that carried
 * them was refused, then so was every turn after it — plain text with no
 * attachment included. That is the state users described as the chat being
 * dead.
 *
 * So the fixture that matters here is several individually-legal attachments,
 * not one oversized one: a per-file check of any threshold passes that case and
 * ships the bug. The single-oversized-file case is covered too, because the
 * same budget subsumes it.
 *
 * Sizes are asserted against `MAX_TOTAL_CONTEXT_BYTES` rather than hardcoded,
 * so re-tuning the budget cannot leave these tests asserting a stale number.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockToastError } = vi.hoisted(() => ({
	mockToastError: vi.fn(),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	// The hook reads OPENAPI_SPEC_CONTEXT through the provider, which only the
	// app layout mounts. `true` is the interesting value here: it lets the
	// spec guard run, so these suites exercise the same path production does.
	useFeatureFlag: () => true,
}));

vi.mock("sonner", () => ({
	toast: { error: mockToastError, info: vi.fn(), success: vi.fn() },
}));
vi.mock("@saas/projects/lib/image-upload-utils", () => ({
	// Pass-through: this suite is about the budget arithmetic, so the file that
	// reaches the check must be the file the test declared.
	prepareImageForAi: vi.fn(async (file: File) => ({
		ok: true as const,
		file,
	})),
	compressImageToBudget: vi.fn(async (file: File) => ({
		file,
		withinBudget: true,
	})),
	compressImage: vi.fn(async (f: File) => f),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		ai: {
			documents: {
				createUploadUrl: vi.fn(),
				upload: vi.fn(),
				process: vi.fn(),
			},
		},
	},
}));

import { MAX_TOTAL_CONTEXT_BYTES } from "@saas/projects/lib/ai-context-budget";
import { useCopilotDocumentUpload } from "@saas/shared/components/copilot/use-copilot-document-upload";

/** An image of an exact on-disk size. Content is irrelevant; only `size` is read. */
function imageOfBytes(name: string, bytes: number): File {
	const file = new File(["x"], name, { type: "image/png" });
	Object.defineProperty(file, "size", { value: bytes, configurable: true });
	return file;
}

/**
 * Raw bytes whose base64 form lands at `fraction` of the whole budget. The
 * check measures the ENCODED size, since that is what the entry costs once it
 * is a data URL in the request, so tests have to size their fixtures the same
 * way rather than by the file on disk.
 */
function rawBytesForBudgetFraction(fraction: number): number {
	return Math.floor((MAX_TOTAL_CONTEXT_BYTES * fraction * 3) / 4);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("cumulative request budget", () => {
	it("admits an attachment that fits", async () => {
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({ organizationId: null }),
		);

		await act(async () => {
			await result.current.addFiles([
				imageOfBytes("small.png", rawBytesForBudgetFraction(0.4)),
			]);
		});

		expect(mockToastError).not.toHaveBeenCalled();
		expect(result.current.attachedFiles).toHaveLength(1);
	});

	it("refuses the attachment that breaks the budget, keeping the one that fits", async () => {
		// The heart of the bug. Each is comfortably legal on its own; together
		// they are 1.2x the budget. A per-file check admits both.
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({ organizationId: null }),
		);

		await act(async () => {
			await result.current.addFiles([
				imageOfBytes("first.png", rawBytesForBudgetFraction(0.6)),
				imageOfBytes("second.png", rawBytesForBudgetFraction(0.6)),
			]);
		});

		expect(result.current.attachedFiles).toHaveLength(1);
		expect(result.current.attachedFiles[0]?.name).toBe("first.png");
		expect(mockToastError).toHaveBeenCalledTimes(1);
	});

	it("names the file it refused, so the user knows which one to replace", async () => {
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({ organizationId: null }),
		);

		await act(async () => {
			await result.current.addFiles([
				imageOfBytes("keep-me.png", rawBytesForBudgetFraction(0.6)),
				imageOfBytes("too-big.png", rawBytesForBudgetFraction(0.6)),
			]);
		});

		const message = String(mockToastError.mock.calls[0]?.[0] ?? "");
		expect(message).toContain("too-big.png");
		expect(message).not.toContain("keep-me.png");
	});

	it("counts what the host already carries, not just this batch", async () => {
		// The turn that killed the thread carried one new image and one already
		// resident from an earlier turn. Judged alone the new file fits, which
		// is precisely why the hook has to be told what the request is already
		// carrying.
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({
				organizationId: null,
				getResidentContext: () => ({
					bytes: Math.floor(MAX_TOTAL_CONTEXT_BYTES * 0.8),
					imageCount: 1,
				}),
			}),
		);

		await act(async () => {
			await result.current.addFiles([
				imageOfBytes("later.png", rawBytesForBudgetFraction(0.5)),
			]);
		});

		expect(result.current.attachedFiles).toHaveLength(0);
		expect(mockToastError).toHaveBeenCalledTimes(1);
	});

	it("tells the user to start a new chat once nothing more will fit", async () => {
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({
				organizationId: null,
				getResidentContext: () => ({
					bytes: MAX_TOTAL_CONTEXT_BYTES,
					imageCount: 2,
				}),
			}),
		);

		await act(async () => {
			await result.current.addFiles([imageOfBytes("any.png", 1024)]);
		});

		const message = String(mockToastError.mock.calls[0]?.[0] ?? "");
		expect(message.toLowerCase()).toContain("new chat");
	});
});

describe("image cap counts the session, not the message", () => {
	it("refuses a further image once the host already holds the cap", async () => {
		// `clearAttachments()` runs on every send, so chip state is empty at the
		// start of each turn while the published entries are not. Counting chips
		// therefore capped images per MESSAGE while the copy promised per
		// SESSION — five images a turn, indefinitely.
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({
				organizationId: null,
				maxImageCount: 5,
				getResidentContext: () => ({ bytes: 0, imageCount: 5 }),
			}),
		);

		await act(async () => {
			await result.current.addFiles([imageOfBytes("sixth.png", 1024)]);
		});

		expect(result.current.attachedFiles).toHaveLength(0);
		const message = String(mockToastError.mock.calls[0]?.[0] ?? "");
		expect(message).toContain("up to 5 images");
	});

	it("still admits an image when the session is below the cap", async () => {
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({
				organizationId: null,
				maxImageCount: 5,
				getResidentContext: () => ({ bytes: 0, imageCount: 4 }),
			}),
		);

		await act(async () => {
			await result.current.addFiles([imageOfBytes("fifth.png", 1024)]);
		});

		expect(mockToastError).not.toHaveBeenCalled();
		expect(result.current.attachedFiles).toHaveLength(1);
	});

	it("falls back to chip state when the host reports nothing", async () => {
		// Surfaces that do not supply `getResidentContext` must keep their
		// existing behaviour rather than silently losing the cap.
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({
				organizationId: null,
				maxImageCount: 1,
			}),
		);

		await act(async () => {
			await result.current.addFiles([
				imageOfBytes("a.png", 1024),
				imageOfBytes("b.png", 1024),
			]);
		});

		expect(result.current.attachedFiles).toHaveLength(1);
	});
});
