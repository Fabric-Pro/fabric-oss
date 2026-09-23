/**
 * Tool rows re-render only for the tool call that changed (Fizzy #2430,
 * review F30). The chat maps its tool calls to fresh `ToolCallItem`s on every
 * render; `toToolCallItems` keeps them stable while the source objects are,
 * and the memoized list and rows then skip every call that did not move.
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolCallList } from "../ToolCallList";
import { toToolCallItems } from "../tool-call-items";
import type { ToolCallItem } from "../types";

const headerRenders = vi.hoisted(() => [] as string[]);
vi.mock("../../../../../../../components/ai-elements/tool", () => ({
	Tool: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	ToolContent: () => null,
	ToolInput: () => null,
	ToolOutput: () => null,
	ToolHeader: ({ title }: { title: string }) => {
		headerRenders.push(title);
		return <span>{title}</span>;
	},
}));

type SourceCall = { name: string; status: ToolCallItem["status"] };

function items(calls: readonly SourceCall[]) {
	return toToolCallItems(calls, "msg-1", (tc, idx) => ({
		id: `msg-1-${idx}`,
		name: tc.name,
		args: {},
		status: tc.status,
	}));
}

function rendersOf(title: string) {
	return headerRenders.filter((t) => t === title).length;
}

describe("<ToolCallList> memoization", () => {
	it("keeps items stable while their source is", () => {
		const calls = [{ name: "a", status: "complete" as const }];
		expect(items(calls)).toBe(items(calls));
		expect(items(calls)[0]).toBe(items([calls[0]])[0]);
	});

	it("re-renders only the tool call that changed", () => {
		const done = { name: "code_search", status: "complete" as const };
		const running = { name: "web_search", status: "running" as const };
		const view = render(
			<ToolCallList toolCalls={items([done, running])} />,
		);

		// A re-render of the parent with the same source: nothing renders.
		view.rerender(<ToolCallList toolCalls={items([done, running])} />);
		expect(rendersOf("code_search")).toBe(1);
		expect(rendersOf("web_search")).toBe(1);

		// The running call completes: only its row renders again.
		view.rerender(
			<ToolCallList
				toolCalls={items([done, { ...running, status: "complete" }])}
			/>,
		);
		expect(rendersOf("code_search")).toBe(1);
		expect(rendersOf("web_search")).toBe(2);
	});
});
