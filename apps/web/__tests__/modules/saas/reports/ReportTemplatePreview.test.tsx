import { ORPCError } from "@orpc/client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryState = {
	data?: unknown;
	error?: unknown;
	isPending?: boolean;
	isSuccess?: boolean;
	isError?: boolean;
	isFetching?: boolean;
};

const m = vi.hoisted(() => ({
	preview: {} as QueryState,
	sample: {} as QueryState,
	sampleInput: undefined as unknown,
	sampleOptions: undefined as
		| { queryKey: unknown[]; enabled: boolean; retry: unknown }
		| undefined,
	refetchSample: vi.fn(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: () => "/app/example-org/projects",
}));

vi.mock("@saas/reports/components/ReportArtifactContent", () => ({
	ReportArtifactContent: ({ content }: { content: string }) => (
		<div>{content}</div>
	),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		reports: {
			templates: {
				preview: { queryOptions: () => ({ queryKey: ["preview"] }) },
				sample: {
					queryOptions: ({ input }: { input: unknown }) => {
						m.sampleInput = input;
						return { queryKey: ["sample-with-project", input] };
					},
					queryKey: ({ input }: { input: unknown }) => [
						"sample",
						input,
					],
				},
			},
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: {
		queryKey: unknown[];
		enabled: boolean;
		retry: unknown;
	}) => {
		switch (options.queryKey[0]) {
			case "preview":
				return { refetch: vi.fn(), ...m.preview };
			default:
				m.sampleOptions = options;
				return { refetch: m.refetchSample, ...m.sample };
		}
	},
}));

import { ReportTemplatePreview } from "@saas/reports/components/ReportTemplatePreview";

beforeEach(() => {
	vi.clearAllMocks();
	m.preview = { data: { run: null }, isPending: false, isSuccess: true };
	m.sample = {};
	m.sampleInput = undefined;
	m.sampleOptions = undefined;
});

function show() {
	render(
		<ReportTemplatePreview
			templateId="template-1"
			projectId="project-1"
			organizationId="example-org"
		/>,
	);
}

describe("ReportTemplatePreview sample", () => {
	it("asks for a sample as soon as a template without a report opens", () => {
		show();

		expect(m.sampleOptions?.enabled).toBe(true);
		expect(m.sampleOptions?.retry).toBe(false);
		// The project goes with every request: the API decides whether the
		// sample is stored, and a reader gets one either way...
		expect(m.sampleInput).toEqual({
			templateId: "template-1",
			organizationId: "example-org",
			projectId: "project-1",
		});
		// ...but the stored sample is the template's, cached without it.
		expect(m.sampleOptions?.queryKey).toEqual([
			"sample",
			{ templateId: "template-1", organizationId: "example-org" },
		]);
	});

	it("asks for no sample when an earlier report can be shown", () => {
		m.preview = {
			data: {
				run: {
					instanceName: "Example report",
					completedAt: null,
					artifact: { name: "report.md", content: "Real report" },
				},
			},
			isPending: false,
			isSuccess: true,
		};
		show();

		expect(m.sampleOptions?.enabled).toBe(false);
		expect(screen.getByText("Real report")).toBeInTheDocument();
	});

	it("shows the sample labelled as sample data", () => {
		m.sample = {
			data: { content: "Invented sprint summary" },
			isSuccess: true,
		};
		show();

		expect(screen.getByText("Sample data")).toBeInTheDocument();
		expect(screen.getByText("Invented sprint summary")).toBeInTheDocument();
	});

	it("offers Try again after a failed sample, without retrying on its own", async () => {
		const user = userEvent.setup();
		m.sample = {
			isError: true,
			error: new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "The sample report could not be written. Try again.",
			}),
		};
		show();

		expect(screen.getByRole("alert")).toHaveTextContent(
			"The sample report could not be written.",
		);
		expect(m.refetchSample).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: /Try again/ }));
		expect(m.refetchSample).toHaveBeenCalledTimes(1);
	});
});
