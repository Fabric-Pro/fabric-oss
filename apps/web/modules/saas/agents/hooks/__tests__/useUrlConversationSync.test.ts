import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUrlConversationSync } from "../useUrlConversationSync";

interface Props {
	url: string | null;
	/** What reading the selected conversation gives: null when it is gone. */
	conversation: object | null;
}

const onConversationChange = vi.fn();

/**
 * The page's wiring, with a URL that does not follow `onConversationChange`:
 * as a replaced URL arrives only on a later render.
 */
function useHarness({ url, conversation }: Props) {
	const [active, setActive] = useState<string | null>(null);
	useUrlConversationSync({
		urlConversationId: url,
		activeConversationId: active,
		activeConversation: active === null ? null : conversation,
		isLoadingDetail: false,
		selectConversation: setActive,
		onConversationChange,
	});
	return { active, select: setActive };
}

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe("useUrlConversationSync", () => {
	it("selects what the URL names, and nothing once the URL names nothing", () => {
		const { result, rerender } = renderHook(useHarness, {
			initialProps: { url: "conv-1", conversation: { id: "conv-1" } },
		});
		expect(result.current.active).toBe("conv-1");

		rerender({ url: "conv-2", conversation: { id: "conv-2" } });
		expect(result.current.active).toBe("conv-2");

		rerender({ url: null, conversation: { id: "conv-2" } });
		expect(result.current.active).toBeNull();
	});

	it("keeps the open conversation let go of after a delete, while the URL still names it", () => {
		const { result } = renderHook(useHarness, {
			initialProps: { url: "conv-1", conversation: { id: "conv-1" } },
		});

		act(() => result.current.select(null));

		expect(result.current.active).toBeNull();
	});

	it("lets go of a conversation that is gone once, without selecting it again", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const { result } = renderHook(useHarness, {
			initialProps: { url: "conv-gone", conversation: null },
		});

		expect(result.current.active).toBeNull();
		expect(onConversationChange).toHaveBeenCalledTimes(1);
		expect(onConversationChange).toHaveBeenCalledWith(null);
	});
});
