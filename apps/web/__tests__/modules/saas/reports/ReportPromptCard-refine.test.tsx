import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	enhancerProps: undefined as
		| { promptName: string; initialContent?: string }
		| undefined,
	runtimeUrl: undefined as string | undefined,
	agent: undefined as string | undefined,
}));

vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({
		children,
		runtimeUrl,
		agent,
	}: {
		children: ReactNode;
		runtimeUrl: string;
		agent: string;
	}) => {
		m.runtimeUrl = runtimeUrl;
		m.agent = agent;
		return <>{children}</>;
	},
}));

vi.mock("@saas/shared/components/copilot/CopilotChatSessionProvider", () => ({
	CopilotChatSessionProvider: ({ children }: { children: ReactNode }) => (
		<>{children}</>
	),
}));

vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => vi.fn(),
}));

// The enhancer itself is covered by the Prompt Library's tests; this stands
// in for its contract: it starts from `initialContent` and saves or cancels.
vi.mock("@saas/prompts/components/PromptContentEnhancer", () => ({
	PromptContentEnhancer: (props: {
		promptName: string;
		initialContent?: string;
		onSave: (content: string) => void;
		onCancel: () => void;
	}) => {
		m.enhancerProps = props;
		return (
			<div>
				<p>Enhancing: {props.initialContent}</p>
				<button
					type="button"
					onClick={() => props.onSave("A refined prompt.")}
				>
					Save refined
				</button>
				<button type="button" onClick={props.onCancel}>
					Cancel refine
				</button>
			</div>
		);
	},
}));

import { ReportPromptCard } from "@saas/reports/components/ReportPromptCard";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

const onUserPromptChange = vi.fn();
const onCustomTaskChange = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	m.enhancerProps = undefined;
});

function show({ readOnly = false, withRefine = true } = {}) {
	render(
		<ReportPromptCard
			userPrompt="Summarise the sprint."
			onUserPromptChange={onUserPromptChange}
			tasks={[
				{
					agentId: "default",
					task: "Find the risks.",
					outputVariable: "risks",
				},
			]}
			customTasks={{}}
			onCustomTaskChange={onCustomTaskChange}
			readOnly={readOnly}
			refine={withRefine ? { organizationId: "example-org" } : undefined}
		/>,
	);
}

const refineInstructions = () =>
	screen.queryByRole("button", {
		name: "Refine with AI: AI Instructions (User Prompt)",
	});
const refineTask = () =>
	screen.queryByRole("button", { name: "Refine with AI: AI Analysis" });

describe("ReportPromptCard Refine with AI", () => {
	it("hands the refined instructions back to the report", async () => {
		const user = userEvent.setup();
		show();

		await user.click(refineInstructions() as HTMLElement);

		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(m.agent).toBe("prompt_enhancer");
		expect(m.runtimeUrl).toBe("/api/copilotkit?organizationId=example-org");
		expect(m.enhancerProps?.initialContent).toBe("Summarise the sprint.");

		await user.click(screen.getByRole("button", { name: "Save refined" }));

		expect(onUserPromptChange).toHaveBeenCalledWith("A refined prompt.");
		expect(onCustomTaskChange).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("hands a refined AI task prompt back under its task key", async () => {
		const user = userEvent.setup();
		show();

		await user.click(refineTask() as HTMLElement);
		expect(m.enhancerProps?.initialContent).toBe("Find the risks.");
		await user.click(screen.getByRole("button", { name: "Save refined" }));

		expect(onCustomTaskChange).toHaveBeenCalledWith(
			"risks",
			"A refined prompt.",
		);
		expect(onUserPromptChange).not.toHaveBeenCalled();
	});

	it("leaves the prompt as it was when cancelled", async () => {
		const user = userEvent.setup();
		show();

		await user.click(refineInstructions() as HTMLElement);
		await user.click(screen.getByRole("button", { name: "Cancel refine" }));

		expect(onUserPromptChange).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("is not offered to someone who may only read the report", () => {
		show({ readOnly: true });

		expect(refineInstructions()).not.toBeInTheDocument();
		expect(refineTask()).not.toBeInTheDocument();
	});

	it("is not offered without a host for the assistant", () => {
		show({ withRefine: false });

		expect(refineInstructions()).not.toBeInTheDocument();
	});
});
