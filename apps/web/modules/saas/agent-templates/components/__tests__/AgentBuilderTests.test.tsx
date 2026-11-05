import type {
	AgentTestCaseSummary,
	AgentTestReport,
	AgentTestRunSummary,
} from "@repo/temporal/agent-test-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

const h = vi.hoisted(() => ({
	list: vi.fn(),
	history: vi.fn(),
	get: vi.fn(),
	start: vi.fn(),
	cancel: vi.fn(),
	compare: vi.fn(),
	archive: vi.fn(),
	versions: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: {
			tests: {
				cases: { list: h.list, archive: h.archive },
				runs: {
					list: h.history,
					get: h.get,
					start: h.start,
					cancel: h.cancel,
					compare: h.compare,
				},
			},
		},
		agentTemplates: { instances: { versionHistory: h.versions } },
	},
}));
vi.mock("../AgentRunSession", () => ({
	AgentRunSession: ({
		executionId,
		onBack,
	}: {
		executionId: string;
		onBack: () => void;
	}) => (
		<div>
			Execution {executionId}
			<button type="button" onClick={onBack}>
				Back
			</button>
		</div>
	),
}));
vi.mock("../AgentTestCaseDialog", () => ({
	AgentTestCaseDialog: () => <div>Test editor</div>,
	agentTestError: (error: Error) => error.message,
}));

import {
	AgentBuilderTests,
	agentTestAdmissionNotStarted,
	agentTestAssessmentMessage,
	agentTestImprovementRequest,
	agentTestPollInterval,
} from "../AgentBuilderTests";

const props = {
	organizationId: "example-org",
	instanceId: "example-agent",
	instanceSId: "example-stable",
	agentsHref: "/app/example-org/agents",
};
const report: AgentTestReport = {
	version: 1,
	method: "exact-text",
	outputHash: "a".repeat(64),
	passed: 1,
	total: 2,
	results: [
		{ kind: "required", index: 0, passed: true },
		{ kind: "forbidden", index: 0, passed: false },
	],
	durationMs: 1200,
	inputTokens: 12,
	outputTokens: 20,
	totalCost: "0.000001",
};
const run: AgentTestRunSummary = {
	id: "example-test-run",
	caseId: "example-case",
	instanceId: props.instanceId,
	agentVersion: 2,
	caseRevision: 1,
	requestKey: "11111111-1111-4111-8111-111111111111",
	status: "COMPLETED",
	verdict: "FAILED",
	executionId: "example-execution",
	errorCode: null,
	report,
	createdAt: "2026-01-01T00:00:00Z",
	completedAt: "2026-01-01T00:00:01Z",
};
const testCase: AgentTestCaseSummary = {
	id: "example-case",
	agentSId: props.instanceSId,
	originInstanceId: props.instanceId,
	name: "Delivery sources",
	input: "Summarize delivery",
	checks: { requiredPhrases: ["Source"], forbiddenPhrases: ["Invented"] },
	revision: 1,
	createdAt: run.createdAt,
	updatedAt: run.createdAt,
	latestRun: run,
};
function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: {
						queries: { retry: false },
						mutations: { retry: false },
					},
				})
			}
		>
			{children}
		</QueryClientProvider>
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	h.list.mockResolvedValue({ cases: [testCase], nextCursor: null });
	h.history.mockResolvedValue({
		runs: [run, { ...run, id: "example-older", agentVersion: 1 }],
		nextCursor: null,
	});
	h.get.mockResolvedValue(run);
	h.start.mockResolvedValue({
		...run,
		status: "RUNNING",
		verdict: null,
		report: null,
	});
	h.cancel.mockResolvedValue({ requested: true });
	h.versions.mockResolvedValue({
		versions: [{ id: props.instanceId, version: 2, status: "ACTIVE" }],
	});
	h.compare.mockResolvedValue({
		baseline: { ...run, agentVersion: 1 },
		candidate: run,
		changes: { total: 2 },
	});
	h.archive.mockResolvedValue({ archived: true });
});
it("does not execute on open and shows bounded real test evidence with its agent version", async () => {
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	expect(h.start).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Delivery sources" }));
	await v.findByRole("button", { name: /Version 2 · Test revision/ });
	fireEvent.click(
		v.getByRole("button", { name: /Version 2 · Test revision/ }),
	);
	await v.findByText("1 of 2 checks passed");
	expect(v.getByText(/32 tokens/)).toHaveTextContent(
		"1.2s · $0.000001 · 32 tokens",
	);
	expect(v.getByText("“Source”")).toBeInTheDocument();
	fireEvent.click(v.getByRole("button", { name: "Inspect agent execution" }));
	expect(v.getByText("Execution example-execution")).toBeInTheDocument();
	expect(h.start).not.toHaveBeenCalled();
});
it("reconnects an uncertain start with the same request UUID", async () => {
	h.list.mockResolvedValue({
		cases: [{ ...testCase, latestRun: null }],
		nextCursor: null,
	});
	h.start.mockRejectedValueOnce(new Error("Admission is uncertain"));
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Run test" }));
	await v.findByRole("button", { name: "Reconnect test run" });
	fireEvent.click(v.getByRole("button", { name: "Reconnect test run" }));
	await waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
	expect(h.start.mock.calls[0][0]).toEqual(h.start.mock.calls[1][0]);
	expect(h.start.mock.calls[0][0]).toMatchObject({
		organizationId: props.organizationId,
		caseId: testCase.id,
		caseRevision: 1,
		instanceId: props.instanceId,
	});
});
it("recovers an admitting run using its frozen version and server request key after refresh", async () => {
	const pending = {
		...run,
		status: "ADMITTING",
		verdict: null,
		report: null,
		executionId: null,
		instanceId: "example-original-version",
		agentVersion: 1,
	};
	h.history.mockResolvedValue({ runs: [pending], nextCursor: null });
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Delivery sources" }));
	fireEvent.click(await v.findByRole("button", { name: "Reconnect run" }));
	await waitFor(() =>
		expect(h.start).toHaveBeenCalledWith({
			organizationId: props.organizationId,
			caseId: run.caseId,
			caseRevision: run.caseRevision,
			instanceId: pending.instanceId,
			idempotencyKey: run.requestKey,
		}),
	);
});
it("compares selected recorded runs and explains live context differences", async () => {
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Delivery sources" }));
	const history = await v.findByRole("region", {
		name: "Test history: Delivery sources",
	});
	fireEvent.click(
		(
			await within(history).findAllByRole("button", {
				name: "Set baseline",
			})
		)[1],
	);
	fireEvent.click(
		within(history).getByRole("button", { name: "Compare with baseline" }),
	);
	await waitFor(() =>
		expect(h.compare).toHaveBeenCalledWith({
			organizationId: props.organizationId,
			baselineRunId: "example-older",
			candidateRunId: run.id,
		}),
	);
	expect(
		await v.findByText(/Same test revision; live sources/),
	).toBeInTheDocument();
});
it("cancels an active native test without claiming it already stopped", async () => {
	h.history.mockResolvedValue({
		runs: [{ ...run, status: "RUNNING", report: null, verdict: null }],
		nextCursor: null,
	});
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Delivery sources" }));
	fireEvent.click(await v.findByRole("button", { name: "Stop test run" }));
	await waitFor(() =>
		expect(h.cancel).toHaveBeenCalledWith({
			organizationId: props.organizationId,
			testRunId: run.id,
		}),
	);
	expect(v.queryByText("Cancelled")).not.toBeInTheDocument();
});
it("hides cached case and result content after current access fails", async () => {
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Delivery sources" }));
	fireEvent.click(
		await v.findByRole("button", { name: /Version 2 · Test revision/ }),
	);
	await v.findByText("1 of 2 checks passed");
	h.list.mockRejectedValue(new Error("Access changed"));
	fireEvent.click(v.getByRole("button", { name: "Refresh agent tests" }));
	await v.findByText("Access changed");
	expect(v.queryByText("Delivery sources")).not.toBeInTheDocument();
	expect(v.queryByText("1 of 2 checks passed")).not.toBeInTheDocument();
});

it("provides labeled controls and accessible empty test state", async () => {
	h.list.mockResolvedValue({ cases: [], nextCursor: null });
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Keep a task worth repeating");
	expect(
		(
			await axe(v.container, {
				rules: { "color-contrast": { enabled: false } },
			})
		).violations,
	).toEqual([]);
});

it("keeps an uncertain admission attached to its original case when another case is inspected", async () => {
	h.list.mockResolvedValue({
		cases: [
			{ ...testCase, latestRun: null },
			{
				...testCase,
				id: "example-other-case",
				name: "Other test",
				latestRun: null,
			},
		],
		nextCursor: null,
	});
	h.start.mockRejectedValueOnce(new Error("Admission uncertain"));
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getAllByRole("button", { name: "Run test" })[0]);
	await v.findByRole("button", { name: "Reconnect test run" });
	fireEvent.click(v.getByRole("button", { name: "Other test" }));
	for (const button of v.getAllByRole("button", { name: "Run test" })) {
		expect(button).toBeDisabled();
	}
	expect(v.getByText(/Reconnect “Delivery sources”/)).toBeInTheDocument();
	fireEvent.click(v.getByRole("button", { name: "Reconnect test run" }));
	await waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
	expect(h.start.mock.calls[0][0]).toEqual(h.start.mock.calls[1][0]);
	await v.findByRole("region", { name: "Test history: Delivery sources" });
});

it("prepares a reviewed Sidekick improvement request with failed-check metadata and no execution output", async () => {
	const onImprove = vi.fn();
	const v = render(<AgentBuilderTests {...props} onImprove={onImprove} />, {
		wrapper,
	});
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Delivery sources" }));
	fireEvent.click(
		await v.findByRole("button", { name: /Version 2 · Test revision/ }),
	);
	await v.findByText("1 of 2 checks passed");
	fireEvent.click(v.getByRole("button", { name: "Ask Sidekick to improve" }));
	expect(onImprove).toHaveBeenCalledTimes(1);
	const text = onImprove.mock.calls[0][0];
	expect(text).toContain("saved agent version 2; test revision 1");
	expect(text).toContain("current builder draft may differ");
	expect(text).toContain('Must not include "Invented"');
	expect(text).toContain("Summarize delivery");
	expect(text).toContain("No raw execution answer has been shared");
	expect(text).toContain("changes for my review");
	expect(text).not.toContain(report.outputHash);
	expect(h.start).not.toHaveBeenCalled();
});

it("does not attribute a historical failure to newly edited task or checks", () => {
	const text = agentTestImprovementRequest(
		{ ...run, caseRevision: 1 },
		{
			...testCase,
			revision: 2,
			input: "New private task",
			checks: {
				requiredPhrases: ["New requirement"],
				forbiddenPhrases: ["New prohibition"],
			},
		},
	);
	expect(text).toContain("test was edited after this run");
	expect(text).toContain("phrase 1 from test revision 1");
	expect(text).not.toContain("New private task");
	expect(text).not.toContain("New requirement");
	expect(text).not.toContain("New prohibition");
});

it.each([
	["AGENT_TEST_CONFIG_CHANGED", /saved configuration changed/],
	["AGENT_TEST_NO_TEXT", /bounded text answer/],
	["AGENT_TEST_EFFECT_UNCONFIRMED", /avoid repeating an external action/],
	[
		"AGENT_TEST_EXECUTION_FAILED",
		/execution failed, so these checks were not assessed/,
	],
	["AGENT_TEST_FORBIDDEN", /Access changed/],
	["AGENT_TEST_IDENTITY_INVALID", /could not verify/],
	["PRIVATE_PROVIDER_DETAILS", /assessment is unavailable/],
])(
	"offers fixed recovery guidance for %s without revealing raw errors",
	(code, message) => {
		const text = agentTestAssessmentMessage(code);
		expect(text).toMatch(message);
		expect(text).not.toContain(code);
	},
);

it("clears another case’s selected report before starting a new case", async () => {
	h.list.mockResolvedValue({
		cases: [
			testCase,
			{
				...testCase,
				id: "example-other-case",
				name: "Other test",
				latestRun: null,
			},
		],
		nextCursor: null,
	});
	h.start.mockImplementation(() => new Promise(() => {}));
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Delivery sources" }));
	fireEvent.click(
		await v.findByRole("button", { name: /Version 2 · Test revision/ }),
	);
	await v.findByText("1 of 2 checks passed");
	const item = v.getByRole("button", { name: "Other test" }).closest("li");
	expect(item).not.toBeNull();
	fireEvent.click(
		within(item as HTMLLIElement).getByRole("button", { name: "Run test" }),
	);
	expect(v.queryByText("1 of 2 checks passed")).not.toBeInTheDocument();
	expect(v.queryByText("“Invented”")).not.toBeInTheDocument();
});

it("uses singular check copy for one expectation", async () => {
	h.list.mockResolvedValue({
		cases: [
			{
				...testCase,
				checks: { requiredPhrases: ["Source"], forbiddenPhrases: [] },
				latestRun: null,
			},
		],
		nextCursor: null,
	});
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	expect(await v.findByText("Revision 1 · 1 check")).toBeInTheDocument();
});

it("requires deliberate confirmation to test a saved version when the builder has unsaved edits", async () => {
	h.list.mockResolvedValue({
		cases: [{ ...testCase, latestRun: null }],
		nextCursor: null,
	});
	const v = render(<AgentBuilderTests {...props} hasUnsavedChanges />, {
		wrapper,
	});
	await v.findByText("Delivery sources");
	expect(v.getByText("Unsaved changes are not included")).toBeInTheDocument();
	fireEvent.click(v.getByRole("button", { name: "Run test" }));
	expect(h.start).not.toHaveBeenCalled();
	const dialog = v.getByRole("alertdialog");
	expect(dialog).toHaveTextContent("Your unsaved edits will not be included");
	fireEvent.click(within(dialog).getByRole("button", { name: "Go back" }));
	expect(h.start).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Run test" }));
	fireEvent.click(
		within(v.getByRole("alertdialog")).getByRole("button", {
			name: "Run saved version",
		}),
	);
	await waitFor(() =>
		expect(h.start).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: props.instanceId,
				caseRevision: 1,
			}),
		),
	);
	expect(h.start.mock.calls[0][0]).not.toHaveProperty("draft");
});
it("uses refreshed case revision for check labels and archiving instead of a copied selection", async () => {
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Delivery sources" }));
	fireEvent.click(
		await v.findByRole("button", { name: /Version 2 · Test revision/ }),
	);
	await v.findByText("“Invented”");
	h.list.mockResolvedValue({
		cases: [
			{
				...testCase,
				revision: 2,
				checks: {
					requiredPhrases: ["Changed requirement"],
					forbiddenPhrases: ["Changed prohibition"],
				},
			},
		],
		nextCursor: null,
	});
	fireEvent.click(v.getByRole("button", { name: "Refresh agent tests" }));
	expect(await v.findAllByText(/phrase 1 from revision 1/)).toHaveLength(2);
	expect(v.queryByText("“Changed prohibition”")).not.toBeInTheDocument();
	expect(v.queryByText("“Invented”")).not.toBeInTheDocument();
	fireEvent.click(v.getByRole("button", { name: "Archive test" }));
	fireEvent.click(
		within(v.getByRole("alertdialog")).getByRole("button", {
			name: "Archive test",
		}),
	);
	await waitFor(() =>
		expect(h.archive).toHaveBeenCalledWith({
			organizationId: props.organizationId,
			caseId: testCase.id,
			revision: 2,
		}),
	);
});
it("clears a removed selection only after the refreshed list is exhausted", async () => {
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Delivery sources" }));
	await v.findByRole("region", { name: "Test history: Delivery sources" });
	h.list.mockResolvedValue({ cases: [], nextCursor: null });
	fireEvent.click(v.getByRole("button", { name: "Refresh agent tests" }));
	await v.findByText("Keep a task worth repeating");
	expect(
		v.queryByRole("region", { name: "Test history: Delivery sources" }),
	).not.toBeInTheDocument();
});
it("retains a selection outside loaded cursor pages and resolves it from the next refreshed page", async () => {
	let moved = false;
	h.list.mockImplementation(({ cursor }) =>
		Promise.resolve(
			cursor
				? { cases: [{ ...testCase, revision: 2 }], nextCursor: null }
				: moved
					? { cases: [], nextCursor: "example-next" }
					: { cases: [testCase], nextCursor: null },
		),
	);
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Delivery sources" }));
	await v.findByRole("region", { name: "Test history: Delivery sources" });
	moved = true;
	fireEvent.click(v.getByRole("button", { name: "Refresh agent tests" }));
	await v.findByText(/selected test is outside the loaded results/);
	expect(
		v.queryByText("Keep a task worth repeating"),
	).not.toBeInTheDocument();
	expect(v.getByText(/No accessible tests in this page/)).toBeInTheDocument();
	fireEvent.click(v.getByRole("button", { name: "Load more tests" }));
	await v.findByText(/Revision 2 · 2 checks/);
	expect(
		v.getByRole("region", { name: "Test history: Delivery sources" }),
	).toBeInTheDocument();
});
it("unlocks a new attempt only for trusted NOT_STARTED errors", async () => {
	h.list.mockResolvedValue({
		cases: [{ ...testCase, latestRun: null }],
		nextCursor: null,
	});
	h.start.mockRejectedValueOnce(
		Object.assign(new Error("Test revision changed"), {
			code: "CONFLICT",
			data: { admission: "NOT_STARTED" },
		}),
	);
	const v = render(<AgentBuilderTests {...props} />, { wrapper });
	await v.findByText("Delivery sources");
	fireEvent.click(v.getByRole("button", { name: "Run test" }));
	await v.findByText("Test revision changed");
	expect(
		v.queryByRole("button", { name: "Reconnect test run" }),
	).not.toBeInTheDocument();
	expect(v.getByRole("button", { name: "Run test" })).toBeEnabled();
	fireEvent.click(v.getByRole("button", { name: "Run test" }));
	await waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
	expect(h.start.mock.calls[1][0].idempotencyKey).not.toEqual(
		h.start.mock.calls[0][0].idempotencyKey,
	);
});
it("does not mistake an unqualified CONFLICT or malformed error for proven non-admission", () => {
	expect(
		agentTestAdmissionNotStarted(
			Object.assign(new Error("conflict"), { code: "CONFLICT" }),
		),
	).toBe(false);
	expect(agentTestAdmissionNotStarted({ data: { admission: "MAYBE" } })).toBe(
		false,
	);
	expect(agentTestAdmissionNotStarted({ data: "NOT_STARTED" })).toBe(false);
	expect(
		agentTestAdmissionNotStarted({ data: { admission: "NOT_STARTED" } }),
	).toBe(true);
});
it("slows long-running status reads after five minutes and bounds them at forty", () => {
	expect(agentTestPollInterval(0, 1500, 299999)).toBe(1500);
	expect(agentTestPollInterval(0, 1500, 300000)).toBe(15000);
	expect(agentTestPollInterval(0, 1500, 2399999)).toBe(15000);
	expect(agentTestPollInterval(0, 1500, 2400000)).toBe(false);
});
it("shows a paused-updates notice and lets Refresh resume a long-running test", async () => {
	vi.useFakeTimers();
	let v: ReturnType<typeof render> | undefined;
	try {
		h.list.mockResolvedValue({
			cases: [
				{
					...testCase,
					latestRun: {
						...run,
						status: "RUNNING",
						report: null,
						verdict: null,
					},
				},
			],
			nextCursor: null,
		});
		v = render(<AgentBuilderTests {...props} />, { wrapper });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20);
		});
		expect(v.getByText("Delivery sources")).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(300000);
		});
		expect(
			v.getByText(/Updates continue every 15 seconds/),
		).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(35 * 60000);
		});
		expect(v.getByText(/Automatic updates paused/)).toBeInTheDocument();
		fireEvent.click(v.getByRole("button", { name: "Refresh agent tests" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20);
		});
		expect(
			v.queryByText(/Automatic updates paused/),
		).not.toBeInTheDocument();
	} finally {
		v?.unmount();
		vi.useRealTimers();
	}
}, 30000);
