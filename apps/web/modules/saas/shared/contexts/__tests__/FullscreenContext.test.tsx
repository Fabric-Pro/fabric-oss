import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";
import { FullscreenProvider, useFullscreen } from "../FullscreenContext";

describe("FullscreenContext", () => {
	it("returns false for fallback outside the provider", () => {
		const { result } = renderHook(() => useFullscreen());
		expect(result.current.isFullscreen).toBe(false);
		expect(result.current.isRailExpanded).toBe(false);

		expect(() => {
			result.current.setIsFullscreen(true);
			result.current.setIsRailExpanded(true);
		}).not.toThrow();
	});

	it("resets isRailExpanded to false when fullscreen turns off", () => {
		const wrapper = ({ children }: PropsWithChildren) => (
			<FullscreenProvider>{children}</FullscreenProvider>
		);
		const { result } = renderHook(() => useFullscreen(), { wrapper });

		act(() => {
			result.current.setIsFullscreen(true);
		});
		expect(result.current.isFullscreen).toBe(true);

		act(() => {
			result.current.setIsRailExpanded(true);
		});
		expect(result.current.isRailExpanded).toBe(true);

		act(() => {
			result.current.setIsFullscreen(false);
		});
		expect(result.current.isFullscreen).toBe(false);
		expect(result.current.isRailExpanded).toBe(false);
	});
});
