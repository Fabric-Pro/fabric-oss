import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactsPanel } from "../orchestrator/ArtifactsPanel";

afterEach(cleanup);
const documents = [
	{
		id: "example-document",
		title: "Example brief",
		type: "markdown" as const,
		content:
			"## Delivery brief\n\n| Item | Status |\n| --- | --- |\n| Example task | Done |",
	},
];

describe("Genie deliverable inspection", () => {
	it("opens a populated documents tab instead of an empty plan and renders Markdown", async () => {
		render(
			<ArtifactsPanel isOpen onClose={vi.fn()} documents={documents} />,
		);
		expect(screen.getByRole("tab", { name: /Documents/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		fireEvent.click(screen.getByRole("button", { name: "Example brief" }));
		expect(
			await screen.findByRole("heading", { name: "Delivery brief" }),
		).toBeVisible();
		expect(screen.getByRole("table")).toBeVisible();
	});
	it("retains the chosen tab while new content arrives and chooses a useful tab on reopening", async () => {
		const user = userEvent.setup();
		const view = render(
			<ArtifactsPanel isOpen onClose={vi.fn()} documents={documents} />,
		);
		await user.click(screen.getByRole("tab", { name: "Sources" }));
		view.rerender(
			<ArtifactsPanel
				isOpen
				onClose={vi.fn()}
				documents={documents}
				sources={[
					{
						id: "example-source",
						title: "Example notes",
						type: "document",
					},
				]}
			/>,
		);
		expect(screen.getByRole("tab", { name: "Sources 1" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		view.rerender(<ArtifactsPanel isOpen={false} onClose={vi.fn()} />);
		view.rerender(
			<ArtifactsPanel
				isOpen
				onClose={vi.fn()}
				sources={[
					{
						id: "example-source",
						title: "Example notes",
						type: "document",
					},
				]}
			/>,
		);
		expect(screen.getByRole("tab", { name: "Sources 1" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});
	it("keeps generated HTML inert during document inspection", async () => {
		const { container } = render(
			<ArtifactsPanel
				isOpen
				onClose={vi.fn()}
				documents={[
					{
						...documents[0],
						type: "html",
						content:
							"<script>window.exampleExecuted=true</script><h1>Example HTML</h1>",
					},
				]}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Example brief" }));
		expect(await screen.findByText(/window.exampleExecuted/)).toBeVisible();
		expect(container.querySelector("script")).toBeNull();
	});
});

it("switches an automatic empty fallback to the first populated tab", () => {
	const view = render(<ArtifactsPanel isOpen onClose={vi.fn()} />);
	expect(screen.getByRole("tab", { name: /Plan/ })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	view.rerender(
		<ArtifactsPanel isOpen onClose={vi.fn()} documents={documents} />,
	);
	expect(screen.getByRole("tab", { name: /Documents/ })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});

it("respects an explicit empty-tab choice when content subsequently arrives", async () => {
	const user = userEvent.setup();
	const view = render(<ArtifactsPanel isOpen onClose={vi.fn()} />);
	await user.click(screen.getByRole("tab", { name: /Sources/ }));
	view.rerender(
		<ArtifactsPanel isOpen onClose={vi.fn()} documents={documents} />,
	);
	expect(screen.getByRole("tab", { name: /Sources/ })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});

it("keeps literal document content and authored headings intact in preview", async () => {
	const content =
		"# Authored document\n\n```text\n• literal item\n1) literal instruction\n“literal quotes”\n```";
	render(
		<ArtifactsPanel
			isOpen
			onClose={vi.fn()}
			documents={[{ ...documents[0], content }]}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Example brief" }));
	expect(
		await screen.findByRole("heading", { name: "Authored document" }),
	).toHaveProperty("tagName", "H1");
	expect(
		screen.getByText(
			(_text, node) =>
				node?.tagName === "CODE" &&
				node.textContent?.includes("• literal item") === true,
		),
	).toHaveTextContent("1) literal instruction “literal quotes”");
});
