import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerReplace = vi.fn();
let currentSearch = "";

// `useRouter` must return a STABLE object, and `useSearchParams` a fresh one —
// matching Next's real contract. The fresh params object is what proves the
// hook keys its effect on the serialized query rather than the instance.
const router = { replace: routerReplace };

vi.mock("next/navigation", () => ({
	useRouter: () => router,
	usePathname: () => "/app/projects/project_1",
	useSearchParams: () => new URLSearchParams(currentSearch),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/acme" }),
}));

import { buildProjectSyncLogRoute } from "../../../lib/stories/routes";
import { useOpenSyncLog, useSyncLogDeepLink } from "../sync-log-deep-link";

beforeEach(() => {
	routerReplace.mockReset();
	currentSearch = "";
});

afterEach(() => cleanup());

describe("useSyncLogDeepLink", () => {
	it("does not fire without the param", () => {
		const { result } = renderHook(() => useSyncLogDeepLink());

		expect(result.current).toBe(0);
		expect(routerReplace).not.toHaveBeenCalled();
	});

	it("fires once and strips the param, keeping the others", () => {
		currentSearch = "tab=stories&history=sync";
		const { result } = renderHook(() => useSyncLogDeepLink());

		expect(result.current).toBe(1);
		expect(routerReplace).toHaveBeenCalledWith(
			"/app/projects/project_1?tab=stories",
			{ scroll: false },
		);
	});

	it("drops the '?' entirely when the sync param was the only one", () => {
		currentSearch = "history=sync";
		renderHook(() => useSyncLogDeepLink());

		expect(routerReplace).toHaveBeenCalledWith("/app/projects/project_1", {
			scroll: false,
		});
	});

	it("ignores an unrelated value of the same param", () => {
		currentSearch = "history=changes";
		const { result } = renderHook(() => useSyncLogDeepLink());

		expect(result.current).toBe(0);
		expect(routerReplace).not.toHaveBeenCalled();
	});

	// A boolean latch would stay `true` here, so the consumer's effect wouldn't
	// re-run and a second visit to the link would silently do nothing.
	it("increments again when the link is followed a second time", () => {
		currentSearch = "history=sync";
		const { result, rerender } = renderHook(() => useSyncLogDeepLink());
		expect(result.current).toBe(1);

		currentSearch = "";
		rerender();
		currentSearch = "history=sync";
		rerender();

		expect(result.current).toBe(2);
	});
});

describe("useOpenSyncLog", () => {
	it("navigates to the canonical sync-log route", () => {
		const { result } = renderHook(() => useOpenSyncLog("proj_1"));

		act(() => result.current());

		expect(routerReplace).toHaveBeenCalledWith(
			buildProjectSyncLogRoute("/app/acme", "proj_1"),
			{ scroll: false },
		);
	});

	/**
	 * Regression: the opener used to copy the CURRENT query and only append
	 * `history=sync`. A stale `?tab=settings` (left by any "Check Configuration"
	 * CTA — a manual tab switch does not rewrite the URL) therefore survived, and
	 * `ProjectDetails`' `?tab=` effect yanked the user back to Settings, so the
	 * roadmap unmounted and the modal never opened.
	 */
	it("does not carry a stale ?tab= through to the destination", () => {
		currentSearch = "tab=settings&storyId=abc";
		const { result } = renderHook(() => useOpenSyncLog("proj_1"));

		act(() => result.current());

		const [url] = routerReplace.mock.calls[0] as [string];
		expect(url).toContain("tab=stories");
		expect(url).not.toContain("tab=settings");
	});
});

describe("buildProjectSyncLogRoute", () => {
	it("targets the roadmap tab from the context base, in both tenancy modes", () => {
		expect(buildProjectSyncLogRoute("/app/acme", "proj_1")).toBe(
			"/app/acme/projects/proj_1?tab=stories&history=sync",
		);
		expect(buildProjectSyncLogRoute("/app", "proj_1")).toBe(
			"/app/projects/proj_1?tab=stories&history=sync",
		);
	});
});
