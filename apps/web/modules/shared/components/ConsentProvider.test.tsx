import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted ensures the spy is available when the vi.mock factory runs
// (vi.mock is hoisted to the top of the file by Vitest).
const { set } = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("js-cookie", () => ({
	default: { set, get: vi.fn(), remove: vi.fn() },
}));

import { getConsentCookieDomain } from "@shared/lib/consent";
import { ConsentContext, ConsentProvider } from "./ConsentProvider";

function AllowButton() {
	const { allowAllCookies } = useContext(ConsentContext);
	return (
		<button type="button" onClick={allowAllCookies}>
			allow
		</button>
	);
}

function ConsentProbe() {
	const { hasResponded, preferences } = useContext(ConsentContext);
	return (
		<output data-testid="consent-probe">
			{JSON.stringify({ hasResponded, preferences })}
		</output>
	);
}

function FirstRenderProbe({
	onFirstRender,
}: {
	onFirstRender: (hasResponded: boolean) => void;
}) {
	const { hasResponded } = useContext(ConsentContext);
	const recorded = useRef(false);
	if (!recorded.current) {
		recorded.current = true;
		onFirstRender(hasResponded);
	}
	return null;
}

const CONSENT_STORAGE_KEY = "fabric_cookie_consent";
const BANNER_ROLE_QUERY = [
	"complementary",
	{ name: "Analytics preferences" },
] as const;

describe("ConsentProvider embed mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.localStorage.clear();
	});

	// `allowAllCookies` routes through `saveConsentState`, which is the single
	// place that writes consent cookies. The GPC/DNT `forceGlobalOptOut` effect
	// also routes through `saveConsentState`, so guarding it (skip `Cookies.set`
	// when `isEmbed`) transitively covers the GPC/DNT path too. (Note: on a fresh
	// mount the GPC/DNT effect no-ops anyway — the provider initializes state to
	// "declined" + opted-out, so the effect's guard returns before writing — which
	// is why the cookie-write guard is exercised here via the user-action path.)
	it("does NOT write consent cookies in embed mode", async () => {
		render(
			<ConsentProvider isEmbed>
				<AllowButton />
			</ConsentProvider>,
		);
		await userEvent.click(screen.getByText("allow"));
		expect(set).not.toHaveBeenCalled();
		expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
	});

	it("writes consent cookies on normal routes", async () => {
		render(
			<ConsentProvider>
				<AllowButton />
			</ConsentProvider>,
		);
		await userEvent.click(screen.getByText("allow"));
		expect(set).toHaveBeenCalledWith(
			"fabric_analytics_consent",
			"granted",
			expect.objectContaining({ path: "/", sameSite: "lax" }),
		);
	});

	it("defaults optional analytics and marketing to off until consent", () => {
		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		expect(screen.getByTestId("consent-probe")).toHaveTextContent(
			JSON.stringify({
				hasResponded: false,
				preferences: {
					essential: true,
					analytics: false,
					marketing: false,
				},
			}),
		);
		expect(
			screen.getByRole("complementary", {
				name: "Analytics preferences",
			}),
		).toBeInTheDocument();
	});

	it("shares consent across the Fabric subdomains only", () => {
		expect(getConsentCookieDomain("docs.fabric.pro")).toBe(".fabric.pro");
		expect(getConsentCookieDomain("fabric.pro")).toBe(".fabric.pro");
		expect(getConsentCookieDomain("localhost")).toBeUndefined();
	});
});

describe("consent banner dismissal resilience", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.localStorage.clear();
	});

	// `vi.clearAllMocks` clears calls but not implementations, so throwing
	// `set` implementations must be undone here to keep later tests honest.
	afterEach(() => {
		set.mockReset();
		vi.restoreAllMocks();
	});

	it("hides the banner after Allow analytics and records the customized decision", async () => {
		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		await userEvent.click(
			screen.getByRole("button", { name: "Allow analytics" }),
		);

		expect(
			screen.queryByRole(...BANNER_ROLE_QUERY),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("consent-probe")).toHaveTextContent(
			JSON.stringify({
				hasResponded: true,
				preferences: {
					essential: true,
					analytics: true,
					marketing: false,
				},
			}),
		);
	});

	it("hides the banner after Decline and records the declined decision", async () => {
		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Decline" }));

		expect(
			screen.queryByRole(...BANNER_ROLE_QUERY),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("consent-probe")).toHaveTextContent(
			JSON.stringify({
				hasResponded: true,
				preferences: {
					essential: true,
					analytics: false,
					marketing: false,
				},
			}),
		);
	});

	it("still hides the banner when cookie writes throw", async () => {
		set.mockImplementation(() => {
			throw new Error("cookie write blocked");
		});

		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Decline" }));

		expect(
			screen.queryByRole(...BANNER_ROLE_QUERY),
		).not.toBeInTheDocument();
	});

	it("still hides the banner when cookie and localStorage writes both throw", async () => {
		set.mockImplementation(() => {
			throw new Error("cookie write blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("storage write blocked");
		});

		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		await userEvent.click(
			screen.getByRole("button", { name: "Allow analytics" }),
		);

		expect(
			screen.queryByRole(...BANNER_ROLE_QUERY),
		).not.toBeInTheDocument();
	});

	it("persists the decision to the localStorage fallback", async () => {
		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		await userEvent.click(
			screen.getByRole("button", { name: "Allow analytics" }),
		);

		const stored = JSON.parse(
			window.localStorage.getItem(CONSENT_STORAGE_KEY) ?? "null",
		);
		expect(stored).toMatchObject({
			state: "customized",
			preferences: { essential: true, analytics: true, marketing: false },
		});
		expect(Number.isNaN(Date.parse(stored?.updatedAt))).toBe(false);
	});
});

describe("consent fallback recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.localStorage.clear();
	});

	afterEach(() => {
		set.mockReset();
	});

	function seedFallback(overrides: Record<string, unknown> = {}) {
		window.localStorage.setItem(
			CONSENT_STORAGE_KEY,
			JSON.stringify({
				state: "accepted",
				preferences: {
					essential: true,
					analytics: true,
					marketing: true,
				},
				updatedAt: new Date().toISOString(),
				...overrides,
			}),
		);
	}

	it("recovers a stored decision when cookies are missing and re-writes them", () => {
		seedFallback();

		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		expect(
			screen.queryByRole(...BANNER_ROLE_QUERY),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("consent-probe")).toHaveTextContent(
			JSON.stringify({
				hasResponded: true,
				preferences: {
					essential: true,
					analytics: true,
					marketing: true,
				},
			}),
		);
		const cookieAttributes = expect.objectContaining({
			path: "/",
			sameSite: "lax",
		});
		expect(set).toHaveBeenCalledWith(
			"cookie_consent",
			"accepted",
			cookieAttributes,
		);
		expect(set).toHaveBeenCalledWith(
			"cookie_preferences",
			JSON.stringify({
				essential: true,
				analytics: true,
				marketing: true,
			}),
			cookieAttributes,
		);
		expect(set).toHaveBeenCalledWith(
			"fabric_analytics_consent",
			"granted",
			cookieAttributes,
		);
	});

	it("clamps optional categories off when recovering a declined decision", () => {
		// A tampered/hand-edited record must not let a "declined" state smuggle
		// analytics back on — ClientProviders gates on preferences.analytics.
		seedFallback({ state: "declined" });

		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		expect(
			screen.queryByRole(...BANNER_ROLE_QUERY),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("consent-probe")).toHaveTextContent(
			JSON.stringify({
				hasResponded: true,
				preferences: {
					essential: true,
					analytics: false,
					marketing: false,
				},
			}),
		);
	});

	it("ignores a corrupted fallback record", () => {
		window.localStorage.setItem(CONSENT_STORAGE_KEY, "{not json");

		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		expect(screen.getByRole(...BANNER_ROLE_QUERY)).toBeInTheDocument();
		expect(set).not.toHaveBeenCalled();
	});

	it("does not refresh the fallback's re-consent window on recovery", () => {
		seedFallback();
		const before = window.localStorage.getItem(CONSENT_STORAGE_KEY);

		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		expect(
			screen.queryByRole(...BANNER_ROLE_QUERY),
		).not.toBeInTheDocument();
		expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe(before);
	});

	it("ignores a fallback older than the re-consent window", () => {
		seedFallback({
			updatedAt: new Date(
				Date.now() - 366 * 24 * 60 * 60 * 1000,
			).toISOString(),
		});

		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		expect(screen.getByRole(...BANNER_ROLE_QUERY)).toBeInTheDocument();
		expect(set).not.toHaveBeenCalled();
	});

	it("keeps the GPC/DNT forced opt-out over a stored fallback decision", () => {
		Object.defineProperty(navigator, "doNotTrack", {
			value: "1",
			configurable: true,
		});

		try {
			seedFallback();

			render(
				<ConsentProvider>
					<ConsentProbe />
				</ConsentProvider>,
			);

			expect(
				screen.queryByRole(...BANNER_ROLE_QUERY),
			).not.toBeInTheDocument();
			expect(screen.getByTestId("consent-probe")).toHaveTextContent(
				JSON.stringify({
					hasResponded: true,
					preferences: {
						essential: true,
						analytics: false,
						marketing: false,
					},
				}),
			);
		} finally {
			Reflect.deleteProperty(navigator, "doNotTrack");
		}
	});
});

describe("consent hydration parity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.localStorage.clear();
	});

	afterEach(() => {
		Reflect.deleteProperty(navigator, "doNotTrack");
		set.mockReset();
	});

	// The server has no `navigator`, so it always renders the banner for a
	// visitor with no consent cookie. If the client consulted GPC/DNT during
	// render it would produce a different first render, and a hydration
	// mismatch React cannot recover from leaves the server markup in place
	// with no event handlers attached — a banner that hovers but never
	// responds to a click.
	it("matches the server's first render even when DNT is enabled", () => {
		Object.defineProperty(navigator, "doNotTrack", {
			value: "1",
			configurable: true,
		});
		const onFirstRender = vi.fn();

		render(
			<ConsentProvider>
				<FirstRenderProbe onFirstRender={onFirstRender} />
			</ConsentProvider>,
		);

		expect(onFirstRender).toHaveBeenCalledWith(false);
	});

	it("still honours DNT once effects have run", () => {
		Object.defineProperty(navigator, "doNotTrack", {
			value: "1",
			configurable: true,
		});

		render(
			<ConsentProvider>
				<ConsentProbe />
			</ConsentProvider>,
		);

		expect(
			screen.queryByRole(...BANNER_ROLE_QUERY),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("consent-probe")).toHaveTextContent(
			JSON.stringify({
				hasResponded: true,
				preferences: {
					essential: true,
					analytics: false,
					marketing: false,
				},
			}),
		);
	});
});
