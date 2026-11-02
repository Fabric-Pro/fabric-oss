import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatComposerHeader } from "../ChatComposerHeader";

describe("ChatComposerHeader", () => {
	it("reserves both control rows in the server render before selection resolves", () => {
		const html = renderToString(
			<ChatComposerHeader showSelection showActions selection={null}>
				{null}
			</ChatComposerHeader>,
		);
		expect(html.match(/h-12/g)).toHaveLength(2);
	});
	it("omits the selection row on surfaces without that capability", () => {
		const html = renderToString(
			<ChatComposerHeader
				showSelection={false}
				showActions
				selection={null}
			>
				<button type="button">Chat tools</button>
			</ChatComposerHeader>,
		);
		expect(html.match(/h-12/g)).toHaveLength(1);
	});
	it("omits the empty actions row on a simple surface", () => {
		const html = renderToString(
			<ChatComposerHeader
				showSelection
				showActions={false}
				selection={<button type="button">Models</button>}
			>
				{null}
			</ChatComposerHeader>,
		);
		expect(html.match(/h-12/g)).toHaveLength(1);
	});
	it("reserves configured actions while their mounted controls are unresolved", () => {
		const { container, rerender } = render(
			<ChatComposerHeader
				showSelection={false}
				showActions
				selection={null}
			>
				{null}
			</ChatComposerHeader>,
		);
		const row = container.firstElementChild?.firstElementChild;
		rerender(
			<ChatComposerHeader
				showSelection={false}
				showActions
				selection={null}
			>
				<button type="button">Chat tools</button>
			</ChatComposerHeader>,
		);
		expect(
			screen.getByRole("button", { name: "Chat tools" }).parentElement,
		).toBe(row);
	});
	it("keeps delayed selection and actions in separate scrollable rows", () => {
		const { container, rerender } = render(
			<ChatComposerHeader showSelection showActions selection={null}>
				<button type="button">Chat tools</button>
			</ChatComposerHeader>,
		);
		const selectionRow = container.firstElementChild?.firstElementChild;
		const actionsRow = screen.getByRole("button", {
			name: "Chat tools",
		}).parentElement;
		rerender(
			<ChatComposerHeader
				showSelection
				showActions
				selection={
					<>
						<button type="button">Agents & models</button>
						<button type="button">Clear delayed agent</button>
					</>
				}
			>
				<button type="button">Chat tools</button>
			</ChatComposerHeader>,
		);
		expect(
			screen.getByRole("button", { name: "Agents & models" })
				.parentElement,
		).toBe(selectionRow);
		expect(
			screen.getByRole("button", { name: "Clear delayed agent" })
				.parentElement,
		).toBe(selectionRow);
		expect(
			screen.getByRole("button", { name: "Chat tools" }).parentElement,
		).toBe(actionsRow);
		for (const row of [selectionRow, actionsRow]) {
			expect(row).toHaveClass(
				"h-12",
				"overflow-x-auto",
				"whitespace-nowrap",
			);
			expect(row).not.toHaveClass("flex-wrap", "overflow-hidden");
		}
		screen.getByRole("button", { name: "Clear delayed agent" }).focus();
		expect(
			screen.getByRole("button", { name: "Clear delayed agent" }),
		).toHaveFocus();
	});
});
