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

import { useConsumeSearchParam } from "../use-consume-search-param";

beforeEach(() => {
	mocks.search = "";
	mocks.replace.mockReset();
});

describe("useConsumeSearchParam", () => {
	it("reports the value once and strips the param", () => {
		mocks.search = "proposal=prop_1";
		const { result } = renderHook(() => useConsumeSearchParam("proposal"));

		expect(result.current?.value).toBe("prop_1");
		expect(mocks.replace).toHaveBeenCalledWith("/app/projects/p-1", {
			scroll: false,
		});
	});

	it("preserves other params when stripping", () => {
		mocks.search = "tab=stories&proposal=prop_1";
		renderHook(() => useConsumeSearchParam("proposal"));

		expect(mocks.replace).toHaveBeenCalledWith(
			"/app/projects/p-1?tab=stories",
			{ scroll: false },
		);
	});

	it("reaches consumers again when the SAME link is followed twice", () => {
		// One proposal can create several work items, so several roadmap rows
		// link to the identical `?proposal=<id>`. Following a second one must
		// reopen the drawer. Returning a bare string would let React's Object.is
		// bailout swallow the repeat: the param gets stripped and nothing
		// happens. `seq` is what makes the repeat observable.
		mocks.search = "proposal=prop_1";
		const { result, rerender } = renderHook(() =>
			useConsumeSearchParam("proposal"),
		);

		const first = result.current;
		expect(first?.seq).toBe(1);

		// The strip lands: the param is gone from the URL.
		mocks.search = "";
		rerender();
		expect(result.current).toBe(first);

		// The same link is followed again, without a remount.
		mocks.search = "proposal=prop_1";
		rerender();

		expect(result.current?.value).toBe("prop_1");
		expect(result.current?.seq).toBe(2);
		// A consumer keying its effect on the returned value must see a change.
		expect(result.current).not.toBe(first);
	});

	it("returns null when the param is absent", () => {
		mocks.search = "tab=stories";
		const { result } = renderHook(() => useConsumeSearchParam("proposal"));

		expect(result.current).toBeNull();
		expect(mocks.replace).not.toHaveBeenCalled();
	});
});
