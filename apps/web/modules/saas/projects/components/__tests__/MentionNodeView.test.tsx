import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MentionStatusContext } from "../../lib/mention-status-context";
import { MentionNodeView } from "../MentionNodeView";

function mockNodeProps(
	overrides: Partial<{ id: string; label: string; anchorId: string }> = {},
) {
	return {
		node: {
			attrs: {
				id: overrides.id ?? "user_active",
				label: overrides.label ?? "Daisy Q.",
				anchorId: overrides.anchorId ?? "m_xyz",
			},
		},
	} as any;
}

function mockNodeAttrs(
	attrs: Partial<{
		id: string | null;
		label: string;
		mentionId: string | null;
		anchorId: string | null;
		groupTag: string | null;
	}>,
) {
	return {
		node: {
			attrs: {
				id: null,
				label: "",
				mentionId: null,
				anchorId: null,
				groupTag: null,
				...attrs,
			},
		},
	} as any;
}

describe("MentionNodeView", () => {
	it("renders active chip when id is in context", () => {
		render(
			<MentionStatusContext.Provider value={new Set(["user_active"])}>
				<MentionNodeView {...mockNodeProps()} />
			</MentionStatusContext.Provider>,
		);
		const chip = screen.getByText("@Daisy Q.");
		expect(chip).toHaveClass("mention");
		expect(chip).not.toHaveClass("mention--inactive");
		expect(chip.getAttribute("aria-label")).toBe("mention: Daisy Q.");
	});

	it("renders inactive chip when id is missing from context", () => {
		render(
			<MentionStatusContext.Provider value={new Set(["other_user"])}>
				<MentionNodeView {...mockNodeProps({ id: "user_removed" })} />
			</MentionStatusContext.Provider>,
		);
		const chip = screen.getByText("@Daisy Q.");
		expect(chip).toHaveClass("mention--inactive");
		expect(chip.getAttribute("aria-label")).toBe(
			"mention: Daisy Q. (no longer active)",
		);
	});

	it("renders as active when context is null (loading state)", () => {
		render(
			<MentionStatusContext.Provider value={null}>
				<MentionNodeView {...mockNodeProps()} />
			</MentionStatusContext.Provider>,
		);
		const chip = screen.getByText("@Daisy Q.");
		expect(chip).not.toHaveClass("mention--inactive");
	});

	it("renders a group chip with data-group-tag and data-mention-id when groupTag is set", () => {
		render(
			<MentionStatusContext.Provider value={null}>
				<MentionNodeView
					{...mockNodeAttrs({
						groupTag: "DEVELOPER",
						label: "Developers",
						mentionId: "m_g",
						id: null,
					})}
				/>
			</MentionStatusContext.Provider>,
		);
		const chip = screen.getByText("@Developers");
		expect(chip).toHaveClass("mention");
		expect(chip).toHaveClass("mention-group");
		expect(chip.getAttribute("data-group-tag")).toBe("DEVELOPER");
		expect(chip.getAttribute("data-mention-id")).toBe("m_g");
	});

	it("renders data-mention-id from mentionId for a user node (deep-link fix)", () => {
		render(
			<MentionStatusContext.Provider value={null}>
				<MentionNodeView
					{...mockNodeAttrs({
						id: "u1",
						label: "Alice",
						mentionId: "m_u",
						groupTag: null,
					})}
				/>
			</MentionStatusContext.Provider>,
		);
		const chip = screen.getByText("@Alice");
		expect(chip.getAttribute("data-mention-id")).toBe("m_u");
	});
});
