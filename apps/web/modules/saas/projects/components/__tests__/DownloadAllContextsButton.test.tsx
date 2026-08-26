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
 *     tooLarge toast with interpolated values.
 *  5. ORPCError { reason: "too_many" } — _failed event with reason: "too_many".
 *  6. Generic error — _failed event with reason: "server_error", t("failed") toast.
 *  7. Skipped-count announcement — aria-live region surfaces both
 *     t("completed") and t("skipped") strings.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
	skipped: "{skipped} were skipped (still processing or unavailable)",
	tooLarge:
		"This project has {count} contexts ({size}). Batch download is limited to {maxCount} contexts and {maxSize}.",
	failed: "Download failed. Please try again.",
};

function interpolate(
	template: string,
	params?: Record<string, unknown>,
): string {
	if (!params) {
		return template;
	}
	let out = template;
	for (const [k, v] of Object.entries(params)) {
		out = out.replaceAll(`{${k}}`, String(v));
	}
	return out;
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

		// Toast contains interpolated tooLarge text.
		expect(toastErrorMock).toHaveBeenCalled();
		const toastMessage = String(toastErrorMock.mock.calls[0]?.[0] ?? "");
		expect(toastMessage).toContain("201");
		expect(toastMessage).toContain("600 MB");
		expect(toastMessage).toContain("200");
		expect(toastMessage).toContain("500 MB");
	});

	it("maps ORPCError { reason: 'too_many' } to failed event", async () => {
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
				reason: "too_many",
			});
		});
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

describe("DownloadAllContextsButton — skipped count announcement", () => {
	it("announces both completed and skipped counts in the aria-live region", async () => {
		createBatchDownloadUrlMock.mockResolvedValueOnce({
			url: "https://example.invalid/partial.zip",
			filename: "partial.zip",
			includedCount: 9,
			skippedCount: 1,
			totalCount: 10,
		});

		const user = userEvent.setup();
		const { container } = render(
			<DownloadAllContextsButton {...baseProps} totalContexts={10} />,
		);

		await user.click(
			screen.getByRole("button", { name: translations.downloadAllAria }),
		);

		// aria-live="polite" region picks up both messages.
		await waitFor(() => {
			const liveRegion = container.querySelector('[aria-live="polite"]');
			expect(liveRegion).not.toBeNull();
			const text = liveRegion?.textContent ?? "";
			expect(text).toContain("Downloaded 9 of 10 contexts");
			expect(text).toContain(
				"1 were skipped (still processing or unavailable)",
			);
		});

		// Success toast also surfaced.
		expect(toastSuccessMock).toHaveBeenCalled();
	});
});
