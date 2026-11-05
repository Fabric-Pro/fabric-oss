import { cleanup, render, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@ui/components/tooltip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Mermaid } from "../../../modules/marketing/blog/components/Mermaid";

const h = vi.hoisted(() => ({
	primary: vi.fn(),
	fallback: vi.fn(),
	initialize: vi.fn(),
}));
vi.mock("next-themes", () => ({
	useTheme: () => ({ resolvedTheme: "light" }),
}));
vi.mock("beautiful-mermaid", () => ({
	THEMES: { default: { bg: "#fff", fg: "#111" } },
	renderMermaid: h.primary,
}));
vi.mock("mermaid", () => ({
	default: {
		initialize: h.initialize,
		parse: vi.fn(async () => true),
		render: h.fallback,
		mermaidAPI: { getSiteConfig: () => ({ securityLevel: "loose" }) },
	},
}));
const svg =
	'<svg viewBox="0 0 10 10" onload="alert(1)"><style>@import url(https://example.com/track.css);</style><g onclick="alert(2)"><text>Example safe label</text><path d="M0 0 L10 10"/></g><foreignObject><div>Untrusted HTML</div></foreignObject><image href="https://example.com/track.png"/></svg>';
beforeEach(() => {
	vi.clearAllMocks();
	h.primary.mockResolvedValue(svg);
	h.fallback.mockResolvedValue({ svg });
});
afterEach(cleanup);
it.each(["primary", "fallback"])(
	"sanitizes the %s renderer before diagram SVG enters the host DOM",
	async (renderer) => {
		if (renderer === "fallback") {
			h.primary.mockRejectedValue(
				new Error("Example unsupported diagram"),
			);
		}
		const view = render(
			<TooltipProvider>
				<Mermaid chart="graph TD; A-->B" />
			</TooltipProvider>,
		);
		await waitFor(
			() =>
				expect(
					view.container.querySelector(".mermaid-diagram text"),
				).toHaveTextContent("Example safe label"),
			{ timeout: 5000 },
		);
		const content = view.container.querySelector(".mermaid-diagram");
		if (!content) {
			throw new Error("Diagram did not render");
		}
		expect(content.querySelector("foreignObject")).toBeNull();
		expect(content.querySelector("[onclick],[onload]")).toBeNull();
		expect(content.innerHTML).not.toContain("https://example.com");
		expect(content.querySelector("path")).not.toBeNull();
		expect(h.initialize).toHaveBeenCalledWith(
			expect.objectContaining({
				securityLevel: "strict",
				htmlLabels: false,
				flowchart: { htmlLabels: false },
			}),
		);
		expect(h.initialize).toHaveBeenLastCalledWith({
			securityLevel: "loose",
		});
	},
);
