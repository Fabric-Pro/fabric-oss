import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => {
	const replace = vi.fn();
	return {
		// `router` is a stable reference, mirroring next/navigation. The hook's
		// effect lists it as a dependency, so handing back a fresh object per
		// render would re-run the effect every render — and since the effect
		// sets state, that is an infinite loop in the TEST rather than a real
		// defect in the hook.
		mocks: { search: "", replace, router: { replace } },
	};
});

vi.mock("next/navigation", () => ({
	useRouter: () => mocks.router,
	usePathname: () => "/app/projects/p-1",
	useSearchParams: () => new URLSearchParams(mocks.search),
}));

import { useProjectTabDeepLink } from "../use-project-tab-deep-link";

// The tests stay ignorant of the real project tab list: any module-level
// type-guard works, and a two-value one keeps the invalid-value cases obvious.
const isValid = (v: string): v is "documents" | "stories" =>
	v === "documents" || v === "stories";

beforeEach(() => {
	mocks.search = "";
	mocks.replace.mockReset();
});

describe("useProjectTabDeepLink", () => {
	it("reports a valid tab once and strips the param, preserving other params", () => {
		mocks.search = "tab=documents&q=F-123";
		const { result } = renderHook(() => useProjectTabDeepLink(isValid));

		expect(result.current?.tab).toBe("documents");
		expect(result.current?.seq).toBe(1);
		expect(mocks.replace).toHaveBeenCalledWith(
			"/app/projects/p-1?q=F-123",
			{ scroll: false },
		);
	});

	it("drops the query string entirely when tab was the only param", () => {
		mocks.search = "tab=stories";
		const { result } = renderHook(() => useProjectTabDeepLink(isValid));

		expect(result.current?.tab).toBe("stories");
		expect(mocks.replace).toHaveBeenCalledWith("/app/projects/p-1", {
			scroll: false,
		});
	});

	it("does not re-apply a consumed tab when an unrelated param changes", () => {
		// The regression this hook exists for: the old inline effect keyed on
		// `searchParams` and re-applied `?tab=` on ANY query write. The roadmap
		// search box preserves params it does not own when it writes `?q=`, so
		// one keystroke re-asserted a stale `tab=documents` and unmounted the
		// roadmap mid-search.
		mocks.search = "tab=documents";
		const { result, rerender } = renderHook(() =>
			useProjectTabDeepLink(isValid),
		);

		const first = result.current;
		expect(first?.seq).toBe(1);

		// The strip lands: the param is gone from the URL.
		mocks.search = "";
		rerender();
		expect(result.current).toBe(first);

		// The roadmap search writes `?q=` — no tab param involved.
		mocks.search = "q=F-123";
		rerender();

		expect(result.current).toBe(first);
		expect(mocks.replace).toHaveBeenCalledTimes(1);
	});

	it("neither applies nor strips an unrecognized value", () => {
		// `tab` values this page does not define address a sub-view; stripping
		// them here would break that sub-view's own consumer.
		mocks.search = "tab=bogus";
		const { result } = renderHook(() => useProjectTabDeepLink(isValid));

		expect(result.current).toBeNull();
		expect(mocks.replace).not.toHaveBeenCalled();
	});

	it("returns null when the param is absent", () => {
		mocks.search = "q=F-123";
		const { result } = renderHook(() => useProjectTabDeepLink(isValid));

		expect(result.current).toBeNull();
		expect(mocks.replace).not.toHaveBeenCalled();
	});

	it("reaches consumers again when the SAME link is followed twice", () => {
		// Back-arrow to `?tab=documents` after the user manually switched away
		// must land on Documents again. Returning a bare string would let
		// React's Object.is bailout swallow the repeat; `seq` makes it
		// observable.
		mocks.search = "tab=documents";
		const { result, rerender } = renderHook(() =>
			useProjectTabDeepLink(isValid),
		);

		const first = result.current;
		expect(first?.seq).toBe(1);

		mocks.search = "";
		rerender();
		expect(result.current).toBe(first);

		mocks.search = "tab=documents";
		rerender();

		expect(result.current?.tab).toBe("documents");
		expect(result.current?.seq).toBe(2);
		// A consumer keying its effect on the returned value must see a change.
		expect(result.current).not.toBe(first);
	});
});
