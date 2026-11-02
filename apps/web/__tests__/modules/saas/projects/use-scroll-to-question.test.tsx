import { useScrollToQuestion } from "@saas/projects/components/stories/maturation/use-scroll-to-question";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
	useSearchParams: () => navigation.params,
}));

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
	window.history.replaceState(null, "", window.location.pathname);
	vi.restoreAllMocks();
});

it("scrolls to a new soft-navigation hash after ready", () => {
	document.body.innerHTML =
		'<div data-question-anchor="first"></div><div data-question-anchor="second"></div>';
	window.history.replaceState(null, "", "#q-first");
	const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
	const view = renderHook(() => useScrollToQuestion(true));
	expect(scroll.mock.instances.at(-1)).toBe(document.body.children[0]);
	window.history.pushState(null, "", "#q-second");
	navigation.params = new URLSearchParams();
	view.rerender();
	expect(scroll.mock.instances.at(-1)).toBe(document.body.children[1]);
	expect(scroll).toHaveBeenCalledTimes(2);
});

it("scrolls after a native hashchange while ready", () => {
	document.body.innerHTML = '<div data-question-anchor="native"></div>';
	const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
	renderHook(() => useScrollToQuestion(true));
	window.history.pushState(null, "", "#q-native");
	act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
	expect(scroll.mock.instances.at(-1)).toBe(document.body.children[0]);
});
