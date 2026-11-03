/**
 * The Loom page's Deep Research chat over either transport: Stop only on the
 * runtime (the stream route's chat stays as it was), the question bubble from
 * the stream, and a reopened result that is not saved as an artifact again.
 * The result viewer, the progress panel and the composer are stand-ins that
 * record their props.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	viewer: vi.fn(),
	panel: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
	default: (loader: () => Promise<unknown>) =>
		String(loader).includes("WorkflowResultViewer")
			? (props: Record<string, unknown>) => {
					m.viewer(props);
					return <div data-testid="result-viewer" />;
				}
			: (props: Record<string, unknown>) => {
					m.panel(props);
					return <div data-testid="progress-panel" />;
				},
}));
vi.mock("@saas/agents/components/FabricChat/shared/ChatInput", () => ({
	ChatInput: ({
		onStop,
		isLoading,
	}: {
		onStop?: () => void;
		isLoading?: boolean;
	}) =>
		onStop && isLoading ? (
			<button type="button" onClick={onStop}>
				Stop
			</button>
		) : null,
}));
vi.mock("@saas/agents/components/StoppedIndicator", () => ({
	StoppedIndicator: () => <output>Stopped</output>,
}));

import type { useResearchRunStream } from "@saas/agents/hooks/useResearchRunStream";
import { INITIAL_WORKFLOW_TEMPLATE_STATE } from "@saas/agents/lib/workflow-template-state";
import { DeepResearchInlineChat } from "../DeepResearchInlineChat";

type ResearchStream = ReturnType<typeof useResearchRunStream>;

const RESULT = {
	model: { id: "example-answer-served", viaPlan: true },
	summaryModel: { id: "example-summary-served", viaPlan: false },
	reportModel: { id: "example-report-served", viaPlan: false },
	text: "The full research text.",
	summary: "A short summary.",
	keyFindings: [],
	sources: [],
	iterations: 1,
	goalAchieved: true,
	duration: 4200,
	structuredReport: null,
};

function researchStream(
	overrides: Partial<ResearchStream> = {},
): ResearchStream {
	return {
		state: { ...INITIAL_WORKFLOW_TEMPLATE_STATE, status: "running" },
		query: "How did the market change?",
		isLoading: true,
		resultRestored: false,
		transport: "runtime",
		sendQuery: vi.fn(async () => null),
		cancel: vi.fn(async () => undefined),
		reset: vi.fn(),
		pollStatus: vi.fn(async () => null),
		sendClarificationResponse: vi.fn(async () => true),
		isRunning: true,
		isComplete: false,
		hasResults: false,
		progress: {
			...INITIAL_WORKFLOW_TEMPLATE_STATE.progress,
			percentage: 0,
		},
		...overrides,
	};
}

function finishedStream(resultRestored: boolean): ResearchStream {
	return researchStream({
		state: {
			...INITIAL_WORKFLOW_TEMPLATE_STATE,
			status: "completed",
			phase: "completed",
			result: RESULT,
		},
		isLoading: false,
		isRunning: false,
		isComplete: true,
		hasResults: true,
		resultRestored,
	});
}

function renderChat(stream: ResearchStream) {
	return render(
		<DeepResearchInlineChat
			stream={stream}
			onSend={vi.fn()}
			onReset={vi.fn()}
			organizationId="org_example"
		/>,
	);
}

beforeEach(() => {
	m.viewer.mockClear();
	m.panel.mockClear();
});

describe("DeepResearchInlineChat", () => {
	it("a runtime stream shows Stop while loading, and Stop cancels the run", () => {
		const stream = researchStream();
		renderChat(stream);

		fireEvent.click(screen.getByRole("button", { name: "Stop" }));

		expect(stream.cancel).toHaveBeenCalledTimes(1);
	});

	it("a stream-route run shows no Stop", () => {
		renderChat(researchStream({ transport: "legacy" }));

		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
	});

	it("marks a stopped run as Stopped instead of leaving the question unanswered", () => {
		renderChat(
			researchStream({
				state: {
					...INITIAL_WORKFLOW_TEMPLATE_STATE,
					status: "cancelled",
					phase: "cancelled",
				},
				isLoading: false,
				isRunning: false,
				isComplete: true,
			}),
		);

		expect(screen.getByText("Stopped")).toBeTruthy();
		expect(screen.getByText("New Research")).toBeTruthy();
	});

	it("a run cancelled elsewhere shows its error, not the Stopped mark", () => {
		renderChat(
			researchStream({
				state: {
					...INITIAL_WORKFLOW_TEMPLATE_STATE,
					status: "cancelled",
					phase: "cancelled",
					error: "Workflow was cancelled",
				},
				isLoading: false,
				isRunning: false,
				isComplete: true,
			}),
		);

		expect(screen.getByText("Workflow was cancelled")).toBeTruthy();
		expect(screen.queryByText("Stopped")).toBeNull();
	});

	it("a running or finished run shows no Stopped mark", () => {
		const running = renderChat(researchStream());
		expect(screen.queryByText("Stopped")).toBeNull();
		running.unmount();

		renderChat(finishedStream(false));
		expect(screen.queryByText("Stopped")).toBeNull();
	});

	it("shows the stream's question in the user bubble", () => {
		renderChat(researchStream({ query: "What about pricing?" }));

		expect(screen.getByText("What about pricing?")).toBeTruthy();
		expect(screen.queryByText("Deep Research")).toBeNull();
	});

	it("offers the starters while nothing was asked", () => {
		renderChat(researchStream({ query: "", isLoading: false }));

		expect(screen.getByText("Deep Research")).toBeTruthy();
	});

	it("a restored result is not saved as an artifact again; a live one is", () => {
		const restored = renderChat(finishedStream(true));
		expect(m.viewer).toHaveBeenLastCalledWith(
			expect.objectContaining({ result: RESULT, persistArtifact: false }),
		);
		restored.unmount();

		renderChat(finishedStream(false));
		expect(m.viewer).toHaveBeenLastCalledWith(
			expect.objectContaining({ result: RESULT, persistArtifact: true }),
		);
	});
});
