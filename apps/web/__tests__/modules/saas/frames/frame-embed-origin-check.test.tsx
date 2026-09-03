/**
 * The frame embed view is deliberately framable by any origin (proxy.ts
 * exempts `.../embed` from `frame-ancestors 'self'`), so any page that frames
 * it can post messages into it. Only this app drives the embed RPC, and
 * `request-export-png` answers with a PNG of the rendered frame — a foreign
 * framing page must not be able to ask for one.
 *
 * Guards js/missing-origin-check.
 */
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("html2canvas", () => ({
	default: vi.fn(async () => ({
		toDataURL: () => "data:image/png;base64,AAAA",
	})),
}));

vi.mock("../../../../modules/marketing/blog/components/Mermaid", () => ({
	Mermaid: () => null,
}));

vi.mock("../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

import {
	type FrameDocumentView,
	FrameRenderer,
} from "@saas/frames/components/FrameRenderer";

const frame: FrameDocumentView = {
	version: 1,
	kind: "frame",
	title: "Quarterly numbers",
	blocks: [{ id: "b1", type: "markdown", content: "Revenue is up." }],
};

/** Every message the embed sends to its host, in order. */
let posted: unknown[] = [];

beforeEach(() => {
	posted = [];
	vi.spyOn(window.parent, "postMessage").mockImplementation(
		(message: unknown) => {
			posted.push(message);
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function postToEmbed(data: unknown, origin: string) {
	window.dispatchEvent(new MessageEvent("message", { data, origin }));
}

describe("FrameRenderer embed — postMessage origin check", () => {
	it("ignores an export request from a foreign origin", async () => {
		render(<FrameRenderer frame={frame} embedded />);

		postToEmbed(
			{
				type: "fabric-frame:request-export-png",
				requestId: "req-foreign",
			},
			"https://attacker.example",
		);

		// Give the (async) handler a turn; nothing must come back carrying the
		// rendered frame.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			posted.some(
				(m) =>
					(m as { requestId?: string })?.requestId === "req-foreign",
			),
		).toBe(false);
	});

	it("still answers an export request from this app's own origin", async () => {
		render(<FrameRenderer frame={frame} embedded />);

		postToEmbed(
			{ type: "fabric-frame:request-export-png", requestId: "req-own" },
			window.location.origin,
		);

		await waitFor(() => {
			expect(
				posted.some(
					(m) =>
						(m as { requestId?: string })?.requestId === "req-own",
				),
			).toBe(true);
		});
	});
});
