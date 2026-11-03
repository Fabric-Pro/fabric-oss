/**
 * A structured research report is saved as a research artifact once it
 * shows, unless the viewer is told not to (a result reopened from a saved
 * conversation, whose artifact was saved when it first showed).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	create: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		artifacts: {
			create: (...args: unknown[]) => m.create(...args),
			attachToProject: vi.fn(),
		},
	},
}));
vi.mock("../../FabricChat/cards/ResearchReportCard", () => ({
	ResearchReportCard: () => <div data-testid="research-report" />,
}));

import { WorkflowResultViewer } from "../WorkflowResultViewer";

const RESULT = {
	reportModel: { id: "example-report-served", viaPlan: false },
	text: "The full research text.",
	summary: "A short summary.",
	keyFindings: [],
	sources: [],
	iterations: 1,
	goalAchieved: true,
	duration: 4200,
	structuredReport: {
		title: "Market research",
		executiveSummary: "The market grew.",
		sections: [],
		methodology: "Two sub-agents searched the web.",
		citedSources: [],
	},
};

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			{children}
		</QueryClientProvider>
	);
}

beforeEach(() => {
	m.create.mockReset();
	m.create.mockResolvedValue({ artifact: { id: "artifact-1" } });
});

describe("WorkflowResultViewer — saving the report", () => {
	it("saves a structured report as an artifact once by default", async () => {
		const { rerender } = render(
			<WorkflowResultViewer
				result={RESULT}
				organizationId="org_example"
			/>,
			{ wrapper },
		);

		await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
		expect(m.create).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "RESEARCH_REPORT",
				title: "Market research",
				organizationId: "org_example",
				metadata: expect.objectContaining({
					model: RESULT.reportModel,
				}),
			}),
		);
		rerender(
			<WorkflowResultViewer
				result={RESULT}
				organizationId="org_example"
			/>,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(m.create).toHaveBeenCalledTimes(1);
	});

	it("saves nothing with persistArtifact={false}", async () => {
		render(
			<WorkflowResultViewer
				result={RESULT}
				organizationId="org_example"
				persistArtifact={false}
			/>,
			{ wrapper },
		);

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(m.create).not.toHaveBeenCalled();
	});
});

describe("WorkflowResultViewer — source links", () => {
	it("links only absolute HTTP sources while retaining labels, order and expansion", () => {
		const sources = [
			"https://secure.example.com/reference",
			"http://plain.example.com/reference",
			"The reference documentation",
			"/relative-reference",
			"https://",
			"javascript:alert(1)",
			"data:text/plain,reference",
			"ftp://files.example.com/reference",
		];
		render(
			<WorkflowResultViewer
				result={{
					...RESULT,
					text: null,
					summary: null,
					structuredReport: null,
					sources,
				}}
				persistArtifact={false}
			/>,
			{ wrapper },
		);

		expect(screen.getByText("Sources (8)")).toBeDefined();
		expect(
			screen
				.getAllByRole("link")
				.map((link) => link.getAttribute("href")),
		).toEqual(sources.slice(0, 2));
		expect(screen.queryByText(sources[5])).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Show 3 more sources" }),
		);
		expect(screen.getAllByRole("link")).toHaveLength(2);
		const displayedSources = [
			"secure.example.com",
			"plain.example.com",
			...sources.slice(2),
		].map((label) => screen.getByText(label));
		let previous: HTMLElement | undefined;
		for (const source of displayedSources) {
			if (previous) {
				expect(
					previous.compareDocumentPosition(source) &
						Node.DOCUMENT_POSITION_FOLLOWING,
				).toBeTruthy();
			}
			previous = source;
		}
		fireEvent.click(screen.getByRole("button", { name: "Show less" }));
		expect(screen.queryByText(sources[5])).toBeNull();
		expect(
			screen.getByRole("button", { name: "Show 3 more sources" }),
		).toBeDefined();
		expect(m.create).not.toHaveBeenCalled();
	});
});
