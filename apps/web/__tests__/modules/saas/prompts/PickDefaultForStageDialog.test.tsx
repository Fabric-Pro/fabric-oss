import { PickDefaultForStageDialog } from "@saas/prompts/components/PickDefaultForStageDialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listPrompts, bindSet, createNomination, isOrgAdmin } = vi.hoisted(
	() => ({
		listPrompts: vi.fn(),
		bindSet: vi.fn(),
		createNomination: vi.fn(),
		isOrgAdmin: { current: true },
	}),
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			list: (input: unknown) => listPrompts(input),
			bind: {
				set: (input: unknown) => bindSet(input),
			},
			nominations: {
				create: (input: unknown) => createNomination(input),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		isOrganizationAdmin: isOrgAdmin.current,
	}),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			list: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["prompts.list", input],
					queryFn: () => listPrompts(input),
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

describe("PickDefaultForStageDialog", () => {
	beforeEach(() => {
		listPrompts.mockReset();
		bindSet.mockReset();
		createNomination.mockReset();
		isOrgAdmin.current = true;
		listPrompts.mockResolvedValue({
			prompts: [
				{
					id: "p1",
					name: "Feature Brief",
					scope: "SYSTEM",
					versions: [{ id: "ver-p1", version: 2 }],
				},
				{
					id: "p2",
					name: "Custom Draft",
					scope: "USER",
					versions: [{ id: "ver-p2", version: 1 }],
				},
			],
			total: 2,
		});
	});

	it("loads prompts and renders one row per prompt", async () => {
		wrap(
			<PickDefaultForStageDialog
				open
				documentType="DRAFT"
				stageLabel="Draft"
				storyKind="FEATURE"
				organizationId={null}
				onOpenChange={vi.fn()}
				onBound={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("Feature Brief")).toBeInTheDocument();
			expect(screen.getByText("Custom Draft")).toBeInTheDocument();
		});
	});

	it("calls bind.set with the right payload and closes on confirm (personal context)", async () => {
		bindSet.mockResolvedValue({ id: "b-new" });
		const onOpenChange = vi.fn();
		const onBound = vi.fn();

		wrap(
			<PickDefaultForStageDialog
				open
				documentType="PLACEHOLDER"
				stageLabel="Placeholder"
				storyKind="FEATURE"
				organizationId={null}
				onOpenChange={onOpenChange}
				onBound={onBound}
			/>,
		);

		await waitFor(() => screen.getByText("Feature Brief"));
		await userEvent.click(screen.getByText("Feature Brief"));
		await userEvent.click(
			screen.getByRole("button", { name: /^Set default$/i }),
		);

		await waitFor(() => {
			expect(bindSet).toHaveBeenCalledWith({
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentType: "PLACEHOLDER",
				storyKind: "FEATURE",
				scope: "USER",
				organizationId: null,
				promptVersionId: "ver-p1",
				isDefault: true,
			});
			expect(onBound).toHaveBeenCalled();
			expect(onOpenChange).toHaveBeenCalledWith(false);
		});
	});

	it("defaults to a PERSONAL binding in organization context", async () => {
		// Fizzy #2068 review F10: this dialog used to hardcode ORG scope, so a
		// member picking their own prompt was refused outright and nobody could
		// reach the personal tier from here at all.
		bindSet.mockResolvedValue({ id: "b-new" });

		wrap(
			<PickDefaultForStageDialog
				open
				documentType="DRAFT"
				stageLabel="Draft"
				storyKind="FEATURE"
				organizationId="org-1"
				onOpenChange={vi.fn()}
				onBound={vi.fn()}
			/>,
		);

		await waitFor(() => screen.getByText("Custom Draft"));
		await userEvent.click(screen.getByText("Custom Draft"));
		expect(
			screen.getByRole("combobox", { name: /scope/i }),
		).toHaveTextContent(/Personal/i);
		await userEvent.click(
			screen.getByRole("button", { name: /^Set default$/i }),
		);

		await waitFor(() => {
			expect(bindSet).toHaveBeenCalledWith({
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentType: "DRAFT",
				storyKind: "FEATURE",
				scope: "USER",
				organizationId: null,
				promptVersionId: "ver-p2",
				isDefault: true,
			});
		});
	});

	it("binds at Organization scope once it is chosen", async () => {
		bindSet.mockResolvedValue({ id: "b-new" });

		wrap(
			<PickDefaultForStageDialog
				open
				documentType="DRAFT"
				stageLabel="Draft"
				storyKind="FEATURE"
				organizationId="org-1"
				onOpenChange={vi.fn()}
				onBound={vi.fn()}
			/>,
		);

		await waitFor(() => screen.getByText("Feature Brief"));
		await userEvent.click(screen.getByText("Feature Brief"));
		await userEvent.click(screen.getByRole("combobox", { name: /scope/i }));
		await userEvent.click(
			await screen.findByRole("option", { name: /Organization/i }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /^Set default$/i }),
		);

		await waitFor(() => {
			expect(bindSet).toHaveBeenCalledWith({
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentType: "DRAFT",
				storyKind: "FEATURE",
				scope: "ORG",
				organizationId: "org-1",
				promptVersionId: "ver-p1",
				isDefault: true,
			});
		});
	});

	it("proposes instead of binding when a member picks Organization scope", async () => {
		// Fizzy #2068 review F9: the same surface used to hand a member a bare
		// FORBIDDEN on submit. A shared tier they may not write is one they may
		// propose, matching SetAsDefaultDialog.
		isOrgAdmin.current = false;
		createNomination.mockResolvedValue({ id: "nom-1" });

		wrap(
			<PickDefaultForStageDialog
				open
				documentType="DRAFT"
				stageLabel="Draft"
				storyKind="BUG"
				organizationId="org-1"
				onOpenChange={vi.fn()}
				onBound={vi.fn()}
			/>,
		);

		await waitFor(() => screen.getByText("Feature Brief"));
		await userEvent.click(screen.getByText("Feature Brief"));
		await userEvent.click(screen.getByRole("combobox", { name: /scope/i }));
		await userEvent.click(
			await screen.findByRole("option", { name: /Organization/i }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /^Propose default$/i }),
		);

		await waitFor(() => {
			expect(createNomination).toHaveBeenCalledWith({
				promptVersionId: "ver-p1",
				targetScope: "ORG",
				organizationId: "org-1",
				targets: [
					{
						targetKey: "project_document_generator",
						documentType: "DRAFT",
						storyKind: "BUG",
					},
				],
			});
			expect(bindSet).not.toHaveBeenCalled();
		});
	});

	it("offers no scope choice outside an organization", async () => {
		wrap(
			<PickDefaultForStageDialog
				open
				documentType="DRAFT"
				stageLabel="Draft"
				storyKind="FEATURE"
				organizationId={null}
				onOpenChange={vi.fn()}
				onBound={vi.fn()}
			/>,
		);

		await waitFor(() => screen.getByText("Feature Brief"));
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
	});

	it("disables Set default until a prompt is selected", async () => {
		wrap(
			<PickDefaultForStageDialog
				open
				documentType="DRAFT"
				stageLabel="Draft"
				storyKind="FEATURE"
				organizationId={null}
				onOpenChange={vi.fn()}
				onBound={vi.fn()}
			/>,
		);

		await waitFor(() => screen.getByText("Feature Brief"));
		const button = screen.getByRole("button", { name: /^Set default$/i });
		expect(button).toBeDisabled();
		await userEvent.click(screen.getByText("Feature Brief"));
		expect(button).not.toBeDisabled();
	});
});
