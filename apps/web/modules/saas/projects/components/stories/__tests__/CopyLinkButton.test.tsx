/**
 * Component tests for <CopyLinkButton>.
 *
 * Covers:
 *  AC-1  Happy path: feature with identifier → rich-text clipboard write
 *  AC-5  Clipboard permission denied        → failure toast, no crash
 *  AC-6a ClipboardItem unavailable          → writeText fallback
 *  AC-6b navigator.clipboard entirely absent → failure toast, no crash
 *  AC-7  Accessibility                      → aria-label, aria-live
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

// vi.hoisted ensures these are available when the vi.mock factory runs
// (vi.mock calls are hoisted to the top of the file by Vitest).
const { toastSuccess, toastError } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

// buildArtifactLink is a pure URL builder — pin its output so tests are
// URL-independent.
const CANONICAL_URL =
	"https://app.fabric.ai/app/acme/projects/proj_1/stories/story_abc";
vi.mock("@saas/projects/lib/links/buildArtifactLink", () => ({
	buildArtifactLink: () => CANONICAL_URL,
}));

// next-intl is already mocked globally (returns the key as the value).
// We re-mock here only to give human-readable strings for assertions.
vi.mock("next-intl", () => ({
	useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
	useLocale: () => "en",
}));

import { CopyLinkButton } from "../CopyLinkButton";

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderButton(
	overrides: Partial<React.ComponentProps<typeof CopyLinkButton>> = {},
) {
	return render(
		<CopyLinkButton
			identifier="F-001"
			title="Feature Title"
			storyId="story_abc"
			projectId="proj_1"
			organizationSlug="acme"
			{...overrides}
		/>,
	);
}

function getButton() {
	return screen.getByRole("button", { name: "Copy link" });
}

beforeEach(() => {
	toastSuccess.mockReset();
	toastError.mockReset();
	// Restore clipboard to a working state before each test so individual
	// tests that break it don't bleed into neighbours.
	Object.defineProperty(navigator, "clipboard", {
		value: {
			write: vi.fn().mockResolvedValue(undefined),
			writeText: vi.fn().mockResolvedValue(undefined),
		},
		configurable: true,
		writable: true,
	});
	// Ensure ClipboardItem is available by default.
	(globalThis as Record<string, unknown>).ClipboardItem =
		class ClipboardItem {
			constructor(public data: Record<string, Blob>) {}
		};
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CopyLinkButton", () => {
	// ── AC-7: Accessibility ─────────────────────────────────────────────────
	describe("AC-7: accessibility", () => {
		it("renders a button with aria-label='Copy link'", () => {
			renderButton();
			expect(getButton()).toBeInTheDocument();
		});

		it("renders an aria-live='polite' region for screen-reader announcements", () => {
			const { container } = renderButton();
			const liveRegion = container.querySelector("[aria-live='polite']");
			expect(liveRegion).not.toBeNull();
		});

		it("live region is empty before the button is clicked", () => {
			const { container } = renderButton();
			const liveRegion = container.querySelector("[aria-live='polite']");
			expect(liveRegion?.textContent).toBe("");
		});
	});

	// ── AC-1: Happy path — ClipboardItem write ──────────────────────────────
	describe("AC-1: happy path with ClipboardItem", () => {
		it("calls navigator.clipboard.write on click", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => {
				expect(navigator.clipboard.write).toHaveBeenCalledOnce();
			});
		});

		it("passes a ClipboardItem with text/html and text/plain blobs", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => {
				const [items] = (
					navigator.clipboard.write as ReturnType<typeof vi.fn>
				).mock.calls[0] as [InstanceType<typeof ClipboardItem>[]];
				const item = items[0];
				expect(item.data).toHaveProperty("text/html");
				expect(item.data).toHaveProperty("text/plain");
			});
		});

		it("shows a success toast", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => {
				expect(toastSuccess).toHaveBeenCalledOnce();
			});
		});

		it("announces the success message in the aria-live region", async () => {
			const { container } = renderButton();
			fireEvent.click(getButton());
			await waitFor(() => {
				const liveRegion = container.querySelector(
					"[aria-live='polite']",
				);
				expect(liveRegion?.textContent ?? "").not.toBe("");
			});
		});

		it("swaps the icon to CheckIcon (green) after a successful copy", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => {
				expect(
					document.querySelector(".text-green-500"),
				).not.toBeNull();
			});
		});
	});

	// ── AC-6a: ClipboardItem unavailable — fallback to writeText ───────────
	describe("AC-6a: ClipboardItem undefined — writeText fallback", () => {
		beforeEach(() => {
			delete (globalThis as Record<string, unknown>).ClipboardItem;
		});

		it("falls back to navigator.clipboard.writeText", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => {
				expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
			});
		});

		it("still shows a success toast on the writeText path", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => {
				expect(toastSuccess).toHaveBeenCalledOnce();
			});
		});

		it("passes the plain-text payload ('label — url') to writeText", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => {
				const [arg] = (
					navigator.clipboard.writeText as ReturnType<typeof vi.fn>
				).mock.calls[0] as [string];
				expect(arg).toContain("F-001 Feature Title");
				expect(arg).toContain(CANONICAL_URL);
				expect(arg).toContain("—");
			});
		});
	});

	// ── AC-5: Clipboard write permission denied ─────────────────────────────
	describe("AC-5: clipboard.write rejects (permission denied)", () => {
		beforeEach(() => {
			Object.defineProperty(navigator, "clipboard", {
				value: {
					write: vi
						.fn()
						.mockRejectedValue(new DOMException("Not allowed")),
					writeText: vi
						.fn()
						.mockRejectedValue(new DOMException("Not allowed")),
				},
				configurable: true,
				writable: true,
			});
		});

		it("shows a failure toast", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => {
				expect(toastError).toHaveBeenCalledOnce();
			});
		});

		it("does not show a success toast", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
			expect(toastSuccess).not.toHaveBeenCalled();
		});

		it("does not throw an uncaught exception", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
		});
	});

	// ── AC-6b: navigator.clipboard entirely absent ──────────────────────────
	describe("AC-6b: navigator.clipboard is undefined", () => {
		beforeEach(() => {
			Object.defineProperty(navigator, "clipboard", {
				value: undefined,
				configurable: true,
				writable: true,
			});
		});

		it("shows a failure toast rather than crashing", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => {
				expect(toastError).toHaveBeenCalledOnce();
			});
		});

		it("does not throw an uncaught exception", async () => {
			renderButton();
			fireEvent.click(getButton());
			await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
		});
	});

	// ── AC-2/AC-3: Identifier absent — title-only label ─────────────────────
	describe("AC-2/AC-3: no identifier", () => {
		it("passes a plain-text payload without an identifier prefix", async () => {
			delete (globalThis as Record<string, unknown>).ClipboardItem;
			renderButton({ identifier: null, title: "My Document" });
			fireEvent.click(getButton());
			await waitFor(() => {
				const [arg] = (
					navigator.clipboard.writeText as ReturnType<typeof vi.fn>
				).mock.calls[0] as [string];
				expect(arg).toContain("My Document");
				expect(arg).not.toContain("F-001");
			});
		});

		it("handles an empty-string identifier the same as null", async () => {
			delete (globalThis as Record<string, unknown>).ClipboardItem;
			renderButton({ identifier: "", title: "New Feature" });
			fireEvent.click(getButton());
			await waitFor(() => {
				const [arg] = (
					navigator.clipboard.writeText as ReturnType<typeof vi.fn>
				).mock.calls[0] as [string];
				expect(arg).toMatch(/^New Feature/);
			});
		});
	});
});
