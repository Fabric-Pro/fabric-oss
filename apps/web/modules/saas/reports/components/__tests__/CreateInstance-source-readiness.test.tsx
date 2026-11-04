import type { ReportEvidenceConfig } from "@repo/database/prisma/queries/lib/report-evidence";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
	const value: Record<string, unknown> = {};
	return { template: { value }, mutate: vi.fn() };
});
vi.mock("@saas/organizations/hooks", () => ({
	useContextPath: () => "/app/example-org/mcp-servers",
	useOrganizationContext: () => ({
		organizationId: "example-org",
		loaded: true,
	}),
	useEffectiveOrganizationId: () => "example-org",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));
vi.mock("@saas/projects/lib/pm-tool-analyzer", () => ({
	analyzePMToolCapabilities: vi.fn(),
	fetchContainersWithHierarchy: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));
vi.mock("@shared/lib/orpc-query-utils", () => {
	const query = (key: string) => ({
		queryOptions: () => ({ queryKey: [key] }),
	});
	return {
		orpc: {
			reports: {
				templates: { get: query("template") },
				instances: {
					list: query("instances"),
					get: query("instance"),
					create: { mutationOptions: (value: unknown) => value },
				},
			},
			mcp: { configs: { list: query("mcp") } },
			projects: { get: query("project") },
			documentWorkspaces: { list: query("workspaces") },
			workflows: { integrations: { list: query("integrations") } },
		},
	};
});
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey }: { queryKey: string[] }) => ({
		data: queryKey[0] === "template" ? m.template.value : undefined,
		isLoading: false,
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ mutate: m.mutate, isPending: false }),
}));
vi.mock("../ReportEvidenceSettings", () => ({
	ReportEvidenceSettings: ({
		onChange,
	}: {
		onChange: (value: ReportEvidenceConfig) => void;
	}) => (
		<button
			type="button"
			onClick={() =>
				onChange({
					version: 1,
					period: "monthly",
					timezone: "UTC",
					weekStartsOn: 1,
					calendar: "calendar",
					fiscalYearStartMonth: 1,
					comparison: "none",
					partialData: "allow_with_notice",
					publication: "draft",
					projectId: "example-project",
				})
			}
		>
			Choose example project
		</button>
	),
}));

import { CreateInstanceDialog } from "../CreateInstanceDialog";
import { CreateInstanceForm } from "../CreateInstanceForm";

const projectSource = {
	id: "knowledge",
	type: "fabric",
	provider: "fabric_project",
	operation: "project_knowledge",
	config: {},
};
const externalSource = {
	id: "external",
	type: "mcp",
	provider: "github",
	operation: "list_issues",
	config: {},
};
function template(sources: (typeof projectSource)[]) {
	return {
		id: "example-template",
		name: "Example delivery",
		description: null,
		templateType: "CUSTOM",
		outputFormat: "MARKDOWN",
		definition: { dataSources: sources },
	};
}

beforeEach(() => {
	m.mutate.mockClear();
});
describe.each(["form", "dialog"])("%s source readiness", (surface) => {
	function show(sources: (typeof projectSource)[]) {
		const value = template(sources);
		m.template.value = value;
		if (surface === "form") {
			render(
				<CreateInstanceForm
					templateId={value.id}
					organizationId="example-org"
				/>,
			);
		} else {
			render(
				<CreateInstanceDialog
					template={value}
					organizationId="example-org"
					onClose={vi.fn()}
				/>,
			);
		}
		fireEvent.click(
			screen.getByRole("button", { name: "Choose example project" }),
		);
	}
	it("offers creation of a ready Project knowledge report with an accurate shared source scope", () => {
		show([projectSource]);
		const create = screen.getByRole("button", {
			name: "Create report",
			exact: true,
		});
		expect(create).toBeEnabled();
		expect(
			screen.queryByRole("button", { name: "Create draft" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/Imported files and private notes are excluded/),
		).toBeInTheDocument();
		fireEvent.click(create);
		expect(m.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				templateId: "example-template",
				organizationId: "example-org",
				reporting: expect.objectContaining({
					projectId: "example-project",
					publication: "draft",
				}),
				connections: expect.objectContaining({
					mcpConfigs: [],
					workspaces: [],
				}),
			}),
		);
	});
	it("leaves the template's own prompt out of the report, so template edits still reach it", () => {
		const value = {
			...template([projectSource]),
			definition: {
				dataSources: [projectSource],
				userPrompt: "Summarize delivery for the period.",
			},
		};
		m.template.value = value;
		if (surface === "form") {
			render(
				<CreateInstanceForm
					templateId={value.id}
					organizationId="example-org"
				/>,
			);
		} else {
			render(
				<CreateInstanceDialog
					template={value}
					organizationId="example-org"
					onClose={vi.fn()}
				/>,
			);
		}
		fireEvent.click(
			screen.getByRole("button", { name: "Choose example project" }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Create report", exact: true }),
		);
		expect(m.mutate).toHaveBeenCalledTimes(1);
		const [{ connections }] = m.mutate.mock.calls[0];
		expect(connections).not.toHaveProperty("promptOverride");
		expect(connections).not.toHaveProperty("promptOverrideSource");
	});
	it("keeps mixed external project sources as a setup-required draft", () => {
		show([projectSource, externalSource]);
		expect(
			screen.getByRole("button", { name: "Create draft", exact: true }),
		).toBeEnabled();
		expect(
			screen.queryByRole("button", { name: "Create report" }),
		).not.toBeInTheDocument();
	});
});
