import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("html2canvas", () => ({ default: vi.fn() }));
vi.mock("../../../../modules/marketing/blog/components/Mermaid", () => ({
	Mermaid: () => null,
}));
// Preserve the real chat renderer's explicit utility overrides in this focused boundary test.
vi.mock("../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children?: React.ReactNode }) => (
		<div className="font-sans text-foreground">
			<p>{children}</p>
		</div>
	),
}));

import {
	type FrameDocumentView,
	FrameRenderer,
} from "@saas/frames/components/FrameRenderer";

const brand = {
	version: 1 as const,
	source: "CLIENT" as const,
	companyName: "Example Studio",
	clientName: "Example Client",
	primaryColor: "#ffff00",
	accentColors: [],
	displayFontFamily: "Inter" as const,
	bodyFontFamily: "Poppins" as const,
	coverStyle: "LIGHT" as const,
	companyBrandVersion: 2,
	clientBrandVersion: 3,
};
const frame: FrameDocumentView = {
	version: 1,
	kind: "frame",
	title: "Delivery brief",
	blocks: [
		{ id: "report", type: "markdown", content: "Reviewed delivery facts." },
	],
	theme: { mode: "light", branding: brand },
};
describe("branded Frame markdown typography", () => {
	it("remaps explicit chat font/color utilities inside only the branded artifact", () => {
		const { container } = render(<FrameRenderer frame={frame} embedded />);
		const root = container.querySelector<HTMLElement>(
			'[id^="frame-brand-"]',
		);
		if (!root) {
			throw new Error("Branded Frame root missing");
		}
		const css = root.querySelector("style")?.textContent ?? "";
		expect(root.querySelector(".font-sans.text-foreground")).not.toBeNull();
		expect(new RegExp(`#${root.id}\\{`).test(css)).toBe(true);
		expect(/--font-sans:\s*"Poppins"/.test(css)).toBe(true);
		expect(/--foreground:\s*#111827/i.test(css)).toBe(true);
		expect(/--color-foreground:\s*#111827/i.test(css)).toBe(true);
		expect(/--color-background:\s*#ffffff/i.test(css)).toBe(true);
		expect(/--background:\s*#ffffff/i.test(css)).toBe(true);
		expect(css.includes(":root{")).toBe(false);
		expect(root.textContent).toContain("Prepared by");
		expect(root.textContent).toContain("Prepared for");
	});
	it("keeps legacy unbranded Frames on their existing application theme", () => {
		const { container } = render(
			<FrameRenderer frame={{ ...frame, theme: { mode: "system" } }} />,
		);
		expect(container.querySelector("style")).toBeNull();
		expect(container.textContent).not.toContain("Prepared for");
	});
});
