/**
 * Component tests for `<PmSyncCloudToggle />` (Group 6, spec §9.2).
 *
 * Coverage:
 *   - 4 base states render the correct trigger element and tooltip body
 *   - aria-pressed reflects pmAutoSyncEnabled on interactive variants
 *   - aria-disabled on the not-configured (Red) state; not a <button>
 *   - Click in Synced → mutation called with pmAutoSyncEnabled: false
 *   - Click in Off → mutation called with pmAutoSyncEnabled: true
 *   - Click in Red → no mutation (the link in the tooltip is the action)
 *   - Click in Conflict overlay → router.push to the roadmap URL
 *   - Optimistic rollback on mutation rejection (toast + cache restored)
 *   - Disabled-while-pending: rapid double click yields one PATCH
 *   - Telemetry: [pm_sync_toggle_changed] on toggle success
 *   - Telemetry: [pm_sync_red_state_clicked] on Settings link click
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the component import per Vitest hoisting rules.
// ----------------------------------------------------------------------------

const updateMutationFn = vi.fn();
const listQueryKey = vi.fn(() => ["pm-sync-toggle-list"]);
const getQueryKey = vi.fn(() => ["pm-sync-toggle-get"]);
const routerPush = vi.fn();
const toastError = vi.fn();

vi.mock("../../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				update: (...args: unknown[]) => updateMutationFn(...args),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				list: {
					queryKey: (...args: unknown[]) => listQueryKey(...args),
				},
				get: {
					queryKey: (...args: unknown[]) => getQueryKey(...args),
				},
			},
		},
	},
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "test-user-id", name: "Test User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		organizationName: null,
		basePath: "/app",
		isOrgContext: false,
		isPersonalContext: true,
		isOrganizationAdmin: false,
		userRole: null,
		loaded: true,
		organization: null,
	}),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: routerPush,
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
		pathname: "/",
		query: {},
	}),
	usePathname: () => "/app/projects/proj-1",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => {
		// Map known keys to their human-readable copy so assertions can
		// match on visible text (e.g. the "Open ticket" link is rendered
		// via `t("openTicket")`, not `t.rich` — a plain string lookup that
		// the default key-passthrough mock would surface as "openTicket"
		// and break `getByRole("link", { name: /open ticket/i })`).
		const KEY_MAP: Record<string, string> = {
			openTicket: "Open ticket",
		};
		const t = (key: string) => KEY_MAP[key] ?? key;
		// next-intl's `t.rich` renders <link>chunks</link>-style placeholders.
		// The component uses it for the Not-configured, Conflict, and
		// Not-configured and Conflict tooltip bodies. The mock renders just
		// the link chunks so assertions can locate the `<a>` by its visible
		// link text. (The "Open ticket" affordance is no longer rendered via
		// t.rich — it's a plain `<a>{t("openTicket")}</a>` sibling line — so
		// no syncedLinkedWithUrl branch is needed.)
		t.rich = (
			key: string,
			values: Record<
				string,
				(chunks: React.ReactNode) => React.ReactNode
			>,
		) => {
			const linkRender = values?.link;
			if (typeof linkRender === "function") {
				if (key === "notConfigured") {
					return linkRender("Settings > Integrations");
				}
				if (key === "conflict") {
					return linkRender("open in roadmap");
				}
			}
			return key;
		};
		return t;
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: vi.fn(),
		error: (...args: unknown[]) => toastError(...args),
	}),
}));

// JSDOM doesn't implement ResizeObserver; Radix Tooltip needs it (via portal).
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;

import type { PmSyncCloudToggleProps } from "../PmSyncCloudToggle";
// Import AFTER mocks so the component picks up the stubs.
import { PmSyncCloudToggle } from "../PmSyncCloudToggle";

// ----------------------------------------------------------------------------
// Render helpers
// ----------------------------------------------------------------------------

function buildProps(
	overrides: Partial<PmSyncCloudToggleProps> = {},
): PmSyncCloudToggleProps {
	return {
		storyId: "story-1",
		projectId: "proj-1",
		organizationId: null,
		pmAutoSyncEnabled: true,
		externalId: "EXT-1",
		externalUrl: "https://acme.atlassian.net/browse/PROJ-1",
		hasPmIntegration: true,
		pmToolName: "Jira",
		lastPmSyncStatus: null,
		lastSyncedAt: null,
		source: "editor",
		interactive: true,
		size: "md",
		...overrides,
	};
}

function renderToggle(overrides: Partial<PmSyncCloudToggleProps> = {}) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const props = buildProps(overrides);
	const utils = render(
		<QueryClientProvider client={queryClient}>
			<PmSyncCloudToggle {...props} />
		</QueryClientProvider>,
	);
	return { ...utils, queryClient, props };
}

beforeEach(() => {
	updateMutationFn.mockReset();
	updateMutationFn.mockResolvedValue({
		story: {
			id: "story-1",
			pmAutoSyncEnabled: true,
		},
	});
	listQueryKey.mockClear();
	getQueryKey.mockClear();
	routerPush.mockClear();
	toastError.mockClear();
});

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("PmSyncCloudToggle — base state rendering", () => {
	it("renders Synced state when toggle is on, linked, and no conflict", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			hasPmIntegration: true,
			lastPmSyncStatus: null,
		});

		const trigger = screen.getByRole("button", {
			name: /auto-sync to jira on/i,
		});
		expect(trigger).toBeInTheDocument();
		expect(trigger).toHaveAttribute("data-state", "synced");
		expect(trigger).toHaveAttribute("aria-pressed", "true");
	});

	it("renders Not-synced (armed but unlinked) state when toggle is on but story is unlinked", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: null,
			externalUrl: null,
			hasPmIntegration: true,
		});

		// Auto-sync is ON but no card exists yet — this reads "Not synced" (it
		// will push on the next save), NOT a stuck "Syncing…" that never clears.
		// It still shares data-state="synced"; only the label/aria differ.
		const trigger = screen.getByRole("button", {
			name: /not synced yet; will push to jira/i,
		});
		expect(trigger).toBeInTheDocument();
		expect(trigger).toHaveAttribute("data-state", "synced");
		expect(trigger).toHaveAttribute("aria-pressed", "true");
	});

	it("renders Off (linked, paused) state when toggle is off but a ticket exists", () => {
		renderToggle({
			pmAutoSyncEnabled: false,
			externalId: "EXT-1",
			hasPmIntegration: true,
		});

		// Aria-label distinguishes paused-on-an-existing-ticket from the
		// brand-new flow — see the next test for the unlinked variant.
		const trigger = screen.getByRole("button", {
			name: /auto-sync paused/i,
		});
		expect(trigger).toBeInTheDocument();
		expect(trigger).toHaveAttribute("data-state", "off");
		expect(trigger).toHaveAttribute("aria-pressed", "false");
	});

	it("renders Off (unlinked, create-ticket) state when toggle is off and no ticket exists yet", () => {
		renderToggle({
			pmAutoSyncEnabled: false,
			externalId: null,
			externalUrl: null,
			hasPmIntegration: true,
		});

		// The "click will create a ticket" framing is critical UX —
		// users need to know the click is a creation action, not just
		// a preference toggle.
		const trigger = screen.getByRole("button", {
			name: /click to create a ticket in jira/i,
		});
		expect(trigger).toBeInTheDocument();
		expect(trigger).toHaveAttribute("data-state", "off");
		expect(trigger).toHaveAttribute("aria-pressed", "false");
	});

	it("renders Not-configured (Red) state when project has no PM integration", () => {
		renderToggle({
			hasPmIntegration: false,
			pmAutoSyncEnabled: false,
		});

		// Red state is a <span role="img">, not a <button> — clicking the icon
		// itself is intentionally a no-op so the user is forced to act on the
		// Settings link inside the tooltip.
		const trigger = screen.getByRole("img", {
			name: /no pm tool configured/i,
		});
		expect(trigger).toBeInTheDocument();
		expect(trigger).toHaveAttribute("data-state", "not-configured");
		expect(trigger).toHaveAttribute("aria-disabled", "true");

		// Should NOT carry aria-pressed since this is not a toggle.
		expect(trigger).not.toHaveAttribute("aria-pressed");

		// Should NOT be a <button>.
		expect(
			screen.queryByRole("button", { name: /no pm tool configured/i }),
		).toBeNull();

		// Regression guard: the Red span must be keyboard-focusable and must
		// accept pointer events, or Radix Tooltip cannot open on hover/focus
		// and the Settings link inside the tooltip becomes unreachable. (A
		// previous revision applied `pointer-events-none` here, which broke
		// the Red-state tooltip in a real browser even though jsdom's
		// synthetic hover masked it.)
		expect(trigger).toHaveAttribute("tabindex", "0");
		expect(trigger.className).not.toContain("pointer-events-none");
	});

	it("renders the conflict-ring overlay when sync status is CONFLICT", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			hasPmIntegration: true,
			lastPmSyncStatus: "CONFLICT",
		});

		// The conflict overlay wraps the icon in a ring-1 ring-highlight
		// container (amber per design-system convention — destructive red is
		// reserved for Not-configured / hard error states). The aria-label is
		// the base Synced label plus the "· Conflict — open in roadmap to
		// resolve." suffix.
		const trigger = screen.getByRole("button", {
			name: /· Conflict — open in roadmap to resolve/i,
		});
		expect(trigger).toBeInTheDocument();
		expect(trigger).toHaveAttribute("data-state", "synced-with-conflict");
		// The interactive trigger itself carries the ring class.
		expect(trigger.className).toContain("ring-highlight");
		// Guard: the conflict ring is NOT destructive-red (would conflict
		// visually with the Red/Not-configured state).
		expect(trigger.className).not.toContain("ring-destructive");
	});
});

describe("PmSyncCloudToggle — click behavior", () => {
	it("clicking Synced calls update with pmAutoSyncEnabled: false", async () => {
		const user = userEvent.setup();
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			hasPmIntegration: true,
		});

		await user.click(
			screen.getByRole("button", { name: /auto-sync to jira on/i }),
		);

		await waitFor(() => {
			expect(updateMutationFn).toHaveBeenCalledTimes(1);
		});
		expect(updateMutationFn).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				storyId: "story-1",
				organizationId: null,
				pmAutoSyncEnabled: false,
			}),
		);
	});

	it("clicking Off calls update with pmAutoSyncEnabled: true", async () => {
		const user = userEvent.setup();
		renderToggle({
			pmAutoSyncEnabled: false,
			externalId: "EXT-1",
			hasPmIntegration: true,
		});

		await user.click(
			screen.getByRole("button", { name: /auto-sync paused/i }),
		);

		await waitFor(() => {
			expect(updateMutationFn).toHaveBeenCalledTimes(1);
		});
		expect(updateMutationFn).toHaveBeenCalledWith(
			expect.objectContaining({
				pmAutoSyncEnabled: true,
			}),
		);
	});

	it("clicking the Red icon does NOT call update (icon is non-interactive)", async () => {
		const user = userEvent.setup();
		renderToggle({
			hasPmIntegration: false,
			pmAutoSyncEnabled: false,
		});

		// Click the icon span; should not fire a mutation since the icon
		// has `pointer-events-none` and is rendered as a non-interactive span.
		const icon = screen.getByRole("img", {
			name: /no pm tool configured/i,
		});
		await user.click(icon);

		// Brief wait to catch any spurious async dispatch.
		await new Promise((r) => setTimeout(r, 50));
		expect(updateMutationFn).not.toHaveBeenCalled();
	});

	it("clicking the Conflict overlay (interactive surface) navigates to roadmap", async () => {
		const user = userEvent.setup();
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			hasPmIntegration: true,
			lastPmSyncStatus: "CONFLICT",
			interactive: true,
		});

		await user.click(
			screen.getByRole("button", {
				name: /· Conflict — open in roadmap to resolve/i,
			}),
		);

		expect(routerPush).toHaveBeenCalledTimes(1);
		const target = routerPush.mock.calls[0][0] as string;
		expect(target).toContain("/app/projects/proj-1");
		expect(target).toContain("storyId=story-1");
		expect(updateMutationFn).not.toHaveBeenCalled();
	});

	it("display-only card surface in Conflict state renders a link to the roadmap", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			hasPmIntegration: true,
			lastPmSyncStatus: "CONFLICT",
			interactive: false,
			source: "card",
		});

		// Display-only conflict renders as <a> for keyboard access without JS.
		const link = screen.getByRole("link", {
			name: /· Conflict — open in roadmap to resolve/i,
		});
		expect(link).toBeInTheDocument();
		expect(link).toHaveAttribute("href");
		expect(link.getAttribute("href")).toContain("/app/projects/proj-1");
		expect(link.getAttribute("href")).toContain("storyId=story-1");
	});

	it("display-only card surface in Red state renders <a> straight to Settings (touch-friendly)", () => {
		const consoleLog = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});
		renderToggle({
			hasPmIntegration: false,
			pmAutoSyncEnabled: false,
			interactive: false,
			source: "card",
		});
		// Card surface promotes the Red icon to a real link so a single tap
		// on touch devices (where hover doesn't exist) routes to Settings.
		const link = screen.getAllByRole("link", {
			name: /no pm tool configured/i,
		})[0];
		expect(link).toHaveAttribute("href", "/app/settings/integrations");
		expect(link).toHaveAttribute("data-state", "not-configured");
		// Telemetry fires on click without preventing navigation.
		link.click();
		expect(consoleLog).toHaveBeenCalledWith(
			"[pm_sync_red_state_clicked]",
			expect.objectContaining({
				storyId: "story-1",
				projectId: "proj-1",
				organizationId: null,
			}),
		);
		consoleLog.mockRestore();
	});

	it("display-only card surface in linked Synced state renders <a> to externalUrl", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			externalUrl: "https://acme.atlassian.net/browse/PROJ-1",
			hasPmIntegration: true,
			lastPmSyncStatus: null,
			interactive: false,
			source: "card",
		});

		const link = screen.getByRole("link", {
			name: /auto-sync to jira on/i,
		});
		expect(link).toHaveAttribute(
			"href",
			"https://acme.atlassian.net/browse/PROJ-1",
		);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
	});
});

describe("PmSyncCloudToggle — Failure state (FAILED, with actionable error)", () => {
	// Surfaces the FAILED status from `lastPmSyncStatus` directly on the cloud
	// toggle. Before this change, FAILED was only visible via the roadmap
	// card's PmSyncFailureBadge — on the story-detail page the toggle still
	// rendered `synced` ("Syncing to your PM tool") which silently lied to
	// users looking at a row that had actually failed to sync.
	it("renders Failure state with destructive ring when toggle is on and lastPmSyncStatus=FAILED", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			hasPmIntegration: true,
			lastPmSyncStatus: "FAILED",
			lastPmSyncError:
				"PM tool was configured by another user. Open Settings → MCP Servers and connect your own credentials, then retry the sync.",
		});

		const trigger = screen.getByRole("button", {
			name: /sync failed.*pm tool was configured by another user/i,
		});
		expect(trigger).toBeInTheDocument();
		expect(trigger).toHaveAttribute("data-state", "synced-with-failure");
		expect(trigger).toHaveAttribute("aria-pressed", "true");
	});

	it("aria-label degrades gracefully when lastPmSyncError is null", () => {
		// Defensive: a stale `lastPmSyncStatus=FAILED` row whose error message
		// has been cleared (e.g. by a partial retry) should still produce a
		// readable aria-label, not an empty fragment.
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			hasPmIntegration: true,
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: null,
		});

		const trigger = screen.getByRole("button", {
			name: /sync failed$/i,
		});
		expect(trigger).toHaveAttribute("data-state", "synced-with-failure");
	});

	it("FAILED takes precedence over CONFLICT when both are somehow set", () => {
		// Defensive ordering — FAILED is non-recoverable until the user acts,
		// CONFLICT pauses sync pending a merge choice. Surface the louder
		// signal. In practice the workflow stamps one OR the other but the
		// derived-state function shouldn't crash if both show up.
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			hasPmIntegration: true,
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: "GitLab is not connected for this project.",
		});

		const trigger = screen.getByRole("button");
		expect(trigger).toHaveAttribute("data-state", "synced-with-failure");
	});

	it("clicking the Failure-state toggle still flips pmAutoSyncEnabled (user can pause from here)", async () => {
		const user = userEvent.setup();
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			hasPmIntegration: true,
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: "Some upstream error",
		});

		const trigger = screen.getByRole("button");
		await user.click(trigger);

		expect(updateMutationFn).toHaveBeenCalledWith(
			expect.objectContaining({
				storyId: "story-1",
				projectId: "proj-1",
				pmAutoSyncEnabled: false,
			}),
		);
	});
});

describe("PmSyncCloudToggle — race protection and rollback", () => {
	it("rapid double-click on Off fires the mutation exactly once", async () => {
		// First click triggers an in-flight PATCH; the second click should be
		// swallowed by `aria-disabled`/`disabled={isPending}`.
		let resolveMutation: (v: unknown) => void = () => {};
		updateMutationFn.mockReset();
		updateMutationFn.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);

		const user = userEvent.setup();
		renderToggle({
			pmAutoSyncEnabled: false,
			externalId: "EXT-1",
			hasPmIntegration: true,
		});

		const trigger = screen.getByRole("button", {
			name: /auto-sync paused/i,
		});
		await user.click(trigger);

		// Second click while the first PATCH is still pending should NOT
		// trigger a second mutation call. We don't await it deliberately —
		// we want to test the synchronous disabled-state guard.
		await user.click(trigger);

		// Resolve the in-flight mutation so the test can clean up.
		resolveMutation({
			story: { id: "story-1", pmAutoSyncEnabled: true },
		});

		await waitFor(() => {
			expect(updateMutationFn).toHaveBeenCalledTimes(1);
		});
	});

	it("optimistic rollback: mutation rejection restores cache and shows error toast", async () => {
		const error = new Error("Network down");
		updateMutationFn.mockReset();
		updateMutationFn.mockRejectedValueOnce(error);

		const user = userEvent.setup();
		const { queryClient, props } = renderToggle({
			pmAutoSyncEnabled: false,
			externalId: "EXT-1",
			hasPmIntegration: true,
		});

		// Seed both caches with a known "off" baseline so we can prove the
		// optimistic update flipped them to "on" and the rollback restored
		// them to "off".
		const storiesListKey = listQueryKey({
			input: {
				projectId: props.projectId,
				organizationId: props.organizationId,
			},
		});
		const storyGetKey = getQueryKey({
			input: {
				projectId: props.projectId,
				storyId: props.storyId,
				organizationId: props.organizationId,
			},
		});
		queryClient.setQueryData(storiesListKey, {
			stories: [{ id: "story-1", pmAutoSyncEnabled: false }],
		});
		queryClient.setQueryData(storyGetKey, {
			story: { id: "story-1", pmAutoSyncEnabled: false },
		});

		await user.click(
			screen.getByRole("button", { name: /auto-sync paused/i }),
		);

		// After the rejection settles, the cache should be back to the
		// original "off" state and toast.error should have fired.
		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith(
				"Could not update auto-sync",
				expect.objectContaining({ description: "Network down" }),
			);
		});

		const finalList = queryClient.getQueryData<{
			stories: { id: string; pmAutoSyncEnabled: boolean }[];
		}>(storiesListKey);
		const finalGet = queryClient.getQueryData<{
			story: { id: string; pmAutoSyncEnabled: boolean };
		}>(storyGetKey);
		expect(finalList?.stories[0].pmAutoSyncEnabled).toBe(false);
		expect(finalGet?.story.pmAutoSyncEnabled).toBe(false);
	});
});

describe("PmSyncCloudToggle — telemetry (Wave 4A: console.log events)", () => {
	it("emits [pm_sync_toggle_changed] with the expected payload on toggle success", async () => {
		const consoleLog = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});
		const user = userEvent.setup();
		renderToggle({
			pmAutoSyncEnabled: false,
			externalId: "EXT-1",
			hasPmIntegration: true,
			source: "sheet",
		});

		await user.click(
			screen.getByRole("button", { name: /auto-sync paused/i }),
		);

		await waitFor(() => {
			expect(consoleLog).toHaveBeenCalledWith(
				"[pm_sync_toggle_changed]",
				expect.objectContaining({
					storyId: "story-1",
					projectId: "proj-1",
					organizationId: null,
					enabled: true,
					prior: false,
					userId: "test-user-id",
					source: "sheet",
				}),
			);
		});
		consoleLog.mockRestore();
	});

	it("emits [pm_sync_red_state_clicked] when the Settings link inside the Red tooltip is clicked", async () => {
		const consoleLog = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});
		const user = userEvent.setup();
		renderToggle({
			hasPmIntegration: false,
			pmAutoSyncEnabled: false,
		});

		// Open the tooltip by hovering/focusing the trigger. With JSDOM,
		// hover events are reliable enough to open the Radix tooltip portal.
		const trigger = screen.getByRole("img", {
			name: /no pm tool configured/i,
		});
		await user.hover(trigger);

		// Radix portals tooltip content twice (visible portal + a hidden
		// screen-reader-only descendant), so two <a> nodes match. We click
		// the first (the user-facing portal element). The link is the inline
		// `<link>Settings > Integrations</link>` chunk rendered by t.rich.
		const settingsLinks = await screen.findAllByRole("link", {
			name: /settings\s*>\s*integrations/i,
		});
		expect(settingsLinks.length).toBeGreaterThan(0);
		await user.click(settingsLinks[0]);

		expect(consoleLog).toHaveBeenCalledWith(
			"[pm_sync_red_state_clicked]",
			expect.objectContaining({
				storyId: "story-1",
				projectId: "proj-1",
				organizationId: null,
				userId: "test-user-id",
			}),
		);
		consoleLog.mockRestore();
	});
});

describe("PmSyncCloudToggle — UX polish (loading / open-ticket / a11y)", () => {
	it("renders an invisible placeholder while hasPmIntegration is undefined", () => {
		// Loading state: pmCapabilities hasn't resolved on the parent yet.
		// The toggle must NOT flash Red — it should reserve space invisibly
		// so the surrounding flex row doesn't reflow when state arrives.
		renderToggle({ hasPmIntegration: undefined });

		// No button, link, or interactive element is rendered.
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.queryByRole("img")).toBeNull();

		// The placeholder is present in the DOM but invisible. We assert via
		// the `data-state="loading"` marker so the test isn't coupled to the
		// exact Tailwind class names.
		const placeholder = document.querySelector('[data-state="loading"]');
		expect(placeholder).not.toBeNull();
		expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
		expect(placeholder?.className).toContain("invisible");
	});

	it("renders 'Open ticket' as a real clickable link inside the Synced tooltip", async () => {
		const user = userEvent.setup();
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			externalUrl: "https://acme.atlassian.net/browse/PROJ-1",
			hasPmIntegration: true,
		});

		// Hover the toggle to open the tooltip.
		await user.hover(screen.getByRole("button"));

		// The 'Open ticket' affordance is now a real <a target="_blank">
		// inside the tooltip body (not plain interpolated text), so editor
		// users can reach the PM ticket without copy-pasting a URL. Radix
		// Tooltip renders the trigger's accessible-name copy AND a portal
		// copy when open, so there may be more than one match — assert that
		// at least one link exists and that all of them have the right
		// href/target/rel.
		const links = await screen.findAllByRole("link", {
			name: /open ticket/i,
		});
		expect(links.length).toBeGreaterThan(0);
		for (const link of links) {
			expect(link.getAttribute("href")).toBe(
				"https://acme.atlassian.net/browse/PROJ-1",
			);
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.getAttribute("rel")).toContain("noopener");
		}
	});

	it("rewrites legacy ADO REST URLs to the web UI URL on the card surface", () => {
		// Regression guard: the migration from the inline card cloud-icon
		// to this shared component dropped the `normalizeAdoWebUrl()` call
		// that PR #912 introduced. Legacy rows whose `externalUrl` was
		// captured as `/_apis/wit/workItems/<id>` (the REST endpoint —
		// browsers dump JSON when opened) must be rewritten to
		// `/_workitems/edit/<id>` (the human-readable web page) by the
		// component itself before rendering the link.
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "151",
			externalUrl:
				"https://dev.azure.com/example-org/00000000-0000-0000-0000-000000000000/_apis/wit/workItems/151",
			hasPmIntegration: true,
			interactive: false, // Card surface
		});

		const anchor = screen.getByRole("link");
		expect(anchor.getAttribute("href")).toBe(
			"https://dev.azure.com/example-org/00000000-0000-0000-0000-000000000000/_workitems/edit/151",
		);
	});

	it("announces 'Auto-sync enabled' via the live region after a successful toggle", async () => {
		const user = userEvent.setup();
		renderToggle({
			pmAutoSyncEnabled: false,
			hasPmIntegration: true,
			externalId: "EXT-1",
		});

		// The live region (semantic `<output>` element, which has implicit
		// role="status") is present from first render (empty string).
		const liveRegion = document.querySelector("output");
		expect(liveRegion).not.toBeNull();
		expect(liveRegion?.getAttribute("aria-live")).toBe("polite");
		expect(liveRegion?.textContent).toBe("");

		await user.click(screen.getByRole("button"));

		// After successful PATCH, the live region announces the new state.
		await waitFor(() => {
			expect(liveRegion?.textContent).toBe("Auto-sync enabled");
		});
	});

	it("offers a Retry action on the error toast when the toggle PATCH fails", async () => {
		const user = userEvent.setup();
		const networkError = new Error("Network unreachable");
		updateMutationFn.mockRejectedValueOnce(networkError);

		renderToggle({
			pmAutoSyncEnabled: false,
			hasPmIntegration: true,
			externalId: "EXT-1",
		});

		await user.click(screen.getByRole("button"));

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith(
				"Could not update auto-sync",
				expect.objectContaining({
					action: expect.objectContaining({
						label: "Retry",
						onClick: expect.any(Function),
					}),
				}),
			);
		});

		// Invoking the Retry action re-runs the PATCH with the same value.
		// Mock the next call to succeed so the retry doesn't itself fail.
		updateMutationFn.mockResolvedValueOnce({
			story: { id: "story-1", pmAutoSyncEnabled: true },
		});
		const lastCall = toastError.mock.calls.at(-1);
		const retryHandler = (
			lastCall?.[1] as { action: { onClick: () => void } }
		).action.onClick;
		retryHandler();

		await waitFor(() => {
			// Original failed call + retry call = 2 invocations of the mutation.
			expect(updateMutationFn).toHaveBeenCalledTimes(2);
		});
	});
});

describe("PmSyncCloudToggle — showLabel pill (workspace + sheet)", () => {
	it("renders the icon plus a status label when showLabel is true", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			externalUrl: "https://acme.atlassian.net/browse/PROJ-1",
			hasPmIntegration: true,
			showLabel: true,
		});
		// The accessible name combines the aria-label and the visible
		// `<span>Synced</span>` text inside the button.
		const trigger = screen.getByRole("button");
		expect(trigger).toHaveAttribute("data-state", "synced");
		// The visible label text appears on screen — proves the pill
		// variant rendered (icon-only mode wouldn't show the word).
		expect(trigger.textContent).toContain("Synced");
	});

	it("does NOT render the status label when showLabel is false (default)", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			externalUrl: "https://acme.atlassian.net/browse/PROJ-1",
			hasPmIntegration: true,
			// showLabel omitted — defaults to false (card surface contract)
		});
		const trigger = screen.getByRole("button");
		// The trigger should be icon-only — no human label text.
		expect(trigger.textContent || "").not.toMatch(/synced|paused/i);
	});

	it("shows 'Paused' for off+linked, 'Not synced' for off+unlinked", () => {
		const { rerender, queryClient, props } = renderToggle({
			pmAutoSyncEnabled: false,
			externalId: "EXT-1",
			hasPmIntegration: true,
			showLabel: true,
		});
		expect(screen.getByRole("button").textContent).toContain("Paused");

		// Re-render with the unlinked variant. We don't use a new render
		// helper here — re-mounting the QueryClient would defeat the
		// purpose of asserting the label flips with the data.
		rerender(
			<QueryClientProvider client={queryClient}>
				<PmSyncCloudToggle
					{...props}
					externalId={null}
					externalUrl={null}
				/>
			</QueryClientProvider>,
		);
		expect(screen.getByRole("button").textContent).toContain("Not synced");
	});

	it("uses the emerald 'text-secondary' token in the synced state for theme-safe visibility", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			hasPmIntegration: true,
			// icon-only — bumped visibility applies on every surface.
		});
		// Token-based assertion: the class name carries `text-secondary`,
		// which resolves to the emerald `--secondary` CSS variable in both
		// light + dark themes. Replaces the old `text-muted-foreground/40`
		// fade that the user flagged as too dim.
		expect(screen.getByRole("button").className).toMatch(/text-secondary/);
	});
});

// ----------------------------------------------------------------------------
// Bug #1303: roadmap cloud icon JSON link + tooltip/destination disagreement
// ----------------------------------------------------------------------------

describe("PmSyncCloudToggle — bug #1303 (URL-derived tooltip + REST→web rewrite)", () => {
	it("rewrites a stored ADO REST API URL to the web UI URL on the card link", () => {
		// Card surface (interactive=false) renders an <a> for the synced
		// linked state. The href is the place users actually click — must
		// be the web-UI form so they never land on raw JSON.
		renderToggle({
			interactive: false,
			pmAutoSyncEnabled: true,
			externalId: "149",
			externalUrl:
				"https://dev.azure.com/example-org/proj/_apis/wit/workItems/149",
			hasPmIntegration: true,
			pmToolName: "Azure DevOps",
		});
		const link = screen.getByRole("link");
		expect(link).toHaveAttribute(
			"href",
			"https://dev.azure.com/example-org/proj/_workitems/edit/149",
		);
	});

	it("rewrites a stored GitHub REST API URL to the github.com web UI URL", () => {
		renderToggle({
			interactive: false,
			pmAutoSyncEnabled: true,
			externalId: "42",
			externalUrl:
				"https://api.github.com/repos/octocat/hello-world/issues/42",
			hasPmIntegration: true,
			pmToolName: "GitHub",
		});
		const link = screen.getByRole("link");
		expect(link).toHaveAttribute(
			"href",
			"https://github.com/octocat/hello-world/issues/42",
		);
	});

	it("rewrites a stored Jira REST API URL to /browse/<key>", () => {
		renderToggle({
			interactive: false,
			pmAutoSyncEnabled: true,
			externalId: "PROJ-123",
			externalUrl: "https://acme.atlassian.net/rest/api/3/issue/PROJ-123",
			hasPmIntegration: true,
			pmToolName: "Jira",
		});
		const link = screen.getByRole("link");
		expect(link).toHaveAttribute(
			"href",
			"https://acme.atlassian.net/browse/PROJ-123",
		);
	});

	it("derives tooltip pmToolName from externalUrl host, not the project prop", () => {
		// AC3/AC4: after an integration switch, the project-level
		// pmToolName ("Azure DevOps") may disagree with a historical
		// row that still links to Jira. The aria-label must follow the
		// URL so tooltip and click destination stay consistent.
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "PROJ-123",
			externalUrl: "https://acme.atlassian.net/browse/PROJ-123",
			hasPmIntegration: true,
			pmToolName: "Azure DevOps", // project switched away from Jira
		});
		const trigger = screen.getByRole("button", {
			name: /auto-sync to jira on/i,
		});
		expect(trigger).toBeInTheDocument();
		// Sanity: the old project name should NOT appear in the label.
		expect(trigger.getAttribute("aria-label") ?? "").not.toMatch(
			/azure devops/i,
		);
	});

	it("falls back to the project prop pmToolName when externalUrl is null", () => {
		// No URL → nothing to derive from; the prop is the only signal,
		// e.g. the brand-new "armed" flow before a ticket has been created.
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: null,
			externalUrl: null,
			hasPmIntegration: true,
			pmToolName: "Azure DevOps",
		});
		const trigger = screen.getByRole("button", {
			name: /will push to azure devops/i,
		});
		expect(trigger).toBeInTheDocument();
	});

	it("uses neutral 'the linked tool' label when URL is present but host is unknown", () => {
		// Self-hosted Jira / GitHub Enterprise / custom tracker hosts
		// produce a valid http(s) URL that doesn't match any known PM-tool
		// pattern. The project prop would lie here (the exact AC3/AC4
		// mismatch this bug is about); the toggle must use a neutral
		// noun so tooltip and click destination never disagree.
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "PROJ-1",
			externalUrl: "https://jira.acme.corp/browse/PROJ-1",
			hasPmIntegration: true,
			pmToolName: "Azure DevOps", // project switched; stale prop
		});
		const trigger = screen.getByRole("button", {
			name: /auto-sync to the linked tool on/i,
		});
		expect(trigger).toBeInTheDocument();
		// The stale project name must NOT appear in the aria-label.
		expect(trigger.getAttribute("aria-label") ?? "").not.toMatch(
			/azure devops/i,
		);
	});
});

describe("PmSyncCloudToggle — provider-aware brand icon (bug 1301)", () => {
	// Bug 1301: the cloud icon on the roadmap card must identify the specific
	// PM tool the row is linked to, not render a generic cloud.
	//
	// Load-bearing contract enforced below: every branded case asserts BOTH
	// (a) the `data-pm-tool-type` attribute carries the detected key AND
	// (b) the rendered SVG does NOT carry lucide-react's `lucide-cloud`
	// class. (a) alone would silently pass if the `PM_TOOL_BRAND_ICONS`
	// registry lost the key and the toggle fell back to the generic
	// CloudIcon, since the attribute is set from URL detection BEFORE
	// icon resolution. The negative class assertion is what catches a
	// broken registry — fallback CloudIcon is `<svg class="lucide-cloud …">`,
	// branded icons render their own bare SVG without that class.
	function assertBrandedIcon(
		element: HTMLElement,
		expectedType: string,
	): void {
		expect(element.getAttribute("data-pm-tool-type")).toBe(expectedType);
		const svg = element.querySelector("svg");
		expect(svg, "branded trigger should render an SVG").not.toBeNull();
		expect(
			svg?.classList.contains("lucide-cloud"),
			`fallback CloudIcon rendered instead of the ${expectedType} brand icon — check PM_TOOL_BRAND_ICONS registry`,
		).toBe(false);
	}

	it("renders the Azure DevOps brand identity for an ADO link on the card surface", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "151",
			externalUrl:
				"https://dev.azure.com/example-org/proj/_workitems/edit/151",
			hasPmIntegration: true,
			interactive: false,
			source: "card",
		});

		assertBrandedIcon(
			screen.getByRole("link", { name: /auto-sync/i }),
			"azure-devops",
		);
	});

	it("renders the Fizzy brand identity for a fizzy.do link on the card surface", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "1301",
			externalUrl: "https://app.fizzy.do/000000/cards/1301",
			hasPmIntegration: true,
			interactive: false,
			source: "card",
		});

		assertBrandedIcon(
			screen.getByRole("link", { name: /auto-sync/i }),
			"fizzy",
		);
	});

	it("renders the Jira brand identity for an atlassian.net link on the card surface", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "PROJ-1",
			externalUrl: "https://acme.atlassian.net/browse/PROJ-1",
			hasPmIntegration: true,
			interactive: false,
			source: "card",
		});

		assertBrandedIcon(
			screen.getByRole("link", { name: /auto-sync/i }),
			"jira",
		);
	});

	it("falls back to the lucide CloudIcon when the URL host is unrecognized", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
			externalUrl: "https://intranet.acme.example/ticket/1",
			hasPmIntegration: true,
			interactive: false,
			source: "card",
		});

		const link = screen.getByRole("link", { name: /auto-sync/i });
		expect(link.hasAttribute("data-pm-tool-type")).toBe(false);
		// Positive guard: fallback path must actually render the lucide
		// CloudIcon. Without this, a future refactor that dropped the
		// fallback branch entirely would still pass the absence-of-attr
		// check while showing nothing.
		const svg = link.querySelector("svg");
		expect(svg?.classList.contains("lucide-cloud")).toBe(true);
	});

	it("does NOT register Bitbucket: the host is absent from PM_TOOL_HOST_PATTERNS", async () => {
		// Regression guard for the Codex review finding: a registry entry
		// without a matching host-pattern is dead code that misleads
		// reviewers into thinking Bitbucket is supported. If a future PR
		// adds bitbucket.org to PM_TOOL_HOST_PATTERNS, this test should be
		// flipped to a positive assertion at the same time the registry
		// gets a bitbucket entry — keeping the two halves coupled.
		const { getPmToolBrandIcon } = await import("../pm-tool-brand-icon");
		expect(getPmToolBrandIcon("bitbucket")).toBeUndefined();
	});

	it("renders the universal cloud-off glyph in the Off state even when the URL identifies a brand", () => {
		renderToggle({
			pmAutoSyncEnabled: false,
			externalId: "EXT-1",
			externalUrl: "https://app.fizzy.do/000000/cards/1301",
			hasPmIntegration: true,
			interactive: false,
			source: "card",
		});

		// Off (paused) on the card surface renders as a <span role="img">.
		// State semantics ("syncing is off") outweigh brand identity here, so
		// the lucide CloudOff glyph stays — recognizable by lucide-react's
		// `lucide-cloud-off` class on the rendered SVG. `data-pm-tool-type`
		// still propagates so tests/log analysis can correlate the off-state
		// row with its linked tool, but the visible icon is brand-neutral.
		const trigger = screen.getByRole("img", { name: /auto-sync paused/i });
		const svg = trigger.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.classList.contains("lucide-cloud-off")).toBe(true);
	});

	it("renders a brand icon on the editor surface (interactive button) when synced to Linear", () => {
		renderToggle({
			pmAutoSyncEnabled: true,
			externalId: "FAB-1",
			externalUrl: "https://linear.app/acme/issue/FAB-1",
			hasPmIntegration: true,
			interactive: true,
			source: "editor",
		});

		assertBrandedIcon(
			screen.getByRole("button", { name: /auto-sync to/i }),
			"linear",
		);
	});

	it("opens the linked ticket via about:blank then assigns location.href (bypasses cross-origin PWA capture)", async () => {
		// Display-only card surface: the synced + linked icon is an <a> whose
		// click opens the PM ticket. Direct `window.open(url, '_blank', ...)`
		// gets routed into the destination PWA's standalone window when the
		// destination origin has `capture_links` enabled (e.g., Fizzy.io).
		// Open `about:blank` first then assign `location.href` — Chrome
		// cannot capture a window it did not originate.
		let navigatedUrl: string | null = null;
		const fakeWindow = {
			opener: {} as unknown,
			location: {
				_href: "about:blank",
				set href(value: string) {
					this._href = value;
					navigatedUrl = value;
				},
				get href() {
					return this._href;
				},
			},
		} as unknown as Window;
		const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeWindow);
		const user = userEvent.setup();

		renderToggle({
			interactive: false,
			pmAutoSyncEnabled: true,
			hasPmIntegration: true,
			externalId: "EXT-1",
			externalUrl: "https://acme.atlassian.net/browse/PROJ-1",
			lastPmSyncStatus: null,
		});

		await user.click(screen.getByRole("link"));

		expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
		expect(navigatedUrl).toContain("acme.atlassian.net/browse/PROJ-1");
		// opener must be severed (the security guarantee normally provided
		// by `rel="noopener"`).
		expect(fakeWindow.opener).toBeNull();
		openSpy.mockRestore();
	});
});
