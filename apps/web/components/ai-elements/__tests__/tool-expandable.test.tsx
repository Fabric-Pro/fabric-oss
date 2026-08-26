/**
 * Regression tests for the `expandable` prop on the `<Tool>` component.
 *
 * Context: Fabric Loom (the launcher chat that opens from the floating
 * Fabric Agent button) renders one assistant turn per skill/tool invocation.
 * Historically each call was a `<button>` whose header opened a panel
 * dumping raw `PARAMETERS` and `RESULT` JSON. That's useful in the
 * Orchestrator chat (where authors debug agent runs) but noisy in the quick
 * page copilot. PR adds an `expandable` prop (default `true` for backward
 * compat) so call sites can opt into a static pill rendering.
 *
 * These tests pin the contract so a future refactor of `ToolHeader` /
 * `ToolContent` can't silently re-introduce expansion in Fabric Loom.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "../tool";

describe("<Tool> — expandable prop", () => {
	it("renders ToolHeader as a button by default (expandable defaults to true)", () => {
		render(
			<Tool toolName="load_skill" toolState="output-available">
				<ToolHeader
					title="load_skill"
					type="tool-invocation"
					state="output-available"
				/>
				<ToolContent>
					<ToolInput input={{ slug: "x" }} />
				</ToolContent>
			</Tool>,
		);
		// Header is a button → user can click to expand.
		const header = screen.getByRole("button", { name: /load_skill/i });
		expect(header).toBeDefined();
	});

	it("renders ToolHeader as a static row when expandable=false (no button, no chevron)", () => {
		render(
			<Tool
				toolName="load_skill"
				toolState="output-available"
				expandable={false}
			>
				<ToolHeader
					title="load_skill"
					type="tool-invocation"
					state="output-available"
				/>
				<ToolContent>
					<ToolInput input={{ slug: "x" }} />
				</ToolContent>
			</Tool>,
		);
		// No button in the header — Fabric Loom shows a plain pill.
		expect(screen.queryByRole("button")).toBeNull();
		// Title still rendered for context.
		expect(screen.getByText("load_skill")).toBeDefined();
		// Chevron is identified by a stable data-testid so a future
		// lucide-react class-name change can't silently bypass the
		// assertion. The static-row variant emits no chevron at all
		// (PR 1093 review #5).
		expect(screen.queryByTestId("tool-chevron")).toBeNull();
		// Header still emits a data-testid="tool-header" with
		// data-expandable="false" so e2e tests can target it.
		const header = screen.getByTestId("tool-header");
		expect(header.getAttribute("data-expandable")).toBe("false");
	});

	it("suppresses ToolContent (JSON params/result) when expandable=false, even with defaultExpanded=true", () => {
		// The `defaultExpanded` prop is what historical call sites use to
		// pre-open the panel. We must not let it leak through when the
		// surface explicitly opted out via expandable=false — otherwise a
		// previously-expanded Tool would still dump JSON on re-render.
		const { container } = render(
			<Tool
				toolName="load_skill"
				toolState="output-available"
				expandable={false}
				defaultExpanded={true}
			>
				<ToolHeader
					title="load_skill"
					type="tool-invocation"
					state="output-available"
				/>
				<ToolContent>
					<div data-testid="content-marker">should-not-render</div>
					<ToolInput input={{ slug: "visual-generate-plan" }} />
					<ToolOutput
						output="raw result text"
						errorText={undefined}
					/>
				</ToolContent>
			</Tool>,
		);
		// Inner sentinel never reached.
		expect(screen.queryByTestId("content-marker")).toBeNull();
		// "Parameters" header from ToolInput never reached.
		expect(screen.queryByText(/parameters/i)).toBeNull();
		// "Result" header from ToolOutput never reached.
		expect(screen.queryByText(/^result$/i)).toBeNull();
		// And no raw output payload either.
		expect(container.textContent?.includes("raw result text")).toBe(false);
	});

	it("suppresses ToolContent across remount when expandedStateMap previously carried expanded=true (PR 1093 review #3)", () => {
		// The `Tool` component persists per-toolId expansion in a
		// module-scope `expandedStateMap` so an unmount/remount restores
		// state. That's helpful in the Orchestrator chat but dangerous
		// for Fabric Loom: if a user previously expanded the SAME toolId
		// on a different surface and the same tool then re-renders with
		// `expandable={false}`, the stale `true` flag could leak JSON
		// back into the pill UX. The `if (!expandable || !expanded)`
		// guard in ToolContent (tool.tsx:622) is what blocks this. This
		// test pins that guard against future regressions.
		const sharedId = "shared-tool-id-cross-remount";

		// Step 1: render expandable=true with defaultExpanded=true so
		// the map gets seeded with `sharedId => true`.
		const { rerender, container } = render(
			<Tool
				toolId={sharedId}
				toolName="load_skill"
				toolState="output-available"
				expandable={true}
				defaultExpanded={true}
			>
				<ToolHeader
					title="load_skill"
					type="tool-invocation"
					state="output-available"
				/>
				<ToolContent>
					<div data-testid="content-marker">visible-then-hidden</div>
					<ToolInput input={{ slug: "visual-generate-plan" }} />
				</ToolContent>
			</Tool>,
		);
		// Sanity: content IS visible on the first (expandable) render.
		expect(screen.getByTestId("content-marker")).toBeDefined();

		// Step 2: re-render the SAME toolId with expandable=false.
		// The module-scope expandedStateMap still has `true` for sharedId.
		// Without the `!expandable` guard in ToolContent, the content
		// would leak through.
		rerender(
			<Tool
				toolId={sharedId}
				toolName="load_skill"
				toolState="output-available"
				expandable={false}
			>
				<ToolHeader
					title="load_skill"
					type="tool-invocation"
					state="output-available"
				/>
				<ToolContent>
					<div data-testid="content-marker">visible-then-hidden</div>
					<ToolInput input={{ slug: "visual-generate-plan" }} />
				</ToolContent>
			</Tool>,
		);

		// Content must now be gone despite the persisted expanded=true.
		expect(screen.queryByTestId("content-marker")).toBeNull();
		expect(screen.queryByText(/parameters/i)).toBeNull();
		expect(container.textContent?.includes("visible-then-hidden")).toBe(
			false,
		);
	});

	it("preserves existing expandable behavior when expandable is omitted (backward compat)", () => {
		// This is the default contract every Orchestrator-chat call site
		// relies on. The button must remain clickable; ToolContent only
		// renders after the user opens it (`defaultExpanded={true}`).
		render(
			<Tool
				toolName="excel_executor"
				toolState="output-available"
				defaultExpanded={true}
			>
				<ToolHeader
					title="excel_executor"
					type="tool-invocation"
					state="output-available"
				/>
				<ToolContent>
					<ToolInput input={{ path: "/x.xlsx" }} />
				</ToolContent>
			</Tool>,
		);
		// Header still a button.
		const header = screen.getByRole("button", { name: /excel_executor/i });
		expect(header).toBeDefined();
		// Content visible because defaultExpanded was honored.
		expect(screen.getByText(/parameters/i)).toBeDefined();
	});
});
