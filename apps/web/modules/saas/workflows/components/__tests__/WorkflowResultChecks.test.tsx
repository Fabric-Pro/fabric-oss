import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	inspect: vi.fn(),
	list: vi.fn(),
	preview: vi.fn(),
	save: vi.fn(),
	apply: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		workflows: {
			checks: {
				inspect: {
					queryOptions: ({ input }: any) => ({
						queryKey: ["inspect", input],
						queryFn: () => m.inspect(input),
					}),
				},
				list: {
					queryOptions: ({ input }: any) => ({
						queryKey: ["checks", input],
						queryFn: () => m.list(input),
					}),
					key: () => ["checks"],
				},
				preview: {
					mutationOptions: (options: any = {}) => ({
						mutationFn: m.preview,
						...options,
					}),
				},
				save: {
					mutationOptions: (options: any = {}) => ({
						mutationFn: m.save,
						...options,
					}),
				},
				apply: {
					mutationOptions: (options: any = {}) => ({
						mutationFn: m.apply,
						...options,
					}),
				},
				remove: {
					mutationOptions: (options: any = {}) => ({
						mutationFn: m.remove,
						...options,
					}),
				},
			},
		},
	},
}));

import { WorkflowResultChecks } from "../WorkflowResultChecks";

const context = {
	workflowId: "example-workflow",
	organizationId: "example-org",
	executionId: "example-candidate",
	nodeId: "draft",
};
const revision = "a".repeat(64);
const check = {
	id: "example-check",
	revision,
	name: "Delivery sections",
	nodeId: "draft",
	baselineVersion: 1,
	baselineExecutionId: "example-baseline",
};
const expectations = [{ kind: "required", phrase: "Next steps", passed: true }];
let mountedClient: QueryClient;
function mount() {
	mountedClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={mountedClient}>
			<WorkflowResultChecks {...context} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	m.inspect.mockResolvedValue({
		revision,
		recordedAnswer: "# Next steps",
		version: 2,
	});
	m.list.mockResolvedValue({ cases: [], canManage: true });
	m.preview.mockResolvedValue({ report: { status: "passed" }, expectations });
	m.save.mockResolvedValue({ check });
	m.apply.mockResolvedValue({
		baseline: { version: 1 },
		candidate: {
			version: 2,
			report: { status: "failed" },
			expectations: [{ ...expectations[0], passed: false }],
		},
		change: "regressed",
	});
	m.remove.mockResolvedValue({ removed: true });
});
it("loads evidence only on demand and saves reviewed expectations without copying the answer", async () => {
	mount();
	expect(m.inspect).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	await screen.findByLabelText(/Must include —/);
	fireEvent.change(screen.getByLabelText(/Must include —/), {
		target: { value: "Next steps" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Check recorded result" }),
	);
	await screen.findByText(/All checks passed/);
	expect(m.preview).toHaveBeenCalledWith(
		{
			...context,
			expectedRevision: revision,
			requiredPhrases: ["Next steps"],
			forbiddenPhrases: [],
		},
		expect.anything(),
	);
	fireEvent.change(screen.getByLabelText("Check name"), {
		target: { value: "Delivery sections" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save check" }));
	await waitFor(() => expect(m.save).toHaveBeenCalled());
	expect(m.save.mock.calls[0][0]).toEqual({
		...context,
		name: "Delivery sections",
		expectedRevision: revision,
		requiredPhrases: ["Next steps"],
		forbiddenPhrases: [],
	});
});
it("requires a new preview when expectations change", async () => {
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	await screen.findByLabelText(/Must include —/);
	fireEvent.change(screen.getByLabelText(/Must include —/), {
		target: { value: "Next steps" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Check recorded result" }),
	);
	await screen.findByLabelText("Check name");
	fireEvent.change(screen.getByLabelText(/Must include —/), {
		target: { value: "Risks" },
	});
	expect(
		screen.queryByRole("button", { name: "Save check" }),
	).not.toBeInTheDocument();
});
it("compares a saved check against the selected real run and explains a regression", async () => {
	m.list.mockResolvedValue({ cases: [check], canManage: true });
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Compare with baseline" }),
	);
	await screen.findByText(/A previously passing check now fails/);
	expect(m.apply.mock.calls[0][0]).toEqual({
		workflowId: context.workflowId,
		organizationId: context.organizationId,
		executionId: context.executionId,
		checkId: check.id,
		expectedCaseRevision: revision,
	});
	expect(
		screen.getByText(/Review the workflow’s instructions or context/),
	).toBeVisible();
	expect(
		screen.getByText(/No workflow, model or external service/),
	).toBeVisible();
});
it("requires explicit removal confirmation", async () => {
	m.list.mockResolvedValue({ cases: [check], canManage: true });
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Remove saved check" }),
	);
	expect(m.remove).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("button", { name: "Remove check", exact: true }),
	);
	await waitFor(() => expect(m.remove).toHaveBeenCalled());
});
it("offers retry if evidence cannot be read", async () => {
	m.inspect.mockRejectedValueOnce(new Error("Result unavailable"));
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	await screen.findByRole("alert");
	fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	await screen.findByLabelText(/Must include —/);
	expect(m.inspect).toHaveBeenCalledTimes(2);
});
it("does not redirect a pending removal to another check after a list refresh", async () => {
	m.list.mockResolvedValue({ cases: [check], canManage: true });
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Remove saved check" }),
	);
	expect(
		screen.getByRole("button", { name: "Remove check", exact: true }),
	).toBeVisible();
	m.list.mockResolvedValue({
		cases: [
			{
				...check,
				id: "example-other-check",
				name: "Another check",
				revision: "b".repeat(64),
			},
		],
		canManage: true,
	});
	await mountedClient.invalidateQueries({ queryKey: ["checks"] });
	await waitFor(() =>
		expect(
			screen.queryByRole("button", { name: "Remove check", exact: true }),
		).not.toBeInTheDocument(),
	);
	expect(m.remove).not.toHaveBeenCalled();
});
it("keeps significant whitespace in phrases entered in the Portal", async () => {
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	await screen.findByLabelText(/Must include —/);
	fireEvent.change(screen.getByLabelText(/Must include —/), {
		target: { value: "TODO " },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Check recorded result" }),
	);
	await waitFor(() => expect(m.preview).toHaveBeenCalled());
	expect(m.preview.mock.calls[0][0].requiredPhrases).toEqual(["TODO "]);
});
it("allows readers to compare but hides Save and Remove controls", async () => {
	m.list.mockResolvedValue({ cases: [check], canManage: false });
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	await screen.findByRole("button", { name: "Compare with baseline" });
	expect(
		screen.queryByRole("button", { name: "Remove saved check" }),
	).not.toBeInTheDocument();
	fireEvent.mouseDown(
		screen.getByRole("tab", { name: "New check", exact: true }),
		{ button: 0, ctrlKey: false },
	);
	fireEvent.change(screen.getByLabelText(/Must include —/), {
		target: { value: "Next steps" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Check recorded result" }),
	);
	await screen.findByText(/All checks passed/);
	expect(
		screen.queryByRole("button", { name: "Save check", exact: true }),
	).not.toBeInTheDocument();
});
it("does not offer saved checks from another step", async () => {
	m.list.mockResolvedValue({
		cases: [{ ...check, nodeId: "other-step" }],
		canManage: true,
	});
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	await screen.findByLabelText(/Must include —/);
	fireEvent.mouseDown(
		screen.getByRole("tab", { name: "Saved checks", exact: true }),
		{ button: 0, ctrlKey: false },
	);
	expect(
		screen.queryByRole("button", { name: "Compare with baseline" }),
	).not.toBeInTheDocument();
	expect(screen.getByText(/Save a passing result as a check/)).toBeVisible();
});
it("allows a reviewed expectation to be saved with another name", async () => {
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	await screen.findByLabelText(/Must include —/);
	fireEvent.change(screen.getByLabelText(/Must include —/), {
		target: { value: "Next steps" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Check recorded result" }),
	);
	await screen.findByLabelText("Check name");
	fireEvent.change(screen.getByLabelText("Check name"), {
		target: { value: "First check" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Save check", exact: true }),
	);
	await screen.findByRole("button", { name: "Saved", exact: true });
	fireEvent.change(screen.getByLabelText("Check name"), {
		target: { value: "Second check" },
	});
	expect(
		screen.getByRole("button", { name: "Save check", exact: true }),
	).toBeEnabled();
});

it("shows structured and unavailable check outcomes instead of claiming empty phrase checks passed", async () => {
	m.list.mockResolvedValue({
		cases: [
			{
				...check,
				version: 2,
				requiredPhrases: [],
				forbiddenPhrases: [],
				jsonAssertions: [{ pointer: "/ready", equals: true }],
			},
		],
		canManage: true,
	});
	m.apply.mockResolvedValue({
		baseline: { version: 1 },
		candidate: {
			version: 2,
			report: { status: "not-assessed" },
			expectations: [],
			quality: {
				version: 2,
				method: "deterministic",
				scorerVersion: "fabric-deterministic-v1",
				status: "NOT_ASSESSED",
				passed: 1,
				total: 2,
				unavailable: 1,
				results: [
					{ kind: "json", index: 0, passed: true, available: true },
					{
						kind: "grounding",
						index: 0,
						passed: false,
						available: false,
					},
				],
			},
		},
		change: "unchanged",
	});
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Check result" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Compare with baseline" }),
	);
	await screen.findByText(/1 not assessed/);
	expect(screen.getByText(/JSON value check 1/)).toBeInTheDocument();
	expect(screen.queryByText(/All checks passed/)).not.toBeInTheDocument();
});
