/**
 * Fizzy #2393 — the AI-free fallback for the document editor.
 *
 * The panel must render the saved markdown read-only, surface the caught
 * error, and offer a reload — all without touching a CopilotKit hook, since
 * it is mounted precisely when no `<CopilotKit>` provider exists above it.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// If the panel ever imports CopilotKit, this makes the suite fail loudly
// rather than passing on a hook that happens not to run in jsdom.
vi.mock("@copilotkit/react-core", () => {
	throw new Error(
		"DocumentEditorAiUnavailable must not import @copilotkit/react-core",
	);
});

import { DocumentEditorAiUnavailable } from "@saas/projects/components/DocumentEditorAiUnavailable";

describe("DocumentEditorAiUnavailable", () => {
	it("renders the document markdown read-only with the caught error", () => {
		render(
			<DocumentEditorAiUnavailable
				content={"# Release plan\n\nShip **Tuesday**."}
				error={new Error("Remember to wrap your app in a <CopilotKit>")}
				onReload={vi.fn()}
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"The document assistant could not start",
		);
		expect(
			screen.getByText("Remember to wrap your app in a <CopilotKit>"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { level: 1, name: "Release plan" }),
		).toBeInTheDocument();
		expect(screen.getByText("Tuesday").tagName).toBe("STRONG");
	});

	it("calls the reload handler from the button", () => {
		const onReload = vi.fn();
		render(
			<DocumentEditorAiUnavailable
				content="body"
				error={null}
				onReload={onReload}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /reload page/i }));
		expect(onReload).toHaveBeenCalledTimes(1);
	});

	it("explains an empty document instead of rendering nothing", () => {
		render(
			<DocumentEditorAiUnavailable
				content="   "
				error={null}
				onReload={vi.fn()}
			/>,
		);
		expect(
			screen.getByText("This document has no content yet."),
		).toBeInTheDocument();
	});
});
