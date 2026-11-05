import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-query-utils", () => {
	const mutation = { mutationOptions: (value: unknown) => value };
	return {
		orpc: {
			reports: {
				templates: {
					list: { key: () => ["templates"] },
					archive: mutation,
					unarchive: mutation,
				},
			},
		},
	};
});
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@saas/reports/components/PublishReportTemplateDialog", () => ({
	PUBLISH_ACTION_LABEL: {},
	PublishReportTemplateDialog: () => null,
}));
vi.mock("@saas/reports/components/ReportTemplateDefaultsDialog", () => ({
	ReportTemplateDefaultsDialog: () => null,
}));
vi.mock("@saas/reports/components/ReportTemplatePreview", () => ({
	ReportTemplatePreview: ({ templateId }: { templateId: string }) => (
		<div>Preview of {templateId}</div>
	),
}));

import { ProjectReportTemplatesList } from "@saas/reports/components/ProjectReportTemplatesList";
import type { ReportSuiteCapabilities } from "@saas/reports/lib/project-report-suite";

const template = {
	id: "example-template",
	name: "Example status",
	description: "An example",
	heroEmojis: [],
	category: null,
	tags: [],
	scope: "SYSTEM" as const,
	userId: null,
	organizationId: null,
	archivedAt: null,
	isPublic: true,
	isGeneric: true,
	proven: true,
};
const EDITOR = {
	isPlatformAdmin: false,
	isOrganizationAdmin: false,
	canEditProjectReports: true,
};
const VIEWER = { ...EDITOR, canEditProjectReports: false };

function show(
	capabilities: ReportSuiteCapabilities = EDITOR,
	generatingTemplateId: string | null = null,
	known = true,
) {
	const onGenerate = vi.fn();
	render(
		<ProjectReportTemplatesList
			templates={[template]}
			capabilities={capabilities}
			capabilitiesKnown={known}
			viewerUserId="example-user"
			reportTemplatesPath="/app/example-org/report-templates"
			projectId="example-project"
			organizationId="example-org"
			showArchived={false}
			onShowArchivedChange={vi.fn()}
			showUnproven={false}
			onShowUnprovenChange={vi.fn()}
			onGenerate={onGenerate}
			generatingTemplateId={generatingTemplateId}
		/>,
	);
	return onGenerate;
}

describe("ProjectReportTemplatesList", () => {
	it("generates in one click for someone who may add reports", () => {
		const onGenerate = show();

		fireEvent.click(
			screen.getByRole("button", { name: "Generate report" }),
		);

		expect(onGenerate).toHaveBeenCalledWith(template);
		expect(screen.queryByText(/Viewing only/)).toBeNull();
	});

	it("keeps focus on the active Generate and ignores clicks while it runs", () => {
		const onGenerate = show(EDITOR, "example-template");

		const active = screen.getByRole("button", { name: "Generating..." });
		expect(active).toHaveAttribute("aria-disabled", "true");
		expect(active).not.toBeDisabled();
		expect(screen.getByRole("status")).toHaveTextContent(
			"Generating a report: Example status.",
		);

		fireEvent.click(active);

		expect(onGenerate).not.toHaveBeenCalled();
	});

	it("says nothing in the status region until a generation runs", () => {
		show();

		expect(screen.getByRole("status")).toBeEmptyDOMElement();
	});

	it("opens no dialog over a generation whose answer can open one", () => {
		show(EDITOR, "example-template");

		expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Defaults" })).toBeDisabled();
	});

	it("tells a Viewer with an Editor row that the organization role is what stops them", () => {
		show({ ...VIEWER, canSetProjectDefaults: true });

		expect(screen.getByText(/your organization role/)).toBeTruthy();
		expect(screen.queryByText(/needs the Editor role/)).toBeNull();
	});

	it("shows anyone who may read the template its prompts in the preview", () => {
		render(
			<ProjectReportTemplatesList
				templates={[
					{
						...template,
						definition: {
							aiAgents: [
								{
									agentId: "default",
									task: "Example task prompt",
								},
							],
						},
						fabricConfig: {
							defaultSystemPrompt: "Example system prompt",
						},
					},
				]}
				capabilities={VIEWER}
				capabilitiesKnown
				viewerUserId="example-user"
				reportTemplatesPath="/app/example-org/report-templates"
				projectId="example-project"
				organizationId="example-org"
				showArchived={false}
				onShowArchivedChange={vi.fn()}
				showUnproven={false}
				onShowUnprovenChange={vi.fn()}
				onGenerate={vi.fn()}
				generatingTemplateId={null}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Preview" }));

		expect(screen.getByText("Example task prompt")).toBeTruthy();
		expect(screen.getByText("Example system prompt")).toBeTruthy();
	});

	it("offers Defaults to a Viewer with an Editor project row, who may set them but not add reports", () => {
		show({ ...VIEWER, canSetProjectDefaults: true });

		expect(screen.getByRole("button", { name: "Defaults" })).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Generate report" }),
		).toBeNull();
	});

	it("offers no Defaults to a plain Viewer", () => {
		show({ ...VIEWER, canSetProjectDefaults: false });

		expect(screen.queryByRole("button", { name: "Defaults" })).toBeNull();
	});

	it("gives a viewer a clear state instead of a dead control", () => {
		show(VIEWER);

		expect(
			screen.queryByRole("button", { name: "Generate report" }),
		).toBeNull();
		expect(screen.getByText(/Viewing only/)).toBeTruthy();
	});

	it("says nothing about the role until it has loaded", () => {
		show(VIEWER, null, false);

		expect(screen.queryByText(/Viewing only/)).toBeNull();
	});

	it("offers a viewer the preview of every template", () => {
		show(VIEWER);

		fireEvent.click(screen.getByRole("button", { name: "Preview" }));

		expect(screen.getByText("Preview of example-template")).toBeTruthy();
	});
});
