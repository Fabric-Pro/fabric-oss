import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	type EditableKnowledgePack,
	KnowledgePacksEditor,
} from "../KnowledgePacksEditor";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

function renderEditor(packs: EditableKnowledgePack[] = []) {
	const onChange = vi.fn();
	render(<KnowledgePacksEditor packs={packs} onChange={onChange} />);
	return { onChange };
}

describe("KnowledgePacksEditor", () => {
	it("shows an empty state when there are no packs", () => {
		renderEditor([]);
		expect(screen.getByText(/no knowledge packs/i)).toBeInTheDocument();
	});

	it("adds a new empty pack on 'Add pack'", async () => {
		const user = userEvent.setup();
		const { onChange } = renderEditor([]);
		await user.click(screen.getByRole("button", { name: /add pack/i }));
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0] as EditableKnowledgePack[];
		expect(next).toHaveLength(1);
		expect(next[0].title).toBe("");
		expect(next[0].content).toBe("");
	});

	it("edits a pack's title and emits the updated array", async () => {
		const user = userEvent.setup();
		const { onChange } = renderEditor([
			{ id: "p1", title: "Threat model", content: "details" },
		]);
		const title = screen.getByLabelText("Title") as HTMLInputElement;
		await user.type(title, "!");
		const last = onChange.mock.calls.at(-1)?.[0] as EditableKnowledgePack[];
		expect(last[0].title.endsWith("!")).toBe(true);
	});

	it("removes a pack after confirming", async () => {
		const user = userEvent.setup();
		const { onChange } = renderEditor([
			{ id: "p1", title: "Threat model", content: "details" },
		]);
		await user.click(
			screen.getByRole("button", { name: /remove knowledge pack/i }),
		);
		// Confirm dialog.
		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", { name: /^remove$/i }),
		);
		expect(onChange).toHaveBeenCalledWith([]);
	});

	it("explains the apply-on-next-scan behavior via the (i) note", async () => {
		const user = userEvent.setup();
		renderEditor([]);
		await user.click(
			screen.getByRole("button", { name: /about knowledge packs/i }),
		);
		expect(screen.getByText(/apply on the next scan/i)).toBeInTheDocument();
	});
});
