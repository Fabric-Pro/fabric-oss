/**
 * Tests for the Document Pipeline section of ProjectOverview.
 *
 * Covers the dynamic-sourcing + overflow behaviour (plan
 * docs/plans/2026-07-07-001-feat-document-pipeline-overflow-plan.md, U1/U2):
 * empty state, real titles + correct type labels, status badges, the 6-card
 * cap, and the "View More" -> Documents-tab navigation.
 *
 * The two heavy child components are stubbed so the test isolates the section.
 * next-intl is mocked globally in apps/web/vitest.setup.ts.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ProjectSectionHero", () => ({
	ProjectSectionHero: () => null,
}));
vi.mock("../ProjectSectionEditDialog", () => ({
	ProjectSectionEditDialog: () => null,
}));

import { ProjectOverview } from "../ProjectOverview";

type Doc = {
	id: string;
	type: string;
	title: string;
	status: string;
	isActive?: boolean;
};

function makeProject(documents: Doc[]) {
	return {
		id: "p1",
		name: "Test Project",
		description: null,
		projectTypes: [] as string[],
		techStack: [] as string[],
		features: [] as string[],
		goals: null,
		documents,
		_count: { documents: documents.length, contexts: 0 },
	};
}

function renderOverview(
	documents: Doc[],
	onNavigateToTab?: (tabId: string) => void,
) {
	return render(
		<ProjectOverview
			project={makeProject(documents)}
			projectId="p1"
			onNavigateToTab={onNavigateToTab}
		/>,
	);
}

describe("ProjectOverview — Document Pipeline", () => {
	it("shows an empty state when the project has no documents", () => {
		renderOverview([]);
		expect(screen.getByText("No documents yet")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /view more/i }),
		).not.toBeInTheDocument();
	});

	it("renders a card per document with its real title and correct type label", () => {
		renderOverview([
			{
				id: "d1",
				type: "PROPOSAL",
				title: "My Proposal Doc",
				status: "DRAFT",
			},
		]);
		expect(screen.getByText("My Proposal Doc")).toBeInTheDocument();
		expect(screen.getByText("Proposal")).toBeInTheDocument();
		// The old preset mislabelled PROPOSAL as "Frontend Design".
		expect(screen.queryByText("Frontend Design")).not.toBeInTheDocument();
	});

	it("shows the correct status badge for each document", () => {
		renderOverview([
			{ id: "d1", type: "PRD", title: "Ready Doc", status: "COMPLETE" },
			{
				id: "d2",
				type: "ARCHITECTURE",
				title: "Draft Doc",
				status: "DRAFT",
			},
		]);
		expect(screen.getByText("Ready")).toBeInTheDocument();
		expect(screen.getByText("Pending")).toBeInTheDocument();
	});

	it("renders all cards and no View More control at or below the threshold", () => {
		renderOverview([
			{ id: "d1", type: "PRD", title: "Alpha", status: "DRAFT" },
			{ id: "d2", type: "ARCHITECTURE", title: "Beta", status: "DRAFT" },
			{ id: "d3", type: "USER_STORY", title: "Gamma", status: "DRAFT" },
		]);
		expect(screen.getByText("Alpha")).toBeInTheDocument();
		expect(screen.getByText("Beta")).toBeInTheDocument();
		expect(screen.getByText("Gamma")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /view more/i }),
		).not.toBeInTheDocument();
	});

	it("caps at 6 cards and shows a View More control when there are more", () => {
		const docs: Doc[] = Array.from({ length: 8 }, (_, i) => ({
			id: `d-${i}`,
			type: "GENERAL",
			title: `Doc ${i}`,
			status: "DRAFT",
		}));
		renderOverview(docs);

		// Same-type docs keep input order, so the first 6 are visible.
		expect(screen.getByText("Doc 0")).toBeInTheDocument();
		expect(screen.getByText("Doc 5")).toBeInTheDocument();
		expect(screen.queryByText("Doc 6")).not.toBeInTheDocument();
		expect(screen.queryByText("Doc 7")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /view more/i }),
		).toBeInTheDocument();
	});

	it("navigates to the Documents tab when View More is clicked", async () => {
		const onNavigateToTab = vi.fn();
		const docs: Doc[] = Array.from({ length: 8 }, (_, i) => ({
			id: `d-${i}`,
			type: "GENERAL",
			title: `Doc ${i}`,
			status: "DRAFT",
		}));
		renderOverview(docs, onNavigateToTab);

		await userEvent.click(
			screen.getByRole("button", { name: /view more/i }),
		);
		expect(onNavigateToTab).toHaveBeenCalledWith("documents");
	});

	it("shows the Active badge for in-flight documents", () => {
		renderOverview([
			{
				id: "d1",
				type: "PRD",
				title: "Generating Doc",
				status: "GENERATING",
			},
			{
				id: "d2",
				type: "ARCHITECTURE",
				title: "In Progress Doc",
				status: "IN_PROGRESS",
			},
		]);
		expect(screen.getAllByText("Active")).toHaveLength(2);
	});

	it("renders all six cards with no View More at exactly the threshold", () => {
		const docs: Doc[] = Array.from({ length: 6 }, (_, i) => ({
			id: `d-${i}`,
			type: "GENERAL",
			title: `Doc ${i}`,
			status: "DRAFT",
		}));
		renderOverview(docs);
		for (let i = 0; i < 6; i++) {
			expect(screen.getByText(`Doc ${i}`)).toBeInTheDocument();
		}
		expect(
			screen.queryByRole("button", { name: /view more/i }),
		).not.toBeInTheDocument();
	});
});
