/**
 * The shell listens on `window` for messages from the embed it framed. Without
 * an origin check, and a check of the window it came from, any window holding a
 * handle on this one could resize the frame or resolve a pending export/code RPC
 * with its own payload.
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

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "org-a",
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

import { FrameVizShell } from "@saas/frames/components/FrameVizShell";

const EMBED_URL = "/app/example-org/frames/f1/embed";

function postToHost(
	data: unknown,
	origin: string,
	source: Window | null = null,
) {
	window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

function renderShell() {
	const { container } = render(
		<FrameVizShell
			title="Quarterly numbers"
			kind="frame"
			embedUrl={EMBED_URL}
			organizationId="org-a"
			hideHeader
		/>,
	);
	const iframe = container.querySelector("iframe") as HTMLIFrameElement;
	expect(iframe).not.toBeNull();
	return iframe;
}

describe("FrameVizShell — postMessage origin and source check", () => {
	it("ignores a set-height message from a foreign origin, even from the embed's window", async () => {
		const iframe = renderShell();
		const before = iframe.style.height;

		postToHost(
			{ type: "fabric-frame:set-height", height: 4321 },
			"https://attacker.example",
			iframe.contentWindow,
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(iframe.style.height).toBe(before);
	});

	it("ignores a set-height message from the app's own origin that did not come from the embed's window", async () => {
		const iframe = renderShell();
		const before = iframe.style.height;
		const stranger = document.createElement("iframe");
		document.body.appendChild(stranger);

		postToHost(
			{ type: "fabric-frame:set-height", height: 4321 },
			window.location.origin,
			stranger.contentWindow,
		);
		postToHost(
			{ type: "fabric-frame:set-height", height: 4321 },
			window.location.origin,
			window,
		);
		postToHost(
			{ type: "fabric-frame:set-height", height: 4321 },
			window.location.origin,
			null,
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(iframe.style.height).toBe(before);
		stranger.remove();
	});

	it("still accepts a set-height message from the embed's own window and origin", async () => {
		const iframe = renderShell();

		postToHost(
			{ type: "fabric-frame:set-height", height: 4321 },
			window.location.origin,
			iframe.contentWindow,
		);

		await waitFor(() => {
			// 4321 + 24 of chrome, inside the shell's own 480…12000 clamp.
			expect(iframe.style.height).toBe("4345px");
		});
	});
});
