import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryImportPanel } from "../RepositoryImportPanel";

const state: { run: unknown } = { run: null };
const applied = vi.fn();

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/example-org" }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			repositoryImport: {
				get: {
					queryOptions: () => ({
						queryKey: ["repositoryImport", "get"],
						queryFn: async () => ({ run: state.run }),
					}),
					key: () => ["repositoryImport", "get"],
				},
				apply: {
					mutationOptions: () => ({
						mutationFn: async (input: unknown) => {
							applied(input);
							return { run: null };
						},
					}),
				},
				start: {
					mutationOptions: () => ({ mutationFn: async () => ({}) }),
				},
			},
		},
	},
}));

const findings = {
	repository: {
		name: "example/app",
		branch: "main",
		url: "https://example.com",
	},
	profile: { fileCount: 10, documentCount: 4, kind: "mixed" },
	stack: [
		{ name: "React", category: "framework", evidence: ["package.json"] },
	],
	summary: {
		description: "A booking app.",
		goals: "",
		features: [],
		generated: false,
	},
	documents: [
		{
			path: "SPEC.md",
			title: "Product Specification",
			kind: "document",
			documentType: "PRD",
			reason: "Named a prd.",
			destination: "document",
		},
		{
			path: "notes/queue.md",
			title: "Queue",
			kind: "backlog",
			reason: "3 open task items.",
			destination: "backlog",
			itemCount: 3,
		},
	],
	aiFileCount: 2,
	contextSyncConfigured: false,
};

const steps = [
	{ key: "connect", status: "DONE", detail: "The repository is connected." },
	{ key: "review", status: "RUNNING", detail: "Waiting for your review." },
];

function renderPanel() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<RepositoryImportPanel projectId="p1" organizationId="org_1" />
		</QueryClientProvider>,
	);
}

describe("RepositoryImportPanel", () => {
	beforeEach(() => {
		applied.mockClear();
		state.run = null;
	});

	it("shows nothing for a project that was never imported", async () => {
		const { container } = renderPanel();
		await waitFor(() => expect(container).toBeEmptyDOMElement());
	});

	it("shows the checklist and sends the reviewed selection", async () => {
		state.run = {
			id: "r1",
			status: "REVIEW",
			steps,
			findings,
			error: null,
		};
		renderPanel();
		expect(
			await screen.findByText("Importing example/app"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Waiting for your review."),
		).toBeInTheDocument();
		expect(
			screen.getByText(/SPEC\.md · Product requirements/),
		).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Where notes/queue.md goes"), {
			target: { value: "skip" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Create in Fabric" }),
		);

		await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
		expect(applied.mock.calls[0]?.[0]).toMatchObject({
			runId: "r1",
			selection: {
				projectFields: { description: true, techStack: true },
				documents: [
					{ path: "SPEC.md", destination: "document" },
					{ path: "notes/queue.md", destination: "skip" },
				],
			},
		});
	});

	it("ends with a guide to where each kind of work lives now", async () => {
		state.run = {
			id: "r1",
			status: "COMPLETED",
			steps,
			error: null,
			findings: {
				...findings,
				applied: {
					projectFields: true,
					documents: 1,
					contextPaths: 0,
					contextSynced: false,
					contexts: 0,
					decisions: 0,
					backlogProposals: 1,
					backlogItems: 3,
					knowledge: 0,
					failed: 0,
				},
			},
		};
		renderPanel();
		expect(
			await screen.findByText("How to work from now on"),
		).toBeInTheDocument();
		expect(screen.getByText(/not in notes\/queue\.md/)).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Move 2 AI files out" }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/p1?tab=coding-instructions&consolidate=1",
		);
		expect(screen.queryByText("Reference docs")).not.toBeInTheDocument();
	});

	it("does not offer to move AI files when instructions come from another repository", async () => {
		state.run = {
			id: "r1",
			status: "COMPLETED",
			steps,
			error: null,
			findings: {
				...findings,
				instructionsRepository: "example-org/ai-rules",
				applied: {
					projectFields: true,
					documents: 1,
					contextPaths: 0,
					contextSynced: false,
					contexts: 0,
					decisions: 0,
					backlogProposals: 0,
					backlogItems: 0,
					knowledge: 0,
					failed: 0,
				},
			},
		};
		renderPanel();
		expect(
			await screen.findByText("How to work from now on"),
		).toBeInTheDocument();
		expect(
			screen.getByText("example-org/ai-rules, changed through Fabric."),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /AI files out/ }),
		).not.toBeInTheDocument();
	});
});
