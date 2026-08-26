/**
 * Regression tests for the `stepsExpandable` prop on `<TrajectorySteps>`.
 *
 * Background:
 *   PR 1093 added a Fabric Loom UX rule: when a tool/skill card is
 *   rendered in the quick page copilot, it should be a static pill —
 *   no chevron, no click expansion, no JSON dump. That rule landed
 *   in two places:
 *     - `<Tool expandable={false}>` (apps/web/components/ai-elements/tool.tsx)
 *       handles the BOTTOM "skill · Completed" card rendered by
 *       <ToolCallList>.
 *     - But the inline trajectory steps inside the "Reasoning Trace"
 *       Collapsible (rendered by THIS component) still had their own
 *       per-step Collapsible that exposed Tool/Input/Output JSON on
 *       click. Users on staging saw the inline step expand to raw
 *       JSON even though the bottom card no longer did.
 *
 * This file pins the `stepsExpandable={false}` contract so a future
 * refactor cannot silently re-introduce the inline JSON dump in
 * Fabric Loom.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrajectorySteps, type TrajectoryStep } from "../TrajectorySteps";

const toolCallStep: TrajectoryStep = {
	id: "step-1",
	type: "tool_call",
	title: "Loaded skill visual-generate-plan",
	status: "success",
	duration: 240,
	metadata: {
		toolName: "load_skill",
		input: { slug: "visual-generate-plan" },
		output: {
			slug: "visual-generate-plan",
			name: "Visual Generate Plan",
			description:
				"Generate a visual HTML implementation plan with state machines, code snippets, and edge case analysis.",
			version: 1,
		},
	},
};

const reflectionStep: TrajectoryStep = {
	id: "step-2",
	type: "reflection",
	title: "Summarized findings",
	status: "success",
};

describe("<TrajectorySteps stepsExpandable={false}> — Fabric Loom static-row contract", () => {
	it("renders tool_call step WITHOUT a click-to-expand chevron", () => {
		render(
			<TrajectorySteps
				steps={[toolCallStep, reflectionStep]}
				defaultExpanded={true}
				stepsExpandable={false}
			/>,
		);
		// The outer "Reasoning Trace" Collapsible IS expandable — that's
		// a separate UX. We assert that THE STEP ROW itself does not
		// expose a per-step expand affordance.
		const stepLabel = screen.getByText(
			/Loaded skill visual-generate-plan/i,
		);
		// Walk up from the title text to the nearest CollapsibleTrigger
		// (the actual element with `aria-expanded`). It must be disabled
		// so users can't click to reveal the JSON panel.
		const trigger = stepLabel.closest(
			"[aria-expanded]",
		) as HTMLElement | null;
		expect(trigger).not.toBeNull();
		// The CollapsibleTrigger is `disabled` when `hasDetails` is false.
		// In our implementation, `hasDetails` is gated by `expandable` so
		// the trigger is disabled even when input/output are present.
		expect(trigger?.getAttribute("disabled")).not.toBeNull();
	});

	it("does NOT render the per-step Tool / Input / Output JSON panel", () => {
		const { container } = render(
			<TrajectorySteps
				steps={[toolCallStep]}
				defaultExpanded={true}
				stepsExpandable={false}
			/>,
		);
		// These three labels live inside the CollapsibleContent of a step
		// when expansion is allowed AND the user clicked the trigger.
		// With stepsExpandable=false the CollapsibleContent never mounts
		// because `hasDetails` is false (gate at TrajectorySteps.tsx ~line 209).
		const txt = container.textContent ?? "";
		expect(/^Tool:/m.test(txt)).toBe(false);
		expect(/^Input:/m.test(txt)).toBe(false);
		expect(/^Output:/m.test(txt)).toBe(false);
		// And no raw JSON output payload should appear either.
		expect(txt.includes("Visual Generate Plan")).toBe(false);
	});

	it("preserves thinking-step body text — Thought content is still visible (not gated)", () => {
		// Critical: the `stepsExpandable={false}` rule must NOT hide the
		// LLM thinking text. Thinking steps render their `description`
		// inline (not inside a Collapsible). If a future refactor moves
		// thinking text inside CollapsibleContent, this test catches it.
		const thinkingStep: TrajectoryStep = {
			id: "thinking-1",
			type: "thinking",
			title: "Thought",
			status: "success",
			duration: 1500,
			description:
				"I considered three implementation approaches before settling on the orchestrator pattern.",
		};
		render(
			<TrajectorySteps
				steps={[thinkingStep]}
				defaultExpanded={true}
				stepsExpandable={false}
			/>,
		);
		expect(
			screen.getByText(/I considered three implementation approaches/i),
		).toBeDefined();
	});
});

describe("<TrajectorySteps> default (stepsExpandable=true) — Orchestrator backward compat", () => {
	it("step trigger is enabled when input/output metadata is present", () => {
		// Existing Orchestrator chat behavior — users CAN click to reveal
		// Tool/Input/Output JSON. We must not break this when adding the
		// new prop with a true default.
		render(
			<TrajectorySteps
				steps={[toolCallStep]}
				defaultExpanded={true}
				// stepsExpandable omitted → defaults to true
			/>,
		);
		const stepLabel = screen.getByText(
			/Loaded skill visual-generate-plan/i,
		);
		const trigger = stepLabel.closest(
			"[aria-expanded]",
		) as HTMLElement | null;
		expect(trigger).not.toBeNull();
		// Should NOT be disabled — Orchestrator users keep their JSON drill-down.
		expect(trigger?.getAttribute("disabled")).toBeNull();
	});
});
