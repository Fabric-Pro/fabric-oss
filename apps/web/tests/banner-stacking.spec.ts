/**
 * Shell notice region — browser geometry (Fizzy #2489).
 *
 * Every assertion here is a MEASUREMENT, never a class-token check. The unit
 * tests beside the components run in jsdom, which compiles no CSS: it does not
 * resolve `var()`, every `getBoundingClientRect()` is zeros, and `position`,
 * `z-index` and `overflow` have no effect at all. So the three things this
 * change is actually about — that the notice reserves its own height instead of
 * covering the page, that it never lands in another surface's rectangle, and
 * that it survives a scroll — can only be proven in a real browser.
 *
 * The repo's own learning
 * `docs/solutions/design-patterns/moving-a-floating-element-into-normal-flow.md`
 * records why: "the staging check measured geometry at scroll-top and on a
 * full-height route. Both are exactly the cases that do not exercise a
 * scroll-visibility bug. Clean numbers from the wrong position read as proof
 * and are not." So the suite measures at both sidebar widths, below the `md`
 * breakpoint, and at a scrolled position — not only at scroll-top.
 *
 * Overlap is computed clipping-aware. A naive `getBoundingClientRect().right`
 * check gives false positives once an `overflow-*` ancestor clips the content;
 * that trap is recorded in
 * `docs/solutions/ui-bugs/copilotkit-sidebar-editor-overlap.md`, and
 * `clippedRect` below applies every clipping ancestor (skipping the ones a
 * `fixed` element legitimately escapes) before intersecting anything.
 *
 * State control: the suite runs against one shared seeded account whose MFA
 * prompt state, AI provider configuration and onboarding progress come from the
 * server, so no scenario may depend on the state that account happens to be in.
 * Every gate is driven by `page.route` stubs, following the oRPC stubbing
 * pattern already used by `create-story-with-attachments.spec.ts` and its
 * siblings. Auth and org-slug resolution follow `omnipresent-launcher.spec.ts`
 * and `audit-log.spec.ts`.
 *
 * Run via `pnpm --filter web exec playwright test tests/banner-stacking.spec.ts`.
 */
import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Selectors — the shell surfaces this spec measures.
// ---------------------------------------------------------------------------

/** `AppWrapper`'s content column: the notice region and the page share it. */
const CONTENT_COLUMN = "#main-content > div";
/** `ShellNoticeStack`'s landmark (`app.shellNotices.ariaLabel`). */
const NOTICE_REGION = 'aside[aria-label="Account and setup notices"]';
/** The security notice's copy, from `settings.account.security.mfaPrompt.title`. */
const MFA_NOTICE_TITLE = "Protect your account with two-factor authentication";
/** The stale-build Backstop banner's copy, from `appUpdate.banner.title`. */
const BACKSTOP_BANNER_TITLE = "A new version of Fabric is available";
/** `NavBar`'s landmark — static and full-width below `md`, fixed above it. */
const MAIN_NAV = 'nav[aria-label="Main navigation"]';
/** The guided tour's coach-mark card, portaled to `body` at `zIndex: 200`. */
const TOUR_CARD = '[role="dialog"][aria-labelledby="onboarding-tour-title"]';
/** The AI-provider notice that gives the floating advisory dock its height. */
const AI_NOTICE = '[aria-label="AI setup reminder"]';
/**
 * The projects page's first content row. Used as "the page heading" because it
 * is the topmost in-flow thing the page itself renders, so it is exactly what
 * an in-flow notice above it displaces. Route-specific headings are not: most
 * `/app` pages open with this breadcrumb rather than an `h1`.
 */
const PAGE_HEADING = 'nav[aria-label="breadcrumb"]';
/** Marks the spacer this spec appends to make a short page scrollable. */
const SPACER_ATTRIBUTE = "data-banner-spec-spacer";

/** Sidebar widths drive `md:ml-[…]`, so every flow measurement runs at both. */
const SIDEBAR_STATES = [
	{ label: "expanded sidebar", collapsed: false },
	{ label: "collapsed sidebar", collapsed: true },
] as const;

const SIDEBAR_STORAGE_KEY = "fabric-sidebar-collapsed";

/** Sub-pixel slack: layout lands on fractional CSS pixels at some zooms. */
const EPSILON = 1;

// ---------------------------------------------------------------------------
// oRPC stubbing (mirrors create-story-with-attachments.spec.ts).
// ---------------------------------------------------------------------------

function orpcJsonResponse(payload: unknown): string {
	return JSON.stringify({ json: payload });
}

async function fulfillJson(route: Route, payload: unknown): Promise<void> {
	await route.fulfill({
		status: 200,
		contentType: "application/json",
		body: orpcJsonResponse(payload),
	});
}

/** `users.mfaPrompt.getState` — the one gate that decides the notice exists. */
const MFA_STATE_ROUTE = "**/api/rpc/users/mfaPrompt/getState**";
/** `users.onboarding.getState` — stubbed only to keep onboarding surfaces shut. */
const ONBOARDING_STATE_ROUTE = "**/api/rpc/users/onboarding/**";
/** `aiConfig.resolution.getStatus` — decides whether the advisory dock has height. */
const AI_CONFIG_ROUTE = "**/api/rpc/aiConfig/resolution/getStatus**";

/** A quiet onboarding state: nothing auto-launches over the geometry. */
const QUIET_ONBOARDING_STATE = {
	state: {
		version: 1,
		status: "completed",
		currentStepId: null,
		steps: {},
		autoLaunched: true,
		seenPages: {},
		pageToursOptedOut: true,
		functionTagsPromptOptOut: true,
		functionTagsPromptSeen: true,
		pointerDismissed: true,
		completedAt: "2026-01-01T00:00:00.000Z",
		dismissedAt: null,
	},
	eligibleForAutoLaunch: false,
	autoLaunchCohort: false,
	eligibleForFunctionTagsPrompt: false,
	eligibleForPointer: false,
};

/** An AI-config status whose only load-bearing field is `canResolveProvider`. */
function aiConfigStatus(canResolveProvider: boolean) {
	return {
		isConfigured: canResolveProvider,
		canResolveProvider,
		resolvedEmbeddingProvider: null,
		resolvedEmbeddingSource: null,
		hasUserConfig: false,
		hasOrgConfig: false,
		configuredProviders: [],
		defaultProvider: null,
		embeddingProvider: null,
		embeddingModel: null,
		message: canResolveProvider
			? "A provider is configured."
			: "No AI provider is configured.",
	};
}

type NoticeState = "visible" | "suppressed" | "stalled";

interface ShellStubOptions {
	/** Whether the security notice should be shown, hidden, or held pending. */
	notice: NoticeState;
	/** True mounts the AI-provider notice, giving the advisory dock height. */
	advisoryDock?: boolean;
	/** Sidebar width the shell should start at. */
	collapsed?: boolean;
}

interface ShellStubs {
	/** Releases a `stalled` MFA prompt-state response. */
	releaseNotice: () => void;
}

/**
 * Pin every input the shell notices read, so a scenario describes a state
 * rather than inheriting whatever the shared seeded account is in.
 *
 * The session and account-list responses are PATCHED rather than replaced: both
 * carry real identity the rest of the shell needs (organization resolution,
 * guest detection), and only two fields gate the security notice — whether a
 * second factor is already enrolled, and whether there is a password account to
 * enrol one on.
 */
async function stubShellState(
	page: Page,
	options: ShellStubOptions,
): Promise<ShellStubs> {
	let releaseNotice = () => {};
	const noticeGate = new Promise<void>((resolve) => {
		releaseNotice = resolve;
	});

	await page.addInitScript(
		({ key, collapsed }) => {
			try {
				window.localStorage.setItem(key, JSON.stringify(collapsed));
			} catch {
				// Storage unavailable — the shell falls back to expanded.
			}
		},
		{
			key: SIDEBAR_STORAGE_KEY,
			collapsed: options.collapsed ?? false,
		},
	);

	// A second factor already enrolled hides the notice outright, so the field
	// is pinned rather than trusted.
	await page.route("**/api/auth/get-session**", async (route) => {
		const response = await route.fetch();
		const body = (await response.json().catch(() => null)) as {
			user?: { twoFactorEnabled?: boolean };
		} | null;
		if (!body?.user) {
			await route.fulfill({ response });
			return;
		}
		body.user.twoFactorEnabled = false;
		await route.fulfill({
			status: response.status(),
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});

	// Only a password account can enrol a second factor, so the notice stays
	// silent for an SSO-only user. Guarantee one without discarding the rest.
	await page.route("**/api/auth/list-accounts**", async (route) => {
		// The page can close while this passthrough is in flight; a late
		// rejection here fails whichever test has already finished.
		const response = await route.fetch().catch(() => null);
		if (!response) {
			return;
		}
		const body = (await response.json().catch(() => null)) as
			| { providerId?: string }[]
			| null;
		const accounts = Array.isArray(body) ? body : [];
		if (!accounts.some((account) => account.providerId === "credential")) {
			accounts.push({
				id: "e2e-credential-account",
				accountId: "e2e-credential-account",
				providerId: "credential",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				scopes: [],
			} as Record<string, unknown>);
		}
		await route
			.fulfill({
				status: response.status(),
				contentType: "application/json",
				body: JSON.stringify(accounts),
			})
			.catch(() => undefined);
	});

	await page.route(ONBOARDING_STATE_ROUTE, (route) =>
		fulfillJson(route, QUIET_ONBOARDING_STATE),
	);

	// The advisory dock only has height while one of its notices is up, and the
	// AI-provider notice is the one a single field turns on.
	const canResolveProvider = options.advisoryDock !== true;
	await page.route(AI_CONFIG_ROUTE, (route) =>
		fulfillJson(route, aiConfigStatus(canResolveProvider)),
	);

	await page.route(MFA_STATE_ROUTE, async (route) => {
		if (options.notice === "suppressed") {
			await fulfillJson(route, { dismissed: true, snoozedUntil: null });
			return;
		}
		if (options.notice === "stalled") {
			// Held open on purpose: `useMfaNoticeVisible` reports false while
			// the query is pending, so the shell renders with no region and the
			// scenario can measure the displacement the response causes when it
			// finally lands.
			await noticeGate;
		}
		await fulfillJson(route, { dismissed: false, snoozedUntil: null });
	});

	return { releaseNotice };
}

// ---------------------------------------------------------------------------
// Navigation.
// ---------------------------------------------------------------------------

/**
 * Resolve the seeded user's organization slug from the post-login redirect.
 *
 * This FAILS rather than skipping when the account lands outside an
 * organization. `audit-log.spec.ts` skips here, and that is right for a spec
 * that is one proof among many — but this file is the only browser-level proof
 * that the shell notices stack correctly, and every scenario in it needs an
 * organization route. A shared skip would let the whole suite report green
 * having measured no geometry at all, hiding an environment misconfiguration
 * and a routing regression behind the same silence.
 */
async function resolveOrgSlug(page: Page): Promise<string> {
	await page.goto("/app");
	await page.waitForLoadState("domcontentloaded");
	const match = page.url().match(/\/app\/([^/?#]+)(?:[/?#]|$)/);
	const candidate = match?.[1];
	if (!candidate || candidate === "settings" || candidate === "admin") {
		throw new Error(
			`The seeded account did not land in an organization context (landed on ${page.url()}). ` +
				"Every scenario in this spec needs one, so this is a failure rather than a skip.",
		);
	}
	return candidate;
}

/** Open a shell route and wait until the content column and heading exist. */
async function openShellRoute(
	page: Page,
	path: string,
	options: { heading?: string } = {},
): Promise<void> {
	await page.goto(path);
	await page
		.locator(CONTENT_COLUMN)
		.first()
		.waitFor({ state: "attached", timeout: 30_000 });
	if (options.heading) {
		await expect(page.locator(options.heading).first()).toBeVisible({
			timeout: 30_000,
		});
	}
}

/**
 * Make the document taller than the viewport.
 *
 * The scroll scenarios must not depend on how much data the shared seeded
 * account happens to hold, and an empty projects list is shorter than the
 * viewport. The spacer is appended to the shell's content column, below
 * everything the shell renders, so it changes the document height and nothing
 * else; `readShellGeometry` excludes it when it identifies the page root.
 */
async function addScrollRoom(page: Page): Promise<void> {
	await page.evaluate(
		({ column, attribute }) => {
			const host = document.querySelector(column);
			if (!host) {
				throw new Error(`Shell content column ${column} not found`);
			}
			const spacer = document.createElement("div");
			spacer.setAttribute(attribute, "1");
			spacer.style.height = "2400px";
			spacer.style.flex = "none";
			host.appendChild(spacer);
		},
		{ column: CONTENT_COLUMN, attribute: SPACER_ATTRIBUTE },
	);
}

// ---------------------------------------------------------------------------
// Geometry.
// ---------------------------------------------------------------------------

interface Box {
	top: number;
	left: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

interface ShellGeometry {
	scrollY: number;
	viewport: { width: number; height: number };
	/** Border-box top of the shell's content column. */
	columnTop: number;
	/** The notice region, as painted (null when it renders nothing). */
	region: Box | null;
	/** The region's untruncated border box — compare with `region` for clipping. */
	regionRaw: Box | null;
	/** The security notice card itself. */
	notice: Box | null;
	/** Page heading (see `PAGE_HEADING`). */
	heading: Box | null;
	/** The page's own root element and the padding it opens with. */
	pageRootTop: number | null;
	pageRootPaddingTop: number | null;
	/** The floating AI advisory dock (the `fixed` child of the content column). */
	dock: Box | null;
	aiNotice: Box | null;
	/** The stale-build Backstop banner, when it is up. */
	backstop: Box | null;
	nav: Box | null;
	tourCard: Box | null;
	/** False when anything paints over the heading at its own probe points. */
	headingUncovered: boolean;
}

/**
 * Read every box this spec reasons about in one pass, from the browser.
 *
 * One evaluate rather than several so that all boxes come from a single layout
 * state — two round-trips could straddle a reflow and report an overlap that
 * never existed on screen, or miss one that did.
 */
async function readShellGeometry(page: Page): Promise<ShellGeometry> {
	return page.evaluate(
		({
			columnSelector,
			regionSelector,
			headingSelector,
			navSelector,
			tourSelector,
			aiSelector,
			spacerAttribute,
		}) => {
			function boxOf(rect: DOMRect): Box {
				return {
					top: rect.top,
					left: rect.left,
					right: rect.right,
					bottom: rect.bottom,
					width: rect.width,
					height: rect.height,
				};
			}

			/**
			 * Whether this ancestor becomes the containing block of a `fixed`
			 * descendant — the only case in which its overflow clips one.
			 */
			function anchorsFixedDescendants(style: CSSStyleDeclaration) {
				return (
					style.transform !== "none" ||
					style.perspective !== "none" ||
					style.filter !== "none" ||
					style.willChange.includes("transform") ||
					style.willChange.includes("filter") ||
					style.contain.includes("paint") ||
					style.contain.includes("layout") ||
					style.contain === "strict" ||
					style.contain === "content"
				);
			}

			/**
			 * The rect as PAINTED: every clipping ancestor applied, then the
			 * viewport. A naive `getBoundingClientRect()` reports the box the
			 * element would occupy unclipped, which reads as an overlap the
			 * user never sees once an `overflow-*` ancestor cuts it off — the
			 * false positive recorded in
			 * `docs/solutions/ui-bugs/copilotkit-sidebar-editor-overlap.md`.
			 */
			function clippedRect(element: Element): Box {
				const rect = element.getBoundingClientRect();
				let { top, left, right, bottom } = rect;
				let escapesOverflow =
					getComputedStyle(element).position === "fixed";
				let node = element.parentElement;
				while (node) {
					const style = getComputedStyle(node);
					const anchors = anchorsFixedDescendants(style);
					if (!escapesOverflow || anchors) {
						const clip = node.getBoundingClientRect();
						if (style.overflowX !== "visible") {
							left = Math.max(left, clip.left);
							right = Math.min(right, clip.right);
						}
						if (style.overflowY !== "visible") {
							top = Math.max(top, clip.top);
							bottom = Math.min(bottom, clip.bottom);
						}
						if (anchors) {
							escapesOverflow = false;
						}
					}
					node = node.parentElement;
				}
				left = Math.max(left, 0);
				top = Math.max(top, 0);
				right = Math.min(right, window.innerWidth);
				bottom = Math.min(bottom, window.innerHeight);
				return {
					top,
					left,
					right,
					bottom,
					width: Math.max(0, right - left),
					height: Math.max(0, bottom - top),
				};
			}

			/**
			 * Whether the element is the topmost paint at its own probe points.
			 *
			 * `elementFromPoint` ignores `pointer-events: none` layers, so this
			 * is necessary and not sufficient on its own; the callers pair it
			 * with a rectangle-intersection assertion.
			 */
			function isUncovered(element: Element): boolean {
				const rect = element.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) {
					return false;
				}
				const y = rect.top + rect.height / 2;
				const probes = [
					rect.left + 4,
					rect.left + rect.width / 2,
					rect.right - 4,
				];
				return probes.every((x) => {
					if (
						x < 0 ||
						y < 0 ||
						x > window.innerWidth ||
						y > window.innerHeight
					) {
						return true;
					}
					const hit = document.elementFromPoint(x, y);
					return (
						hit !== null &&
						(hit === element ||
							element.contains(hit) ||
							hit.contains(element))
					);
				});
			}

			const column = document.querySelector(columnSelector);
			if (!column) {
				throw new Error(
					`Shell content column ${columnSelector} not found`,
				);
			}

			const children = Array.from(column.children);
			const region = column.querySelector(`:scope > ${regionSelector}`);
			// The advisory dock is the column's only `fixed` child.
			const dock =
				children.find(
					(child) => getComputedStyle(child).position === "fixed",
				) ?? null;
			// The page's own root: the last in-flow child, ignoring this
			// spec's scroll spacer.
			const pageRoot =
				children
					.filter(
						(child) =>
							!child.hasAttribute(spacerAttribute) &&
							getComputedStyle(child).position !== "fixed",
					)
					.pop() ?? null;
			// The Backstop banner keeps its own `sticky` mount above the
			// region: an in-flow child that is neither the region nor the page.
			const backstop =
				children.find(
					(child) =>
						child !== region &&
						child !== pageRoot &&
						child !== dock &&
						child.querySelector('[role="alert"]') !== null,
				) ?? null;

			const heading = document.querySelector(headingSelector);
			const notice = region?.firstElementChild ?? null;
			const nav = document.querySelector(navSelector);
			const tourCard = document.querySelector(tourSelector);
			const aiNotice = document.querySelector(aiSelector);

			return {
				scrollY: window.scrollY,
				viewport: {
					width: window.innerWidth,
					height: window.innerHeight,
				},
				columnTop: column.getBoundingClientRect().top,
				region: region ? clippedRect(region) : null,
				regionRaw: region
					? boxOf(region.getBoundingClientRect())
					: null,
				notice: notice ? clippedRect(notice) : null,
				heading: heading ? clippedRect(heading) : null,
				pageRootTop: pageRoot
					? pageRoot.getBoundingClientRect().top
					: null,
				pageRootPaddingTop: pageRoot
					? Number.parseFloat(getComputedStyle(pageRoot).paddingTop)
					: null,
				dock: dock ? clippedRect(dock) : null,
				aiNotice: aiNotice ? clippedRect(aiNotice) : null,
				backstop: backstop ? clippedRect(backstop) : null,
				nav: nav ? clippedRect(nav) : null,
				tourCard: tourCard ? clippedRect(tourCard) : null,
				headingUncovered: heading ? isUncovered(heading) : false,
			} satisfies ShellGeometry;
		},
		{
			columnSelector: CONTENT_COLUMN,
			regionSelector: NOTICE_REGION,
			headingSelector: PAGE_HEADING,
			navSelector: MAIN_NAV,
			tourSelector: TOUR_CARD,
			aiSelector: AI_NOTICE,
			spacerAttribute: SPACER_ATTRIBUTE,
		},
	);
}

/** Overlapping area of two painted boxes, in CSS pixels squared. */
function intersectionArea(a: Box, b: Box): number {
	const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
	const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	if (width <= 0 || height <= 0) {
		return 0;
	}
	return width * height;
}

/** Wait until the heading stops moving, so a measurement is not mid-reflow. */
async function waitForSettledHeading(page: Page): Promise<number> {
	let previous = Number.NaN;
	await expect
		.poll(
			async () => {
				const { heading } = await readShellGeometry(page);
				const top = heading?.top ?? Number.NaN;
				const settled = Number.isFinite(top) && top === previous;
				previous = top;
				return settled;
			},
			{ timeout: 15_000, intervals: [150, 150, 250, 250, 500] },
		)
		.toBe(true);
	return previous;
}

function requireBox(box: Box | null, name: string): Box {
	if (!box) {
		throw new Error(`Expected ${name} to be present, but it was not`);
	}
	return box;
}

// ---------------------------------------------------------------------------
// Flow and displacement — measured at both sidebar widths.
// ---------------------------------------------------------------------------

for (const sidebar of SIDEBAR_STATES) {
	test.describe(`Shell notice region — flow (${sidebar.label})`, () => {
		test("with no notice the region is absent and the page opens at the top of the shell column", async ({
			page,
		}) => {
			await stubShellState(page, {
				notice: "suppressed",
				collapsed: sidebar.collapsed,
			});
			const slug = await resolveOrgSlug(page);
			await openShellRoute(page, `/app/${slug}/projects`, {
				heading: PAGE_HEADING,
			});
			await waitForSettledHeading(page);

			await expect(page.locator(NOTICE_REGION)).toHaveCount(0);

			const geometry = await readShellGeometry(page);
			const heading = requireBox(geometry.heading, "page heading");
			const pageRootTop = geometry.pageRootTop;
			const padding = geometry.pageRootPaddingTop;
			expect(pageRootTop).not.toBeNull();
			expect(padding).not.toBeNull();

			// The no-banner baseline, stated intrinsically: the page's own root
			// starts exactly at the top of the shell column, and the heading
			// starts exactly at that root's own padding. Nothing has reserved
			// height above it.
			expect(
				Math.abs((pageRootTop ?? 0) - geometry.columnTop),
			).toBeLessThanOrEqual(EPSILON);
			expect(
				Math.abs(heading.top - ((pageRootTop ?? 0) + (padding ?? 0))),
			).toBeLessThanOrEqual(EPSILON);
			expect(geometry.headingUncovered).toBe(true);
		});

		test("one notice pushes the page heading down by exactly the region's height and covers nothing", async ({
			page,
		}) => {
			// Baseline first, in the same browser and viewport, so the two
			// numbers differ by the notice and by nothing else.
			await stubShellState(page, {
				notice: "suppressed",
				collapsed: sidebar.collapsed,
			});
			const slug = await resolveOrgSlug(page);
			const projectsPath = `/app/${slug}/projects`;
			await openShellRoute(page, projectsPath, { heading: PAGE_HEADING });
			await waitForSettledHeading(page);
			const baseline = await readShellGeometry(page);
			const baselineHeading = requireBox(
				baseline.heading,
				"page heading (no notice)",
			);
			const baselineOffset = baselineHeading.top - baseline.columnTop;

			// Now the same page with the notice shown.
			await page.unroute(MFA_STATE_ROUTE);
			await page.route(MFA_STATE_ROUTE, (route) =>
				fulfillJson(route, { dismissed: false, snoozedUntil: null }),
			);
			await openShellRoute(page, projectsPath, { heading: PAGE_HEADING });
			await expect(page.getByText(MFA_NOTICE_TITLE)).toBeVisible({
				timeout: 15_000,
			});
			await waitForSettledHeading(page);

			const shifted = await readShellGeometry(page);
			const region = requireBox(shifted.region, "notice region");
			const heading = requireBox(
				shifted.heading,
				"page heading (with notice)",
			);
			const shiftedOffset = heading.top - shifted.columnTop;

			expect(region.height).toBeGreaterThan(0);
			// Reserved, not overlaid: the displacement IS the region's height.
			expect(
				Math.abs(shiftedOffset - baselineOffset - region.height),
			).toBeLessThanOrEqual(EPSILON);
			// And it sits above the heading rather than on it.
			expect(intersectionArea(region, heading)).toBe(0);
			expect(shifted.headingUncovered).toBe(true);
		});

		test("a late-arriving notice displaces the page heading exactly once", async ({
			page,
		}) => {
			// The mechanism an old `AppWrapper` comment asserted without
			// measuring: an in-flow notice that "arrives late". Measured here
			// rather than argued about.
			const { releaseNotice } = await stubShellState(page, {
				notice: "stalled",
				collapsed: sidebar.collapsed,
			});
			const slug = await resolveOrgSlug(page);
			await openShellRoute(page, `/app/${slug}/projects`, {
				heading: PAGE_HEADING,
			});
			await waitForSettledHeading(page);

			const before = await readShellGeometry(page);
			expect(before.region).toBeNull();
			const headingBefore = requireBox(
				before.heading,
				"page heading (notice pending)",
			);

			releaseNotice();
			await expect(page.getByText(MFA_NOTICE_TITLE)).toBeVisible({
				timeout: 15_000,
			});
			await waitForSettledHeading(page);

			const after = await readShellGeometry(page);
			const region = requireBox(after.region, "notice region");
			const headingAfter = requireBox(
				after.heading,
				"page heading (notice arrived)",
			);

			const moved =
				headingAfter.top -
				after.columnTop -
				(headingBefore.top - before.columnTop);
			expect(Math.abs(moved - region.height)).toBeLessThanOrEqual(
				EPSILON,
			);
			expect(intersectionArea(region, headingAfter)).toBe(0);
			expect(after.headingUncovered).toBe(true);

			// Exactly once: a second settle must not move it again.
			const settledTop = await waitForSettledHeading(page);
			expect(Math.abs(settledTop - headingAfter.top)).toBeLessThanOrEqual(
				EPSILON,
			);
		});

		test("the region never intersects the AI advisory dock, at scroll-top or scrolled", async ({
			page,
		}) => {
			await stubShellState(page, {
				notice: "visible",
				advisoryDock: true,
				collapsed: sidebar.collapsed,
			});
			const slug = await resolveOrgSlug(page);
			await openShellRoute(page, `/app/${slug}/projects`, {
				heading: PAGE_HEADING,
			});
			await expect(page.getByText(MFA_NOTICE_TITLE)).toBeVisible({
				timeout: 15_000,
			});
			await expect(page.locator(AI_NOTICE)).toBeVisible({
				timeout: 15_000,
			});
			await addScrollRoom(page);
			await waitForSettledHeading(page);

			const atTop = await readShellGeometry(page);
			const regionAtTop = requireBox(atTop.region, "notice region");
			const dockAtTop = requireBox(atTop.dock, "AI advisory dock");
			const aiAtTop = requireBox(atTop.aiNotice, "AI provider notice");
			expect(intersectionArea(regionAtTop, dockAtTop)).toBe(0);
			expect(intersectionArea(regionAtTop, aiAtTop)).toBe(0);

			// Again from a scrolled position: the dock is viewport-fixed and
			// the region is not, so their relationship is only meaningful once
			// the two have moved relative to each other.
			await page.evaluate(() => window.scrollTo(0, 600));
			await waitForSettledHeading(page);
			const scrolled = await readShellGeometry(page);
			expect(scrolled.scrollY).toBeGreaterThan(0);
			const dockScrolled = requireBox(
				scrolled.dock,
				"AI advisory dock (scrolled)",
			);
			const aiScrolled = requireBox(
				scrolled.aiNotice,
				"AI provider notice (scrolled)",
			);
			if (scrolled.region) {
				expect(intersectionArea(scrolled.region, dockScrolled)).toBe(0);
				expect(intersectionArea(scrolled.region, aiScrolled)).toBe(0);
			}
		});

		test("the notice survives scrolling away and back, unclipped", async ({
			page,
		}) => {
			await stubShellState(page, {
				notice: "visible",
				collapsed: sidebar.collapsed,
			});
			const slug = await resolveOrgSlug(page);
			await openShellRoute(page, `/app/${slug}/projects`, {
				heading: PAGE_HEADING,
			});
			await expect(page.getByText(MFA_NOTICE_TITLE)).toBeVisible({
				timeout: 15_000,
			});
			await addScrollRoom(page);
			await waitForSettledHeading(page);

			const before = await readShellGeometry(page);
			const regionBefore = requireBox(before.region, "notice region");

			// Past the notice entirely, then back.
			await page.evaluate((height) => {
				window.scrollTo(0, height + 400);
			}, regionBefore.height);
			await expect
				.poll(async () => (await readShellGeometry(page)).scrollY)
				.toBeGreaterThan(0);
			const away = await readShellGeometry(page);
			// In flow, so it scrolls out of view — that is the contract, and
			// the assertion records it rather than assuming it.
			expect(away.region?.height ?? 0).toBeLessThan(regionBefore.height);

			await page.evaluate(() => window.scrollTo(0, 0));
			await expect
				.poll(async () => (await readShellGeometry(page)).scrollY)
				.toBe(0);
			await waitForSettledHeading(page);

			const back = await readShellGeometry(page);
			const regionBack = requireBox(back.region, "notice region (back)");
			const regionRaw = requireBox(
				back.regionRaw,
				"notice region border box",
			);
			await expect(page.getByText(MFA_NOTICE_TITLE)).toBeVisible();
			expect(regionBack.height).toBeGreaterThan(0);
			// Unclipped: what is painted equals the full border box.
			expect(
				Math.abs(regionBack.height - regionRaw.height),
			).toBeLessThanOrEqual(EPSILON);
			expect(
				Math.abs(regionBack.width - regionRaw.width),
			).toBeLessThanOrEqual(EPSILON);
			expect(
				Math.abs(regionBack.height - regionBefore.height),
			).toBeLessThanOrEqual(EPSILON);
		});
	});
}

// ---------------------------------------------------------------------------
// Stacking against the rest of the app chrome.
// ---------------------------------------------------------------------------

/**
 * Release every route handler before the context tears down. A passthrough
 * stub still fetching when the page closes rejects into whichever test has
 * already finished, which reads as a failure in an unrelated scenario.
 */
test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
});

test.describe("Shell notice region — stacking", () => {
	test("the Backstop banner sits above the region", async ({ page }) => {
		// `isVersionCheckEnabled()` gates the watcher on BOTH a real build
		// version AND `NODE_ENV === "production"`. Reading `/api/version` covers
		// only the first half — a dev server reports a real SHA while the
		// watcher stays inert, which is exactly how this test failed on its
		// first real run. So probe the mechanism rather than infer it: a live
		// watcher polls `/api/version` on an interval, an inert one never does.
		let versionPolls = 0;

		await page.clock.install();
		await stubShellState(page, { notice: "visible" });
		await page.route("**/api/version**", (route) => {
			versionPolls += 1;
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ version: "e2e-newer-build" }),
			});
		});

		const slug = await resolveOrgSlug(page);
		await openShellRoute(page, `/app/${slug}/projects`, {
			heading: PAGE_HEADING,
		});
		await expect(page.getByText(MFA_NOTICE_TITLE)).toBeVisible({
			timeout: 15_000,
		});

		// One poll interval separates a live watcher from an inert one.
		await page.clock.runFor("01:05");
		test.skip(
			versionPolls === 0,
			"The stale-build watcher is inert in this build (it needs a production bundle), so the Backstop banner can never appear.",
		);

		// The Backstop banner only appears after `STALE_BANNER_AFTER_MS`
		// (10 minutes) on a stale build with no reload seam, so the clock is
		// driven rather than waited on.
		await page.clock.runFor("10:05");
		await expect(page.getByText(BACKSTOP_BANNER_TITLE)).toBeVisible({
			timeout: 15_000,
		});

		const geometry = await readShellGeometry(page);
		const region = requireBox(geometry.region, "notice region");
		const backstop = requireBox(geometry.backstop, "Backstop banner");

		// Above, and not merely earlier in the markup.
		expect(backstop.top).toBeLessThan(region.top);
		expect(backstop.bottom).toBeLessThanOrEqual(region.top + EPSILON);
		expect(intersectionArea(backstop, region)).toBe(0);
	});

	test("a guided tour card near the viewport top does not intersect any notice", async ({
		page,
	}) => {
		await stubShellState(page, { notice: "visible", advisoryDock: true });
		const slug = await resolveOrgSlug(page);
		await openShellRoute(page, `/app/${slug}/projects`, {
			heading: PAGE_HEADING,
		});
		await expect(page.getByText(MFA_NOTICE_TITLE)).toBeVisible({
			timeout: 15_000,
		});
		await waitForSettledHeading(page);

		// Spotlight a sidebar item near the top of the viewport, which is
		// where the coach-mark card lands with `side: "bottom"`. The event is
		// the same wire the readiness checklist uses
		// (`GET_STARTED_SPOTLIGHT_EVENT` in `get-started/lib/tour-steps.ts`).
		await page.evaluate(() => {
			window.dispatchEvent(
				new CustomEvent("get-started:spotlight", {
					detail: {
						anchorId: "nav-projects",
						title: "Projects",
						body: "Where your work lives.",
					},
				}),
			);
		});

		await expect(page.locator(TOUR_CARD)).toBeVisible({ timeout: 15_000 });
		const geometry = await readShellGeometry(page);
		const card = requireBox(geometry.tourCard, "guided tour card");
		const region = requireBox(geometry.region, "notice region");
		const notice = requireBox(geometry.notice, "security notice");

		expect(card.top).toBeLessThan(geometry.viewport.height / 2);
		expect(intersectionArea(card, region)).toBe(0);
		expect(intersectionArea(card, notice)).toBe(0);
		if (geometry.aiNotice) {
			expect(intersectionArea(card, geometry.aiNotice)).toBe(0);
		}
	});

	test("the region renders nothing on a full-bleed route", async ({
		page,
	}) => {
		await stubShellState(page, { notice: "visible" });
		const slug = await resolveOrgSlug(page);
		// Positive control first: the same stubs DO produce a region on an
		// ordinary route, so the absence asserted below cannot be a stub that
		// silently failed to apply.
		await openShellRoute(page, `/app/${slug}/projects`, {
			heading: PAGE_HEADING,
		});
		await expect(page.locator(NOTICE_REGION)).toHaveCount(1);
		await expect(page.getByText(MFA_NOTICE_TITLE)).toBeVisible({
			timeout: 15_000,
		});

		// `isFullBleedRoute` covers the task planner, which paints its own
		// `fixed inset-y-0` chrome over the whole viewport.
		await openShellRoute(page, `/app/${slug}/agents/task-planner`);
		await expect(page.locator("#main-content")).toBeAttached();
		await expect(page.locator(NOTICE_REGION)).toHaveCount(0);
		await expect(page.getByText(MFA_NOTICE_TITLE)).toHaveCount(0);
	});
});

// ---------------------------------------------------------------------------
// Below the md breakpoint, where NavBar is static and full-width.
// ---------------------------------------------------------------------------

test.describe("Shell notice region — below 768px", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the notice does not intersect the navigation", async ({ page }) => {
		await stubShellState(page, { notice: "visible" });
		const slug = await resolveOrgSlug(page);
		await openShellRoute(page, `/app/${slug}/projects`, {
			heading: PAGE_HEADING,
		});
		await expect(page.getByText(MFA_NOTICE_TITLE)).toBeVisible({
			timeout: 15_000,
		});
		await waitForSettledHeading(page);

		const geometry = await readShellGeometry(page);
		expect(geometry.viewport.width).toBeLessThan(768);
		const notice = requireBox(geometry.notice, "security notice");
		const region = requireBox(geometry.region, "notice region");
		const nav = requireBox(geometry.nav, "main navigation");

		// The live bug this replaces: a `fixed top-4 right-4 left-4 z-50`
		// banner at EVERY width, over a navigation that is static `w-full`
		// below `md`.
		expect(intersectionArea(notice, nav)).toBe(0);
		expect(intersectionArea(region, nav)).toBe(0);
		expect(notice.top).toBeGreaterThanOrEqual(nav.bottom - EPSILON);
		expect(geometry.headingUncovered).toBe(true);
	});
});
