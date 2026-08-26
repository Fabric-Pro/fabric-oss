import { logger } from "@repo/logs";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `notFound()` in Next throws an internal error to halt rendering; mirror that so
// the page's control flow (return after gate) is exercised exactly as in prod.
class NotFoundError extends Error {
	constructor() {
		super("NEXT_NOT_FOUND");
		this.name = "NotFoundError";
	}
}
const notFound = vi.fn(() => {
	throw new NotFoundError();
});
vi.mock("next/navigation", () => ({
	notFound: () => notFound(),
}));

// Server data helper (Task 8) — fully mocked; gating logic lives here.
const getEmbedReleaseNotes = vi.fn();
vi.mock("@marketing/release-notes/lib/embed-release-notes", () => ({
	getEmbedReleaseNotes: (...a: unknown[]) => getEmbedReleaseNotes(...a),
}));

// Repo logger — assert the THROW path records the failure (observability), and
// confirm the normal unknown/disabled 404 paths stay unlogged. Mirror the
// sibling marketing tests' shape; include all consola levels the module could
// call so none resolve undefined.
vi.mock("@repo/logs", () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

// next-intl server helpers: locale/messages/translations. `getTranslations`
// returns an identity `t` so we can assert on the i18n KEYS the page passes.
vi.mock("next-intl/server", () => ({
	getLocale: vi.fn(async () => "en"),
	getMessages: vi.fn(async () => ({})),
	getTranslations: vi.fn(async () => (key: string) => key),
}));

// The client provider is irrelevant to the assertions — render children inline.
vi.mock("next-intl", () => ({
	NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => (
		<>{children}</>
	),
}));

// Stub the feed (non-linking by construction) so we can assert it received the
// resolved copy/labels without pulling in the real list rendering.
vi.mock("@marketing/release-notes/components/ReleaseNotesListPublic", () => ({
	ReleaseNotesListPublic: ({
		emptyLabel,
		fallbackHeadline,
	}: {
		emptyLabel: string;
		fallbackHeadline: string;
	}) => (
		<div
			data-testid="feed"
			data-empty-label={emptyLabel}
			data-fallback-headline={fallbackHeadline}
		/>
	),
}));

// Stub the subscribe form ("use client") so we can assert it received the token.
vi.mock("@marketing/shared/components/NewsletterForm", () => ({
	NewsletterForm: ({ token }: { token?: string }) => (
		<div data-testid="subscribe-form" data-token={token ?? ""} />
	),
}));

// `resolveReleaseWidgetParams` stays REAL — the theme/accent/width/radius CSS
// assertions must exercise the actual clamp/allowlist logic (CSS-injection-safe).

import ReleaseNotesEmbedPage from "./page";

const ENABLED = {
	enabled: true,
	sends: [{ id: "s1" }],
	theme: "dark",
	accent: "#9F2A3A",
	config: null,
};

beforeEach(() => {
	getEmbedReleaseNotes.mockReset();
	notFound.mockClear();
	vi.mocked(logger.error).mockClear();
});

afterEach(() => {
	vi.clearAllMocks();
});

/** Render the async RSC page; awaits the element tree then mounts it. */
async function renderPage(searchParams: Record<string, string | string[]>) {
	const element = await ReleaseNotesEmbedPage({
		searchParams: Promise.resolve(searchParams),
	});
	return render(element);
}

describe("/embed/release-notes page", () => {
	it("exports robots noindex metadata (embed pages must not be indexed)", async () => {
		const { metadata } = await import("./page");
		expect(metadata.robots).toEqual({ index: false, follow: false });
	});

	it("calls notFound() when the token (`t`) is missing", async () => {
		await expect(renderPage({})).rejects.toBeInstanceOf(NotFoundError);
		expect(notFound).toHaveBeenCalled();
		// Never resolve a token we don't have.
		expect(getEmbedReleaseNotes).not.toHaveBeenCalled();
	});

	it("calls notFound() for an unknown token (helper returns null) WITHOUT logging (normal 404)", async () => {
		getEmbedReleaseNotes.mockResolvedValue(null);
		await expect(renderPage({ t: "nope" })).rejects.toBeInstanceOf(
			NotFoundError,
		);
		expect(getEmbedReleaseNotes).toHaveBeenCalledWith("nope");
		expect(notFound).toHaveBeenCalled();
		// An unknown token is an expected 404 — it must NOT hit the error log
		// (only the resolve THROW path is an observable failure).
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("calls notFound() when the widget is disabled (no error log — normal 404)", async () => {
		getEmbedReleaseNotes.mockResolvedValue({
			enabled: false,
			sends: [],
			theme: null,
			accent: null,
			config: null,
		});
		await expect(renderPage({ t: "tok" })).rejects.toBeInstanceOf(
			NotFoundError,
		);
		expect(notFound).toHaveBeenCalled();
		// A disabled widget is an intentional 404, not a failure.
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("calls notFound() AND logs (no token) when the helper throws (resolve blip → 404, not a 500)", async () => {
		const resolveError = new Error("db down");
		getEmbedReleaseNotes.mockRejectedValue(resolveError);
		await expect(renderPage({ t: "secret-token" })).rejects.toBeInstanceOf(
			NotFoundError,
		);
		expect(notFound).toHaveBeenCalled();
		// The resolve failure must be recorded so a DB/token-resolve outage
		// isn't invisible behind the external 404.
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledWith(
			expect.any(String),
			resolveError,
		);
		// The raw bearer token must NEVER appear in the log args (URL credential).
		for (const call of vi.mocked(logger.error).mock.calls) {
			for (const arg of call) {
				expect(String(arg)).not.toContain("secret-token");
			}
		}
	});

	describe("when enabled", () => {
		beforeEach(() => {
			getEmbedReleaseNotes.mockResolvedValue(ENABLED);
		});

		it("renders the non-linking feed and the subscribe form wired with the token", async () => {
			const { getByTestId } = await renderPage({ t: "tok" });
			const feed = getByTestId("feed");
			// The feed is non-linking BY CONSTRUCTION now (the component no longer
			// renders /release-notes/ links), so nothing can leak from the iframe.
			// The same i18n keys the marketing page uses, for copy consistency.
			expect(feed.getAttribute("data-empty-label")).toBe(
				"releaseNotes.empty",
			);
			expect(feed.getAttribute("data-fallback-headline")).toBe(
				"releaseNotes.fallbackHeadline",
			);
			expect(
				getByTestId("subscribe-form").getAttribute("data-token"),
			).toBe("tok");
		});

		it("does NOT render an unguarded token=undefined case (the t param is required)", async () => {
			// The form must always carry the resolved token, never undefined.
			const { getByTestId } = await renderPage({ t: "tok" });
			expect(
				getByTestId("subscribe-form").getAttribute("data-token"),
			).toBe("tok");
		});

		it("applies the dark theme class and accent/radius CSS variables from validated params", async () => {
			const { container } = await renderPage({
				t: "tok",
				theme: "dark",
				accent: "#abc",
				radius: "8",
			});
			const wrapper = container.querySelector("div.dark") as HTMLElement;
			expect(wrapper).not.toBeNull();
			// accent → --primary, radius → --radius (both already clamped/validated).
			expect(wrapper.style.getPropertyValue("--primary")).toBe("#abc");
			expect(wrapper.style.getPropertyValue("--radius")).toBe("8px");
		});

		it("drops an invalid accent (not applied as a CSS var)", async () => {
			const { container } = await renderPage({ t: "tok", accent: "red" });
			const wrapper = container.firstElementChild as HTMLElement;
			expect(wrapper.style.getPropertyValue("--primary")).toBe("");
		});

		it("clamps width and applies compact density + serif font as classes/inline width", async () => {
			const { container } = await renderPage({
				t: "tok",
				width: "99999",
				density: "compact",
				font: "serif",
			});
			// width clamped to 640 → applied as the inner container max-width.
			const inner = container.querySelector(
				'[style*="max-width"]',
			) as HTMLElement;
			expect(inner.style.maxWidth).toBe("640px");
			// compact density and serif font surface as utility classes.
			expect(container.innerHTML).toContain("text-sm");
			expect(container.innerHTML).toContain("font-serif");
		});

		it("supports width=100% (no px suffix)", async () => {
			const { container } = await renderPage({ t: "tok", width: "100%" });
			const inner = container.querySelector(
				'[style*="max-width"]',
			) as HTMLElement;
			expect(inner.style.maxWidth).toBe("100%");
		});
	});
});
