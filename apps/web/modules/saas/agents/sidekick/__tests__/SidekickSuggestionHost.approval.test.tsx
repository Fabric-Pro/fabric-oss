import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ accept: vi.fn(), apply: vi.fn() }));
vi.mock("../SidekickFormContext", () => ({
	useSidekickForm: () => ({ setFormField: h.apply }),
}));
vi.mock("../SidekickSuggestionsContext", () => ({
	useSidekickSuggestions: () => ({
		getSuggestion: () => ({
			id: "example-suggestion",
			kind: "tools",
			state: "pending",
			title: "Example MCP tool",
			description: "Add the reviewed tool",
			payload: { action: "add", toolId: "mcp:example-server" },
		}),
		triggerRefetch: vi.fn(),
		hasAttemptedRefetch: () => false,
		acceptSuggestion: h.accept,
		rejectSuggestion: vi.fn(),
	}),
}));

import { SidekickSuggestionHost } from "../markdown/SidekickSuggestionHost";

beforeEach(() => {
	h.accept.mockReset();
	h.apply.mockReset();
});
describe("persisted tool suggestion approval", () => {
	it("leaves tool permissions unchanged when approval fails", async () => {
		h.accept.mockResolvedValue(false);
		const view = render(
			<SidekickSuggestionHost sid="example-suggestion" kind="tools" />,
		);
		fireEvent.click(
			view.getByRole("button", { name: "Accept suggestion" }),
		);
		await waitFor(() => expect(h.accept).toHaveBeenCalledTimes(1));
		expect(h.apply).not.toHaveBeenCalled();
	});
	it("waits for approval to succeed and disables conflicting actions while it is pending", async () => {
		let resolve!: (value: boolean) => void;
		h.accept.mockReturnValue(
			new Promise<boolean>((done) => {
				resolve = done;
			}),
		);
		const view = render(
			<SidekickSuggestionHost sid="example-suggestion" kind="tools" />,
		);
		fireEvent.click(
			view.getByRole("button", { name: "Accept suggestion" }),
		);
		expect(
			view.getByRole("button", { name: "Reject suggestion" }),
		).toBeDisabled();
		expect(h.apply).not.toHaveBeenCalled();
		resolve(true);
		await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
		const [field, update] = h.apply.mock.calls[0];
		expect(field).toBe("tools");
		expect(update([])).toEqual([
			{ id: "mcp:example-server", name: "Example MCP tool" },
		]);
	});
});
