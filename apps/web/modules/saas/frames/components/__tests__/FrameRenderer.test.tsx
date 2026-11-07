import { render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { type FrameDocumentView, FrameRenderer } from "../FrameRenderer";

vi.mock("html2canvas", () => ({ default: vi.fn() }));
vi.mock("../../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("../../../../marketing/blog/components/Mermaid", () => ({
	Mermaid: () => <div>Diagram</div>,
}));
const brand = {
	version: 1 as const,
	source: "COMPANY" as const,
	companyName: "Example Studio",
	clientName: null,
	primaryColor: "#990000",
	accentColors: [],
	displayFontFamily: "Poppins" as const,
	bodyFontFamily: "Inter" as const,
	coverStyle: "LIGHT" as const,
	companyBrandVersion: 1,
	clientBrandVersion: 0,
};
const document: FrameDocumentView = {
	version: 1,
	kind: "frame",
	title: "Example interface",
	theme: { branding: brand },
	blocks: [
		{
			id: "page",
			type: "html",
			title: "Example interface",
			content:
				"<style>body{margin:0;color:#123456;font-family:Georgia}</style><h1>Authored page</h1><script>window.authored=true</script>",
		},
	],
};
beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
});
it("shows interface HTML without a report cover, block title, brand CSS or host card padding", () => {
	const { container } = render(
		<FrameRenderer frame={{ ...document, presentation: "INTERFACE" }} />,
	);
	expect(container.querySelector(".artifact-brand-cover")).toBeNull();
	expect(container.querySelector("section")?.className).not.toMatch(
		/p-4|border|bg-card/,
	);
	expect(container.querySelector("h2")).toBeNull();
	const iframe = container.querySelector("iframe");
	expect(iframe?.getAttribute("srcdoc")).toContain("font-family:Georgia");
	expect(iframe?.getAttribute("srcdoc")).not.toContain("@font-face");
	expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");
});
it("retains legacy document covers and clamps a crafted report interface to static document", () => {
	const { container } = render(
		<FrameRenderer
			frame={{
				...document,
				presentation: "INTERFACE",
				metadata: { sourceRunType: "REPORT_EXECUTION" },
			}}
		/>,
	);
	expect(container.querySelector(".artifact-brand-cover")).not.toBeNull();
	expect(
		container.querySelector("iframe")?.getAttribute("srcdoc"),
	).not.toContain("window.authored");
});
it("does not hide non-HTML interface blocks", () => {
	const { getByText } = render(
		<FrameRenderer
			frame={{
				...document,
				presentation: "INTERFACE",
				blocks: [
					{
						id: "notes",
						type: "markdown",
						content: "A useful result",
					},
				],
			}}
		/>,
	);
	expect(getByText("A useful result")).toBeVisible();
});
