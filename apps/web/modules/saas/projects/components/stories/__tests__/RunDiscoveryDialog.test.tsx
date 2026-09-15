import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		start: vi.fn(),
		getStatus: vi.fn(),
		contextsList: vi.fn(),
		mcpConfigsList: vi.fn(),
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: null, basePath: "/app" }),
}));

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: { resolution: { getStatus: mocks.getStatus } },
		projects: { discovery: { start: mocks.start } },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["contexts", input],
						queryFn: mocks.contextsList,
					}),
				},
			},
			discovery: {
				list: {
					queryKey: ({ input }: { input: unknown }) => [
						"runs",
						input,
					],
				},
			},
		},
		mcp: {
			configs: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["mcp", input],
						queryFn: mocks.mcpConfigsList,
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
	filterOpenApiContexts,
	RunDiscoveryDialog,
} from "../RunDiscoveryDialog";

function renderDialog(
	props: Partial<React.ComponentProps<typeof RunDiscoveryDialog>> = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const onOpenChange = vi.fn();
	const utils = render(
		<QueryClientProvider client={client}>
			<RunDiscoveryDialog
				projectId="project_1"
				storyId="story_1"
				storyIdentifier="F-007"
				hasRepository
				open
				onOpenChange={onOpenChange}
				{...props}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, onOpenChange };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getStatus.mockResolvedValue({ isConfigured: true });
	mocks.contextsList.mockResolvedValue({
		contexts: [
			{
				id: "ctx-json",
				type: "FILE",
				originalFilename: "identity.openapi.json",
				mimeType: "application/json",
			},
			{
				id: "ctx-pdf",
				type: "FILE",
				originalFilename: "brief.pdf",
				mimeType: "application/pdf",
			},
		],
		total: 2,
		hasMore: false,
	});
	mocks.mcpConfigsList.mockResolvedValue([
		{
			id: "cfg-1",
			enabled: true,
			displayName: "Jira",
			mcpServer: { name: "Jira" },
		},
		{
			id: "cfg-off",
			enabled: false,
			displayName: "Disabled",
			mcpServer: null,
		},
	]);
	mocks.start.mockResolvedValue({
		discoveryRunId: "run-1",
		workflowId: "discovery-run-run-1",
		status: "started",
	});
});

describe("filterOpenApiContexts", () => {
	it("keeps only JSON / YAML documents", () => {
		const rows = [
			{ id: "a", type: "FILE", originalFilename: "spec.yaml" },
			{ id: "b", type: "FILE", originalFilename: "spec.yml" },
			{
				id: "c",
				type: "FILE",
				originalFilename: "notes.docx",
				mimeType: "application/vnd.openxmlformats",
			},
			{ id: "d", type: "LINK", sourceTitle: "openapi.json" },
			{
				id: "e",
				type: "FILE",
				originalFilename: "x.bin",
				mimeType: "text/yaml",
			},
		];
		expect(filterOpenApiContexts(rows).map((r) => r.id)).toEqual([
			"a",
			"b",
			"d",
			"e",
		]);
	});
});

describe("RunDiscoveryDialog", () => {
	it("submits the selected sources in the discovery.start shape", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();

		// Repo is pre-selected when the project has a repository.
		const repo = screen.getByRole("checkbox", {
			name: /sources\.repo\.hint/,
		});
		expect(repo).toBeChecked();

		// OpenAPI from a URL.
		await user.click(
			screen.getByRole("radio", { name: "sources.openApi.fromUrl" }),
		);
		await user.type(
			screen.getByRole("textbox", { name: "sources.openApi.urlLabel" }),
			"https://api.example.com/openapi.json",
		);

		// Only enabled MCP configs are offered.
		await waitFor(() => {
			expect(
				screen.getByRole("checkbox", { name: "Jira" }),
			).toBeInTheDocument();
		});
		expect(
			screen.queryByRole("checkbox", { name: "Disabled" }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("checkbox", { name: "Jira" }));

		await user.click(
			screen.getByRole("button", { name: /dialog\.submit/ }),
		);

		await waitFor(() => {
			expect(mocks.start).toHaveBeenCalledWith({
				projectId: "project_1",
				storyId: "story_1",
				organizationId: null,
				sources: {
					repo: true,
					openApi: { url: "https://api.example.com/openapi.json" },
					mcpConfigIds: ["cfg-1"],
				},
			});
		});
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("disables submit until at least one source is chosen and the URL is valid", async () => {
		const user = userEvent.setup();
		renderDialog({ hasRepository: false });

		const submit = screen.getByRole("button", { name: /dialog\.submit/ });
		expect(submit).toBeDisabled();
		expect(
			screen.getByRole("checkbox", {
				name: /sources\.repo\.noRepository/,
			}),
		).toBeDisabled();

		await user.click(
			screen.getByRole("radio", { name: "sources.openApi.fromUrl" }),
		);
		await user.type(
			screen.getByRole("textbox", { name: "sources.openApi.urlLabel" }),
			"ftp://nope",
		);
		expect(
			screen.getByText("sources.openApi.urlInvalid"),
		).toBeInTheDocument();
		expect(submit).toBeDisabled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("blocks submission when no AI provider is configured", async () => {
		mocks.getStatus.mockResolvedValue({ isConfigured: false });
		renderDialog();
		await waitFor(() => {
			expect(
				screen.getByText("dialog.aiNotConfigured"),
			).toBeInTheDocument();
		});
		expect(
			screen.getByRole("button", { name: /dialog\.submit/ }),
		).toBeDisabled();
	});
});
