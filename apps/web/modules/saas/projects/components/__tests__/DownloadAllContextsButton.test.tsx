/**
 * Component tests for DownloadAllContextsButton.
 *
 * Spec:
 * - docs/specs/2026-04-15-download-project-context-files/spec.md §7.2, §7.3, §13.3
 * - tasks.md §8.1
 *
 * Covers:
 *  1. Empty state (totalContexts === 0) — disabled-but-focusable, hidden
 *     aria-describedby hint carrying t("empty").
 *  2. Happy path click — telemetry ordering (_started BEFORE mutation
 *     resolves, _completed AFTER with durationMs >= 0), browser download
 *     anchor click triggered.
 *  3. 60 s client timeout — AbortController.abort() called, failure toast,
 *     _failed event with reason: "client_timeout".
 *  4. ORPCError { reason: "too_large" } — _failed event with reason: "too_large",
 *     tooLarge toast naming the size allowance.
 *  5. A count-limit refusal no longer exists: the server truncates past the
 *     item ceiling and ships an archive (Fizzy #2228), so nothing maps to a
 *     count-limit message and `too_many` falls through to "server_error".
 *  6. Generic error — _failed event with reason: "server_error", t("failed") toast.
 *  7. Per-reason skip reporting (Fizzy #2228) — the success toast keeps
 *     t("completed") as its title and fills its description with one line per
 *     reason the server actually reported; the hidden aria-live region
 *     announces the same lines joined into one sentence. Reasons counting
 *     zero print nothing, and an export that skipped nothing shows no
 *     description at all.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// jsdom polyfill: Radix Tooltip pulls in @radix-ui/react-use-size which
// references ResizeObserver on effect mount.
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
});

// ── Module mocks ──────────────────────────────────────────────────────────

const trackEventMock = vi.fn();
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => toastSuccessMock(...args),
		error: (...args: unknown[]) => toastErrorMock(...args),
	},
}));

// Lightweight translation mock that mirrors the relevant keys from
// packages/i18n/translations/en.json for namespace projects.contexts.download.
const translations: Record<string, string> = {
	action: "Download",
	actionForRow: "Download {title}",
	downloadAll: "Download all",
	downloadAllAria: "Download all contexts",
	preparing: "Preparing archive…",
	preparingAria: "Preparing archive, please wait",
	empty: "No contexts to download",
	pending: "This context is still being processed",
	extractedTextWarning:
		"Downloads extracted text — original source is not stored in Fabric",
	completed: "Downloaded {included} of {total} contexts",
	// Per-reason skip lines — hand-copied from
	// packages/i18n/translations/en.json. Their codes mirror
	// CONTEXT_SKIP_REASON_CODES in
	// packages/api/modules/projects/lib/context-skip-reason.ts.
	"skippedReason.NOTHING_STORED":
		"{count, plural, one {# item had nothing stored to export} other {# items had nothing stored to export}}",
	"skippedReason.EXTRACTION_FAILED":
		"{count, plural, one {# item's text extraction failed} other {# items' text extraction failed}}",
	"skippedReason.EXTRACTION_CANCELLED":
		"{count, plural, one {# item's text extraction was cancelled} other {# items' text extraction was cancelled}}",
	"skippedReason.CONVERSATION_NOT_CAPTURED":
		"{count, plural, one {# linked conversation had no captured messages} other {# linked conversations had no captured messages}}",
	"skippedReason.PRIVATE_CONVERSATION_EXCLUDED":
		"{count, plural, one {# linked chat is not captured by design — one-to-one and group chats stay in the source app} other {# linked chats are not captured by design — one-to-one and group chats stay in the source app}}",
	"skippedReason.CRAWL_INDEXED_NO_PAGES":
		"{count, plural, one {# crawled link indexed no pages} other {# crawled links indexed no pages}}",
	"skippedReason.OBJECT_MISSING":
		"{count, plural, one {# stored file was missing from storage} other {# stored files were missing from storage}}",
	"skippedReason.STORAGE_READ_FAILED":
		"{count, plural, one {# item could not be read from storage} other {# items could not be read from storage}}",
	"skippedReason.BEYOND_ITEM_LIMIT":
		"{count, plural, one {# item was past the archive's item limit — download it on its own} other {# items were past the archive's item limit — download them on their own}}",
	tooLarge:
		"This project's contexts total {size}. Batch download is limited to {maxSize}.",
	failed: "Download failed. Please try again.",
};

/** Minimal ICU: `{name, plural, one {…} other {…}}`, then `{name}`. */
function interpolate(
	template: string,
	params?: Record<string, unknown>,
): string {
	let out = template.replace(
		/\{(\w+),\s*plural,\s*one\s*\{([^{}]*)\}\s*other\s*\{([^{}]*)\}\}/g,
		(_match, name: string, one: string, other: string) => {
			const n = Number(params?.[name] ?? 0);
			return (n === 1 ? one : other).replaceAll("#", String(n));
		},
	);
	if (!params) {
		return out;
	}
	for (const [k, v] of Object.entries(params)) {
		out = out.replaceAll(`{${k}}`, String(v));
	}
	return out;
}

/**
 * The success toast's `description` slot is a React node. Render it in
 * isolation so assertions read its text and its line count, without coupling
 * to the element tree the component happens to build.
 */
function readToastDescription(): { text: string; lines: string[] } {
	const options = toastSuccessMock.mock.calls[0]?.[1] as
		| { description?: ReactNode }
		| undefined;
	if (!options?.description) {
		return { text: "", lines: [] };
	}
	const { container, unmount } = render(<>{options.description}</>);
	const result = {
		text: container.textContent ?? "",
		lines: Array.from(container.querySelectorAll("li")).map(
			(li) => li.textContent ?? "",
		),
	};
	unmount();
	return result;
}

vi.mock("next-intl", () => ({
	useTranslations:
		(_namespace?: string) =>
		(key: string, params?: Record<string, unknown>) => {
			const template = translations[key] ?? key;
			return interpolate(template, params);
		},
}));

// oRPC client mock — the component calls
// `orpc.projects.contexts.createBatchDownloadUrl.call(input, { signal })`.
const createBatchDownloadUrlMock = vi.fn();
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				createBatchDownloadUrl: {
					call: (...args: unknown[]) =>
						createBatchDownloadUrlMock(...args),
				},
			},
		},
	},
}));

// Import after mocks so Vitest wires factories correctly.
import { DownloadAllContextsButton } from "../DownloadAllContextsButton";

// ── Shared helpers ────────────────────────────────────────────────────────

const baseProps = {
	projectId: "proj_1",
	organizationId: "org_1" as string | null,
	totalContexts: 3,
	totalBytesEstimate: 12_345,
};

class ORPCErrorLike extends Error {
	data: Record<string, unknown>;
	constructor(data: Record<string, unknown>) {
		super("ORPCError");
		this.data = data;
	}
}

let anchorClickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	trackEventMock.mockReset();
	toastSuccessMock.mockReset();
	toastErrorMock.mockReset();
	createBatchDownloadUrlMock.mockReset();
	anchorClickSpy = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("DownloadAllContextsButton — empty state", () => {
	it("is disabled, tab-focusable, and advertises empty hint via aria-describedby", () => {
		render(
			<DownloadAllContextsButton
				{...baseProps}
				totalContexts={0}
				totalBytesEstimate={0}
			/>,
		);

		const button = screen.getByRole("button", {
			name: translations.downloadAllAria,
		});

		// Disabled semantics without losing tab focus.
		expect(button).toHaveAttribute("aria-disabled", "true");
		expect(button.tabIndex).not.toBe(-1);

		// aria-describedby points at an element whose text carries t("empty").
		const describedBy = button.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		const hint = describedBy ? document.getElementById(describedBy) : null;
		expect(hint).not.toBeNull();
		expect(hint?.textContent).toBe(translations.empty);
	});

	it("does not fire mutation or telemetry when clicked while empty", async () => {
		const user = userEvent.setup();
		render(
			<DownloadAllContextsButton
				{...baseProps}
				totalContexts={0}
				totalBytesEstimate={0}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: translations.downloadAllAria }),
		);

		expect(createBatchDownloadUrlMock).not.toHaveBeenCalled();
		expect(trackEventMock).not.toHaveBeenCalled();
	});
});

describe("DownloadAllContextsButton — happy path", () => {
	it("emits _started before mutation resolves, triggers download, then emits _completed", async () => {
		// Mutation that only resolves when we explicitly call `resolve()`.
		let resolveMutation: (value: {
			url: string;
			filename: string;
			includedCount: number;
			skippedCount: number;
			totalCount: number;
		}) => void = () => undefined;

		createBatchDownloadUrlMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);

		const user = userEvent.setup();
		render(<DownloadAllContextsButton {...baseProps} totalContexts={3} />);

		await user.click(
			screen.getByRole("button", { name: translations.downloadAllAria }),
		);

		// _started event fired BEFORE the mutation has resolved.
		expect(trackEventMock).toHaveBeenCalledTimes(1);
		expect(trackEventMock).toHaveBeenNthCalledWith(
			1,
			"project_contexts_download_all_started",
			{
				projectId: "proj_1",
				totalContexts: 3,
				totalBytesEstimate: 12_345,
				organizationId: "org_1",
			},
		);

		// Mutation still pending — no _completed yet.
		expect(trackEventMock).toHaveBeenCalledTimes(1);

		// Resolve now.
		await act(async () => {
			resolveMutation({
				url: "https://example.invalid/archive.zip",
				filename: "proj-contexts-2026-04-15.zip",
				includedCount: 3,
				skippedCount: 0,
				totalCount: 3,
			});
		});

		// Browser download triggered.
		await waitFor(() => {
			expect(anchorClickSpy).toHaveBeenCalledTimes(1);
		});

		// _completed event with numeric durationMs >= 0.
		await waitFor(() => {
			expect(trackEventMock).toHaveBeenCalledTimes(2);
		});
		const [completedName, completedPayload] = trackEventMock.mock.calls[1];
		expect(completedName).toBe("project_contexts_download_all_completed");
		expect(completedPayload).toMatchObject({
			projectId: "proj_1",
			includedFiles: 3,
			skippedFiles: 0,
		});
		expect(
			typeof (completedPayload as { durationMs: unknown }).durationMs,
		).toBe("number");
		expect(
			(completedPayload as { durationMs: number }).durationMs,
		).toBeGreaterThanOrEqual(0);

		// Success toast surfaced.
		expect(toastSuccessMock).toHaveBeenCalled();
	});

	it("passes the AbortController signal and { projectId, organizationId } input to the mutation", async () => {
		createBatchDownloadUrlMock.mockResolvedValueOnce({
			url: "https://example.invalid/a.zip",
			filename: "a.zip",
			includedCount: 1,
			skippedCount: 0,
			totalCount: 1,
		});

		const user = userEvent.setup();
		render(<DownloadAllContextsButton {...baseProps} />);

		await user.click(
			screen.getByRole("button", { name: translations.downloadAllAria }),
		);

		await waitFor(() => {
			expect(createBatchDownloadUrlMock).toHaveBeenCalledTimes(1);
		});

		const [input, options] = createBatchDownloadUrlMock.mock.calls[0] as [
			{ projectId: string; organizationId: string | null },
			{ signal: AbortSignal },
		];
		expect(input).toEqual({ projectId: "proj_1", organizationId: "org_1" });
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("DownloadAllContextsButton — 60 second client timeout", () => {
	it("aborts the controller, shows failure toast, and emits client_timeout failure", async () => {
		vi.useFakeTimers();

		// Track whether abort() was invoked on the controller that the
		// component creates.
		const abortSpy = vi.spyOn(AbortController.prototype, "abort");

		// Mutation rejects when its AbortSignal is aborted; otherwise hangs.
		createBatchDownloadUrlMock.mockImplementation(
			(_input: unknown, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					if (options.signal.aborted) {
						reject(
							new DOMException(
								"The operation was aborted.",
								"AbortError",
							),
						);
						return;
					}
					options.signal.addEventListener("abort", () => {
						reject(
							new DOMException(
								"The operation was aborted.",
								"AbortError",
							),
						);
					});
				}),
		);

		render(<DownloadAllContextsButton {...baseProps} />);

		// fireEvent.click is synchronous; userEvent under fake timers needs
		// extra plumbing that is unnecessary here.
		fireEvent.click(
			screen.getByRole("button", { name: translations.downloadAllAria }),
		);

		// Advance past the 60 s client timeout and flush pending microtasks.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});

		// AbortController.abort() was called by the timeout handler.
		expect(abortSpy).toHaveBeenCalled();

		// Failure toast rendered with the generic failed message.
		expect(toastErrorMock).toHaveBeenCalledWith(translations.failed);

		// _failed event with reason: "client_timeout".
		const failedCall = trackEventMock.mock.calls.find(
			(c) => c[0] === "project_contexts_download_all_failed",
		);
		expect(failedCall).toBeDefined();
		expect(failedCall?.[1]).toMatchObject({
			projectId: "proj_1",
			reason: "client_timeout",
		});
	});
});

describe("DownloadAllContextsButton — server error mapping", () => {
	it("maps ORPCError { reason: 'too_large' } to failed event and tooLarge toast", async () => {
		createBatchDownloadUrlMock.mockRejectedValueOnce(
			new ORPCErrorLike({
				reason: "too_large",
				count: 201,
				size: "600 MB",
				maxCount: 200,
				maxSize: "500 MB",
			}),
		);

		const user = userEvent.setup();
		render(<DownloadAllContextsButton {...baseProps} />);

		await user.click(
			screen.getByRole("button", { name: translations.downloadAllAria }),
		);

		await waitFor(() => {
			const failedCall = trackEventMock.mock.calls.find(
				(c) => c[0] === "project_contexts_download_all_failed",
			);
			expect(failedCall).toBeDefined();
			expect(failedCall?.[1]).toMatchObject({
				projectId: "proj_1",
				reason: "too_large",
			});
		});

		// Toast contains interpolated tooLarge text — the size allowance and
		// nothing about a count, which is no longer a reason anything fails.
		expect(toastErrorMock).toHaveBeenCalled();
		const toastMessage = String(toastErrorMock.mock.calls[0]?.[0] ?? "");
		expect(toastMessage).toContain("600 MB");
		expect(toastMessage).toContain("500 MB");
		expect(toastMessage).not.toContain("201");
		expect(toastMessage).not.toContain("200");
	});

	it("never maps an error to a count-limit message, since no count refuses an export any more", async () => {
		// A project past the item ceiling is truncated and shipped with its
		// excluded rows named in the manifest (Fizzy #2228), so the server no
		// longer emits this shape at all. If one arrived anyway — an older
		// deployment mid-rollout — the client must not restate a limit that
		// has stopped existing, so it falls through to the generic failure.
		createBatchDownloadUrlMock.mockRejectedValueOnce(
			new ORPCErrorLike({
				reason: "too_many",
				count: 300,
				size: "100 MB",
				maxCount: 200,
				maxSize: "500 MB",
			}),
		);

		const user = userEvent.setup();
		render(<DownloadAllContextsButton {...baseProps} />);

		await user.click(
			screen.getByRole("button", { name: translations.downloadAllAria }),
		);

		await waitFor(() => {
			const failedCall = trackEventMock.mock.calls.find(
				(c) => c[0] === "project_contexts_download_all_failed",
			);
			expect(failedCall).toBeDefined();
			expect(failedCall?.[1]).toMatchObject({
				projectId: "proj_1",
				reason: "server_error",
			});
		});

		const toastMessage = String(toastErrorMock.mock.calls[0]?.[0] ?? "");
		expect(toastMessage).toBe(translations.failed);
		expect(toastMessage).not.toContain("limited to");
	});

	it("maps an unknown server error to reason: 'server_error' and failed toast", async () => {
		createBatchDownloadUrlMock.mockRejectedValueOnce(
			new Error("boom from server"),
		);

		const user = userEvent.setup();
		render(<DownloadAllContextsButton {...baseProps} />);

		await user.click(
			screen.getByRole("button", { name: translations.downloadAllAria }),
		);

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith(translations.failed);
		});

		const failedCall = trackEventMock.mock.calls.find(
			(c) => c[0] === "project_contexts_download_all_failed",
		);
		expect(failedCall).toBeDefined();
		expect(failedCall?.[1]).toMatchObject({
			projectId: "proj_1",
			reason: "server_error",
		});
	});
});

describe("DownloadAllContextsButton — per-reason skip summary", () => {
	/** Every reason at zero, so a case names only the ones it means. */
	const noSkips = {
		NOTHING_STORED: 0,
		EXTRACTION_FAILED: 0,
		EXTRACTION_CANCELLED: 0,
		CONVERSATION_NOT_CAPTURED: 0,
		PRIVATE_CONVERSATION_EXCLUDED: 0,
		CRAWL_INDEXED_NO_PAGES: 0,
		OBJECT_MISSING: 0,
		STORAGE_READ_FAILED: 0,
		BEYOND_ITEM_LIMIT: 0,
	};

	async function clickThrough(result: Record<string, unknown>) {
		createBatchDownloadUrlMock.mockResolvedValueOnce(result);
		const user = userEvent.setup();
		const rendered = render(
			<DownloadAllContextsButton {...baseProps} totalContexts={10} />,
		);
		await user.click(
			screen.getByRole("button", { name: translations.downloadAllAria }),
		);
		await waitFor(() => {
			expect(toastSuccessMock).toHaveBeenCalled();
		});
		return rendered;
	}

	it("renders one description line per reason present and omits zero counts", async () => {
		await clickThrough({
			url: "https://example.invalid/partial.zip",
			filename: "partial.zip",
			includedCount: 6,
			skippedCount: 4,
			excludedCount: 0,
			totalCount: 10,
			skippedByReason: {
				...noSkips,
				NOTHING_STORED: 2,
				CONVERSATION_NOT_CAPTURED: 1,
				CRAWL_INDEXED_NO_PAGES: 1,
			},
		});

		// The completion sentence stays the toast TITLE — the summary lives in
		// the description slot, so no new control appears on the Context tab.
		expect(toastSuccessMock.mock.calls[0]?.[0]).toBe(
			"Downloaded 6 of 10 contexts",
		);

		const { text, lines } = readToastDescription();
		expect(lines).toHaveLength(3);
		expect(text).toContain("2 items had nothing stored to export");
		expect(text).toContain(
			"1 linked conversation had no captured messages",
		);
		expect(text).toContain("1 crawled link indexed no pages");
		// Reasons that did not occur print nothing at all.
		expect(text).not.toContain("extraction");
		expect(text).not.toContain("storage");
		expect(text).not.toContain("item limit");
	});

	it("announces every reason present in the aria-live region, matching the visible summary", async () => {
		const { container } = await clickThrough({
			url: "https://example.invalid/partial.zip",
			filename: "partial.zip",
			includedCount: 7,
			skippedCount: 3,
			excludedCount: 0,
			totalCount: 10,
			skippedByReason: {
				...noSkips,
				EXTRACTION_FAILED: 1,
				OBJECT_MISSING: 1,
				STORAGE_READ_FAILED: 1,
			},
		});

		const liveRegion = container.querySelector('[aria-live="polite"]');
		expect(liveRegion).not.toBeNull();
		const announced = liveRegion?.textContent ?? "";

		expect(announced).toContain("Downloaded 7 of 10 contexts");
		expect(announced).toContain("1 item's text extraction failed");
		expect(announced).toContain("1 stored file was missing from storage");
		expect(announced).toContain("1 item could not be read from storage");

		// Same strings, same set: the announcement is the visible summary read
		// as one sentence, never a separate (and separately stale) message.
		const { lines } = readToastDescription();
		expect(lines).toHaveLength(3);
		for (const line of lines) {
			expect(announced).toContain(line);
		}
	});

	it("separates a chat excluded by design from a channel still awaiting capture", async () => {
		// Both rows are linked conversations that contributed nothing, and the
		// summary must not blend them: one is waiting, the other never will be.
		await clickThrough({
			url: "https://example.invalid/partial.zip",
			filename: "partial.zip",
			includedCount: 4,
			skippedCount: 2,
			excludedCount: 0,
			totalCount: 6,
			skippedByReason: {
				...noSkips,
				CONVERSATION_NOT_CAPTURED: 1,
				PRIVATE_CONVERSATION_EXCLUDED: 1,
			},
		});

		const { text, lines } = readToastDescription();
		expect(lines).toHaveLength(2);
		expect(text).toContain(
			"1 linked conversation had no captured messages",
		);
		expect(text).toContain(
			"1 linked chat is not captured by design — one-to-one and group chats stay in the source app",
		);
	});

	it("states an over-ceiling export with the ceiling reason, not a processing one", async () => {
		await clickThrough({
			url: "https://example.invalid/truncated.zip",
			filename: "truncated.zip",
			includedCount: 200,
			skippedCount: 3,
			excludedCount: 3,
			totalCount: 203,
			skippedByReason: { ...noSkips, BEYOND_ITEM_LIMIT: 3 },
		});

		const { text, lines } = readToastDescription();
		expect(lines).toHaveLength(1);
		expect(text).toContain(
			"3 items were past the archive's item limit — download them on their own",
		);
		// The blended sentence this replaces described a deliberate truncation
		// as a processing delay. Nothing may say that again.
		expect(text).not.toMatch(/still processing|unavailable/i);
	});

	it("shows no skip summary when every item was included", async () => {
		const { container } = await clickThrough({
			url: "https://example.invalid/full.zip",
			filename: "full.zip",
			includedCount: 10,
			skippedCount: 0,
			excludedCount: 0,
			totalCount: 10,
			skippedByReason: { ...noSkips },
		});

		expect(toastSuccessMock.mock.calls[0]?.[0]).toBe(
			"Downloaded 10 of 10 contexts",
		);
		const { text, lines } = readToastDescription();
		expect(lines).toHaveLength(0);
		expect(text).toBe("");

		const liveRegion = container.querySelector('[aria-live="polite"]');
		expect(liveRegion?.textContent).toBe("Downloaded 10 of 10 contexts");
	});

	it("degrades to the completion sentence alone when the server sends no taxonomy", async () => {
		// An older deployment mid-rollout returns counts without
		// `skippedByReason`. Inventing a reason would be the same class of lie
		// this taxonomy removes, so the summary simply says nothing extra.
		const { container } = await clickThrough({
			url: "https://example.invalid/legacy.zip",
			filename: "legacy.zip",
			includedCount: 9,
			skippedCount: 1,
			totalCount: 10,
		});

		expect(readToastDescription().lines).toHaveLength(0);
		const liveRegion = container.querySelector('[aria-live="polite"]');
		expect(liveRegion?.textContent).toBe("Downloaded 9 of 10 contexts");
	});
});
