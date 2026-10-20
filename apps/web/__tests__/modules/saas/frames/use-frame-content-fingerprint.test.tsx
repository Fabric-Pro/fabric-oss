import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fingerprint: vi.fn() }));
vi.mock("@saas/frames/lib/frame-content-fingerprint", () => ({
	frameContentFingerprint: mocks.fingerprint,
}));

import { useFrameContentFingerprint } from "@saas/frames/hooks/use-frame-content-fingerprint";

beforeEach(() => vi.clearAllMocks());

it("never returns the previous digest while replacement content is being hashed", async () => {
	mocks.fingerprint.mockResolvedValueOnce("first-digest");
	const first = [{ id: "page", type: "html", content: "<p>First</p>" }];
	const second = [{ id: "page", type: "html", content: "<p>Second</p>" }];
	let finish: ((value: string) => void) | undefined;
	mocks.fingerprint.mockReturnValueOnce(
		new Promise<string>((resolve) => {
			finish = resolve;
		}),
	);
	const observed: Array<{ blocks: typeof first; value: string | null }> = [];
	const view = renderHook(
		({ blocks }) => {
			const value = useFrameContentFingerprint(blocks, ["fabric_ask"]);
			observed.push({ blocks, value });
			return value;
		},
		{ initialProps: { blocks: first } },
	);
	await waitFor(() => expect(view.result.current).toBe("first-digest"));

	view.rerender({ blocks: second });
	expect(view.result.current).toBeNull();
	expect(
		observed.some(
			(render) => render.blocks === second && render.value !== null,
		),
	).toBe(false);
	await act(async () => finish?.("second-digest"));
	expect(view.result.current).toBe("second-digest");
});
