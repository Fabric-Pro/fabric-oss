import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

const m = vi.hoisted(() => ({
	policy: vi.fn(),
	configure: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	compare: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		runQuality: {
			policy: { get: m.policy, configure: m.configure },
			assessments: {
				list: m.list,
				get: m.get,
				cancel: m.cancel,
				compare: m.compare,
			},
		},
	},
}));

import { RunQualityPanel } from "../RunQualityPanel";

const target = { targetType: "AGENT" as const, targetId: "example-agent" };
const row = {
	id: "example-assessment",
	executionId: "example-execution",
	...target,
	policyRevision: 2,
	sourceVersion: 3,
	status: "COMPLETED",
	verdict: "NEEDS_ATTENTION",
	report: {
		scorerVersion: "fabric-deterministic-v1",
		coverage: { passed: 0, failed: 1, unavailable: 0, total: 1 },
		rules: [
			{
				id: "check",
				name: "Delivery brief",
				required: true,
				status: "FAILED",
				grade: { results: [], passed: 0, total: 1 },
			},
		],
	},
	createdAt: "2026-01-01T00:00:00Z",
	completedAt: "2026-01-01T00:00:01Z",
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
const mount = (extra: Record<string, unknown> = {}) =>
	render(
		<RunQualityPanel organizationId="example-org" {...target} {...extra} />,
		{ wrapper },
	);
async function open() {
	fireEvent.click(screen.getByText("Automatic checks"));
	await screen.findByRole("button", { name: "Set up automatic checks" });
}
beforeEach(() => {
	vi.clearAllMocks();
	m.policy.mockResolvedValue({ ...target, policy: null, canConfigure: true });
	m.list.mockResolvedValue({ assessments: [], hasMore: false });
	m.configure.mockResolvedValue({
		...target,
		policy: {
			id: "policy",
			revision: 1,
			enabled: true,
			rules: [],
			updatedAt: "2026-01-01T00:00:00Z",
		},
		canConfigure: true,
	});
	m.get.mockResolvedValue(row);
	m.cancel.mockResolvedValue({ requested: true });
});
it("is compact on entry and explains that assessments never rerun business work", async () => {
	const v = mount();
	expect(m.list).not.toHaveBeenCalled();
	await open();
	expect(screen.getByText(/never rerun work/)).toBeInTheDocument();
	expect(m.configure).not.toHaveBeenCalled();
	expect(
		(
			await axe(v.container, {
				rules: { "color-contrast": { enabled: false } },
			})
		).violations,
	).toEqual([]);
});
it("saves reviewed phrase rules with a pinned policy revision, not automatically on editing", async () => {
	mount();
	await open();
	fireEvent.click(
		screen.getByRole("button", { name: "Set up automatic checks" }),
	);
	fireEvent.change(screen.getByLabelText(/Must include —/), {
		target: { value: "Ready\nSource" },
	});
	expect(m.configure).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("button", { name: "Save automatic checks" }),
	);
	await waitFor(() => expect(m.configure).toHaveBeenCalled());
	expect(m.configure.mock.calls[0][0]).toMatchObject({
		...target,
		organizationId: "example-org",
		expectedRevision: 0,
		enabled: true,
		rules: [
			{
				name: "Result check",
				required: true,
				checks: {
					requiredPhrases: ["Ready", "Source"],
					forbiddenPhrases: [],
				},
			},
		],
	});
});
it("refuses empty checks and unsafe advanced schemas before making a mutation", async () => {
	mount();
	await open();
	fireEvent.click(
		screen.getByRole("button", { name: "Set up automatic checks" }),
	);
	fireEvent.change(screen.getByLabelText("Check name"), {
		target: { value: "Edited" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Save automatic checks" }),
	);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		/expectation to every check/,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Advanced JSON and schema" }),
	);
	fireEvent.change(screen.getByLabelText("Versioned check rules"), {
		target: {
			value: JSON.stringify([
				{
					id: "check",
					name: "Unsafe",
					required: true,
					checks: {
						version: 2,
						jsonSchema: { type: "string", pattern: ".*" },
					},
				},
			]),
		},
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Save automatic checks" }),
	);
	expect(m.configure).not.toHaveBeenCalled();
});
it("requires a deliberate workflow step selection", async () => {
	mount({
		targetType: "WORKFLOW",
		targetId: "example-flow",
		nodeOptions: [{ id: "draft", name: "Draft document" }],
	});
	await open();
	fireEvent.click(
		screen.getByRole("button", { name: "Set up automatic checks" }),
	);
	fireEvent.change(screen.getByLabelText(/Must include —/), {
		target: { value: "Ready" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Save automatic checks" }),
	);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		/Choose the step/,
	);
	expect(m.configure).not.toHaveBeenCalled();
	fireEvent.change(screen.getByLabelText("Step result to check"), {
		target: { value: "draft" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Save automatic checks" }),
	);
	await waitFor(() => expect(m.configure).toHaveBeenCalled());
	expect(m.configure.mock.calls[0][0].rules[0].nodeId).toBe("draft");
});
it("honors server capabilities and retains assessment state separately", async () => {
	m.policy.mockResolvedValue({
		...target,
		policy: null,
		canConfigure: false,
	});
	m.list.mockResolvedValue({ assessments: [row], hasMore: false });
	mount();
	fireEvent.click(screen.getByText("Automatic checks"));
	await screen.findByText(/Saved version 3/);
	expect(
		screen.queryByRole("button", { name: "Set up automatic checks" }),
	).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: /Saved version 3/ }));
	await screen.findByRole("region", { name: "Assessment details" });
	expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0);
	expect(
		screen.queryByRole("button", { name: "Cancel assessment only" }),
	).not.toBeInTheDocument();
});
it("cancels only an active assessment and preserves source version labels", async () => {
	const active = { ...row, status: "CHECKING", verdict: null, report: null };
	m.list.mockResolvedValue({ assessments: [active], hasMore: false });
	m.get.mockResolvedValue(active);
	mount();
	await open();
	fireEvent.click(
		await screen.findByRole("button", { name: /Saved version 3/ }),
	);
	fireEvent.click(
		await screen.findByRole("button", { name: "Cancel assessment only" }),
	);
	await waitFor(() =>
		expect(m.cancel).toHaveBeenCalledWith({
			...target,
			organizationId: "example-org",
			assessmentId: row.id,
		}),
	);
});
it("prepares a bounded Sidekick request only after explicit review action", async () => {
	const onImprove = vi.fn();
	m.list.mockResolvedValue({ assessments: [row], hasMore: false });
	mount({ onImprove });
	await open();
	fireEvent.click(
		await screen.findByRole("button", { name: /Saved version 3/ }),
	);
	fireEvent.click(
		await screen.findByRole("button", { name: "Review in Sidekick" }),
	);
	expect(onImprove).toHaveBeenCalledTimes(1);
	expect(onImprove.mock.calls[0][0]).toContain("check revision 2");
	expect(onImprove.mock.calls[0][0]).toContain(
		"No execution output has been shared",
	);
});
it("does not show a detail receipt from another target", async () => {
	m.list.mockResolvedValue({ assessments: [row], hasMore: false });
	m.get.mockResolvedValue({ ...row, targetId: "different-agent" });
	mount();
	await open();
	fireEvent.click(
		await screen.findByRole("button", { name: /Saved version 3/ }),
	);
	await waitFor(() => expect(m.get).toHaveBeenCalled());
	expect(
		screen.queryByRole("region", { name: "Assessment details" }),
	).not.toBeInTheDocument();
});
it("paginates retained assessments rather than aggregating a sample", async () => {
	m.list.mockResolvedValue({ assessments: [row], hasMore: true });
	mount();
	await open();
	fireEvent.click(screen.getByRole("button", { name: "Next assessments" }));
	await waitFor(() =>
		expect(m.list).toHaveBeenCalledWith({
			...target,
			organizationId: "example-org",
			limit: 10,
			offset: 10,
		}),
	);
});

it("opens the actual business execution only on explicit inspection", async () => {
	const inspect = vi.fn();
	m.list.mockResolvedValue({ assessments: [row], hasMore: false });
	mount({ onInspectExecution: inspect });
	await open();
	fireEvent.click(
		await screen.findByRole("button", { name: /Saved version 3/ }),
	);
	fireEvent.click(
		await screen.findByRole("button", { name: "Inspect execution" }),
	);
	expect(inspect).toHaveBeenCalledWith("example-execution");
	expect(m.configure).not.toHaveBeenCalled();
});

it.each([
	{
		sourceScopeChanged: true,
		sourceVersionChanged: false,
		warning:
			/Recorded source context changed\. Do not assume these scores use the same evidence\./,
		absent: /Saved configuration changed from version/,
	},
	{
		sourceScopeChanged: false,
		sourceVersionChanged: true,
		warning: /Saved configuration changed from version 3 to version 4\./,
		absent: /Recorded source context changed\./,
	},
])(
	"qualifies a comparison when its recorded source or configuration changes",
	async ({ sourceScopeChanged, sourceVersionChanged, warning, absent }) => {
		const candidate = {
			...row,
			id: "example-candidate",
			sourceVersion: sourceVersionChanged ? 4 : 3,
		};
		m.list.mockResolvedValue({
			assessments: [row, candidate],
			hasMore: false,
		});
		m.compare.mockResolvedValue({
			left: row,
			right: candidate,
			changes: {
				sameChecks: true,
				sourceScopeChanged,
				sourceVersionChanged,
				verdictChanged: false,
			},
		});
		mount();
		await open();
		fireEvent.click(screen.getByText("Compare assessments"));
		fireEvent.change(screen.getByLabelText("Baseline assessment"), {
			target: { value: row.id },
		});
		fireEvent.change(screen.getByLabelText("Candidate assessment"), {
			target: { value: candidate.id },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Compare recorded checks" }),
		);
		expect(await screen.findByText(warning)).toBeInTheDocument();
		expect(screen.queryByText(absent)).not.toBeInTheDocument();
		expect(
			screen.getByText(
				/Baseline: 0\/1 passed\. Candidate: 0\/1 passed\./,
			),
		).toBeInTheDocument();
	},
);

it("explains unverifiable retained rows while keeping valid history available", async () => {
	m.list.mockResolvedValue({
		assessments: [row],
		hasMore: true,
		unavailableCount: 1,
	});
	mount();
	await open();
	expect(
		await screen.findByText(
			/1 retained assessment could not be verified and are not shown/,
		),
	).toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: /Saved version 3/ }),
	).toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Next assessments" }),
	).toBeEnabled();
});

it("keeps an entirely unverifiable page navigable without suggesting replacement execution", async () => {
	m.list.mockResolvedValue({
		assessments: [],
		hasMore: true,
		unavailableCount: 2,
	});
	mount();
	await open();
	expect(
		await screen.findByText(
			/No verified assessments on this page\. Continue to the next page/,
		),
	).toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Next assessments" }),
	).toBeEnabled();
	expect(
		screen.queryByText(/Enable checks and run a saved version/),
	).not.toBeInTheDocument();
});

it.each([
	["POLICY_CHANGED", "The agent configuration changed during this run."],
	[
		"EXECUTION_CANCELLED",
		"The run was cancelled before a complete result was available.",
	],
])(
	"explains unavailable assessment %s without exposing raw diagnostics",
	async (errorCode, message) => {
		const unavailable = {
			...row,
			verdict: "UNAVAILABLE",
			report: null,
			errorCode,
		};
		m.list.mockResolvedValue({
			assessments: [unavailable],
			hasMore: false,
		});
		m.get.mockResolvedValue(unavailable);
		mount();
		await open();
		fireEvent.click(
			await screen.findByRole("button", { name: /Saved version 3/ }),
		);
		expect(
			await screen.findByText(
				new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			),
		).toBeInTheDocument();
		expect(screen.queryByText(errorCode)).not.toBeInTheDocument();
	},
);
