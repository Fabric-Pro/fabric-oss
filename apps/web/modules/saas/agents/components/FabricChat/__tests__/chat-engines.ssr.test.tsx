// @vitest-environment node
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineView } from "./helpers/chat-engine-ssr-harness";

const network = vi.fn<typeof fetch>(() => {
	throw new Error("Unexpected server-render network request");
});
beforeEach(() => {
	network.mockClear();
	vi.stubGlobal("fetch", network);
});
afterEach(() => vi.unstubAllGlobals());
describe("chat engine server rendering", () => {
	it.each(["direct", "orchestrator"] as const)(
		"renders the real %s welcome without a DOM or mutation",
		(mode) => {
			expect(typeof window).toBe("undefined");
			expect(typeof document).toBe("undefined");
			const view = createEngineView(mode);
			try {
				const html = renderToString(view.element);
				expect(html).toContain(
					mode === "direct"
						? "What&#x27;s on the agenda today?"
						: "What do you want to get done?",
				);
				expect(html).toContain("<textarea");
				expect(network).not.toHaveBeenCalled();
			} finally {
				view.client.clear();
			}
		},
	);
	it.each(["direct", "orchestrator"] as const)(
		"keeps a saved %s conversation pending instead of rendering an empty welcome",
		(mode) => {
			const view = createEngineView(mode, "conversation-example");
			try {
				const html = renderToString(view.element);
				expect(html).toContain("Loading conversation");
				expect(html).not.toContain("<textarea");
				expect(html).not.toContain("What do you want");
				expect(network).not.toHaveBeenCalled();
			} finally {
				view.client.clear();
			}
		},
	);
});
