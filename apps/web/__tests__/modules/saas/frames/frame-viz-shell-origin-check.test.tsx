/**
 * The shell listens on `window` for messages from the embed it framed. Without
 * an origin check any window holding a handle on this one could resize the
 * frame or resolve a pending export/code RPC with its own payload.
 *
 * Guards js/missing-origin-check.
 */
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../modules/saas/frames/components/ShareFrameSheet", () => ({
	ShareFrameSheet: () => null,
}));

vi.mock("../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

import { FrameVizShell } from "@saas/frames/components/FrameVizShell";

const EMBED_URL = "/app/frames/f1/embed";

function postToHost(data: unknown, origin: string) {
	window.dispatchEvent(new MessageEvent("message", { data, origin }));
}

describe("FrameVizShell — postMessage origin check", () => {
	it("ignores a set-height message from a foreign origin", async () => {
		const { container } = render(
			<FrameVizShell
				title="Quarterly numbers"
				kind="frame"
				embedUrl={EMBED_URL}
				hideHeader
			/>,
		);
		const iframe = container.querySelector("iframe");
		expect(iframe).not.toBeNull();
		const before = (iframe as HTMLIFrameElement).style.height;

		postToHost(
			{ type: "fabric-frame:set-height", height: 4321 },
			"https://attacker.example",
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect((iframe as HTMLIFrameElement).style.height).toBe(before);
	});

	it("still accepts a set-height message from the embed's own origin", async () => {
		const { container } = render(
			<FrameVizShell
				title="Quarterly numbers"
				kind="frame"
				embedUrl={EMBED_URL}
				hideHeader
			/>,
		);
		const iframe = container.querySelector("iframe") as HTMLIFrameElement;

		postToHost(
			{ type: "fabric-frame:set-height", height: 4321 },
			window.location.origin,
		);

		await waitFor(() => {
			// 4321 + 24 of chrome, inside the shell's own 480…12000 clamp.
			expect(iframe.style.height).toBe("4345px");
		});
	});
});
