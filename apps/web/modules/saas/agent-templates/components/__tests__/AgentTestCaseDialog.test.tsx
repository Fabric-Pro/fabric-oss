import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

const h = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { tests: { cases: h } } },
}));

import { AgentTestCaseDialog } from "../AgentTestCaseDialog";

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			{children}
		</QueryClientProvider>
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	h.create.mockResolvedValue({ id: "example-case" });
});
it("saves an editable task and exact checks while retaining preview provenance", async () => {
	const onClose = vi.fn();
	const v = render(
		<AgentTestCaseDialog
			organizationId="example-org"
			instanceId="example-agent"
			initialInput="Original task"
			sourcePreview={{ workflowId: "example-preview" }}
			onClose={onClose}
		/>,
		{ wrapper },
	);
	expect(v.getByRole("button", { name: "Save test" })).toBeDisabled();
	fireEvent.change(v.getByLabelText("Test name"), {
		target: { value: "Source check" },
	});
	fireEvent.change(v.getByLabelText("Task for a new run"), {
		target: { value: "Standalone task" },
	});
	fireEvent.change(v.getByLabelText("Must include"), {
		target: { value: "Source\nEvidence" },
	});
	fireEvent.change(v.getByLabelText("Must not include"), {
		target: { value: "Invented" },
	});
	fireEvent.click(v.getByRole("button", { name: "Save test" }));
	await waitFor(() =>
		expect(h.create).toHaveBeenCalledWith({
			organizationId: "example-org",
			instanceId: "example-agent",
			sourcePreview: { workflowId: "example-preview" },
			name: "Source check",
			input: "Standalone task",
			checks: {
				requiredPhrases: ["Source", "Evidence"],
				forbiddenPhrases: ["Invented"],
			},
		}),
	);
	expect(onClose).toHaveBeenCalledTimes(1);
});
it("rejects oversized or excessive checks before a request", () => {
	const v = render(
		<AgentTestCaseDialog
			organizationId="example-org"
			instanceId="example-agent"
			initialInput="Task"
			onClose={() => undefined}
		/>,
		{ wrapper },
	);
	fireEvent.change(v.getByLabelText("Test name"), {
		target: { value: "Example test" },
	});
	fireEvent.change(v.getByLabelText("Must include"), {
		target: { value: "x".repeat(513) },
	});
	expect(v.getByRole("button", { name: "Save test" })).toBeDisabled();
	fireEvent.change(v.getByLabelText("Must include"), {
		target: {
			value: Array.from({ length: 21 }, (_, i) => `Phrase ${i}`).join(
				"\n",
			),
		},
	});
	expect(v.getByRole("button", { name: "Save test" })).toBeDisabled();
	expect(h.create).not.toHaveBeenCalled();
});

it("gives the test editor an accessible dialog name and form labels", async () => {
	const v = render(
		<AgentTestCaseDialog
			organizationId="example-org"
			instanceId="example-agent"
			onClose={() => undefined}
		/>,
		{ wrapper },
	);
	expect(
		(
			await axe(v.getByRole("dialog"), {
				rules: { "color-contrast": { enabled: false } },
			})
		).violations,
	).toEqual([]);
});

it("preserves structured expectations when an existing case is edited through its phrase form", async () => {
	const checks = {
		version: 2 as const,
		requiredPhrases: ["Ready"],
		forbiddenPhrases: [],
		jsonAssertions: [{ pointer: "/ready", equals: true }],
	};
	const testCase = {
		id: "example-case",
		agentSId: "example-logical",
		originInstanceId: "example-agent",
		name: "Structured",
		input: "Return JSON",
		checks,
		revision: 3,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		latestRun: null,
	};
	const v = render(
		<AgentTestCaseDialog
			organizationId="example-org"
			instanceId="example-agent"
			testCase={testCase}
			onClose={() => undefined}
		/>,
		{ wrapper },
	);
	fireEvent.change(v.getByLabelText("Must include"), {
		target: { value: "Updated" },
	});
	fireEvent.click(v.getByRole("button", { name: "Save test" }));
	await waitFor(() => expect(h.update).toHaveBeenCalled());
	expect(h.update.mock.calls[0][0]).toMatchObject({
		revision: 3,
		checks: { ...checks, requiredPhrases: ["Updated"] },
	});
});
it("creates bounded JSON checks from the advanced editor and refuses unsupported schema features", async () => {
	const v = render(
		<AgentTestCaseDialog
			organizationId="example-org"
			instanceId="example-agent"
			initialInput="Return JSON"
			onClose={() => undefined}
		/>,
		{ wrapper },
	);
	fireEvent.change(v.getByLabelText("Test name"), {
		target: { value: "Structured" },
	});
	fireEvent.click(v.getByRole("button", { name: "Advanced JSON checks" }));
	fireEvent.change(v.getByLabelText("Versioned checks"), {
		target: {
			value: JSON.stringify({
				version: 2,
				jsonSchema: { type: "string", pattern: ".*" },
			}),
		},
	});
	expect(v.getByRole("button", { name: "Save test" })).toBeDisabled();
	const checks = {
		version: 2,
		jsonSchema: {
			type: "object",
			required: ["ready"],
			properties: { ready: { type: "boolean" } },
		},
		jsonAssertions: [{ pointer: "/ready", equals: true }],
	};
	fireEvent.change(v.getByLabelText("Versioned checks"), {
		target: { value: JSON.stringify(checks) },
	});
	fireEvent.click(v.getByRole("button", { name: "Save test" }));
	await waitFor(() => expect(h.create).toHaveBeenCalled());
	expect(h.create.mock.calls[0][0].checks).toMatchObject(checks);
});

it("rejects a structurally valid but oversized UTF-8 definition before sending it", () => {
	const v = render(
		<AgentTestCaseDialog
			organizationId="example-org"
			instanceId="example-agent"
			initialInput="Return JSON"
			onClose={() => undefined}
		/>,
		{ wrapper },
	);
	fireEvent.change(v.getByLabelText("Test name"), {
		target: { value: "Bounded JSON" },
	});
	fireEvent.click(v.getByRole("button", { name: "Advanced JSON checks" }));
	const jsonSchema = {
		type: "object",
		properties: Object.fromEntries(
			Array.from({ length: 12 }, (_, i) => [
				`field${i}`,
				{
					type: "string",
					enum: Array.from({ length: 20 }, () => "界".repeat(500)),
				},
			]),
		),
	};
	fireEvent.change(v.getByLabelText("Versioned checks"), {
		target: { value: JSON.stringify({ version: 2, jsonSchema }) },
	});
	expect(v.getByRole("button", { name: "Save test" })).toBeDisabled();
	expect(v.getByText(/larger than 128 KiB/)).toBeInTheDocument();
	expect(h.create).not.toHaveBeenCalled();
});
