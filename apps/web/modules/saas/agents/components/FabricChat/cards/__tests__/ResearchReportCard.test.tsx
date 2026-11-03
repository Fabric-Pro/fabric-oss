import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/AnsweredByModel", () => ({
	AnsweredByModel: ({ model }: { model?: { id: string } }) =>
		model ? <span>Answered by {model.id}</span> : null,
}));

import { ResearchReportCard } from "../ResearchReportCard";

const section: ComponentProps<
	typeof ResearchReportCard
>["report"]["sections"][number] = {
	heading: "Concurrency comparison",
	content:
		"**Reader snapshots** remain stable. [7]\n\n- Read the draft.\n- Compare the marker.\n\n[Official reference](https://example.com/concurrency#readers)",
	citations: [
		{
			source: "https://example.com/concurrency#readers",
			sourceType: "web",
			sourceNumber: 7,
		},
	],
};

const report: ComponentProps<typeof ResearchReportCard>["report"] = {
	title: "Synthetic concurrency review",
	executiveSummary: "Compare reader and writer behavior.",
	sections: [section],
	methodology: "Synthetic fixture only.",
	citedSources: [
		{
			source: "https://example.com/concurrency#readers",
			sourceType: "web",
			sourceNumber: 7,
		},
		{ source: "Release checklist", sourceType: "rag", sourceNumber: 3 },
	],
};

describe("ResearchReportCard", () => {
	it("renders the structured report's served model", () => {
		render(
			<ResearchReportCard
				report={{
					...report,
					model: { id: "example-report-served", viaPlan: false },
				}}
			/>,
		);
		expect(
			screen.getByText("Answered by example-report-served"),
		).toBeInTheDocument();
	});
	it("renders section Markdown and keeps supplied citation numbers and workspace sources", () => {
		const { container } = render(<ResearchReportCard report={report} />);
		expect(container.querySelector("strong")?.textContent).toBe(
			"Reader snapshots",
		);
		expect(
			screen.getAllByRole("listitem").map((item) => item.textContent),
		).toEqual(["Read the draft.", "Compare the marker."]);
		expect(container.textContent).not.toContain("**");
		const link = screen.getByRole("link", { name: "Official reference" });
		expect(link.getAttribute("href")).toBe(
			"https://example.com/concurrency#readers",
		);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(screen.getByText("[7]", { exact: true })).toBeDefined();

		fireEvent.click(
			screen.getByRole("button", { name: "All Sources (2)" }),
		);
		expect(screen.getByText("Release checklist")).toBeDefined();
		expect(screen.getByText("[3]", { exact: true })).toBeDefined();
		expect(screen.getAllByText("[7]", { exact: true })).toHaveLength(2);
		expect(screen.queryByText("[1]", { exact: true })).toBeNull();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Concurrency comparison 1 source",
			}),
		);
		expect(
			screen.queryByRole("link", { name: "Official reference" }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Concurrency comparison 1 source",
			}),
		);
		expect(
			screen.getByRole("link", { name: "Official reference" }),
		).toBeDefined();
	});

	it("keeps untrusted raw HTML inert and strips unsafe Markdown link destinations", () => {
		const { container } = render(
			<ResearchReportCard
				report={{
					...report,
					sections: [
						{
							...section,
							content:
								'<script>window.researchInjected = true</script>\n\n<img src="x" onerror="window.researchInjected = true">\n\n![beacon](https://example.com/tracker.png)\n\n[Unsafe](javascript:alert%281%29)',
						},
					],
				}}
			/>,
		);
		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("[onerror]")).toBeNull();
		const unsafe = within(container).getByText("Unsafe").closest("a");
		expect(unsafe).not.toBeNull();
		expect(unsafe?.getAttribute("href")).toBe("");
	});
});
