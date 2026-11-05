import type { PromptResponseContract } from "@repo/ai/lib/prompt-response-contract";
import { PromptResponseSettings } from "@saas/prompts/components/PromptResponseSettings";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => {
	const { default: messages } = await import(
		"../../../../../../packages/i18n/translations/en.json"
	);
	return {
		useTranslations:
			(namespace: string) =>
			(key: string, values?: Record<string, string | number>) => {
				const section =
					namespace === "prompts.response"
						? messages.prompts.response
						: messages.prompts.workbench;
				let text = (section as Record<string, string>)[key];
				for (const [name, value] of Object.entries(values ?? {})) {
					text = text.replaceAll(`{${name}}`, String(value));
				}
				return text;
			},
	};
});

const m = vi.hoisted(() => ({ assist: vi.fn(), preview: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: { prompts: m } }));

import { PromptEditor } from "@saas/prompts/components/PromptEditor";
import { PromptWorkbenchPanel } from "@saas/prompts/components/PromptWorkbenchPanel";

const draft = {
	name: "Delivery",
	description: "Summarize",
	format: "HANDLEBARS" as const,
	content: "Summarize {{topic}}.",
};
beforeEach(() => {
	vi.resetAllMocks();
	m.assist.mockResolvedValue({
		message: "Review the proposal",
		proposal: { ...draft, content: "Cite sources for {{topic}}." },
	});
	m.preview.mockResolvedValue({
		output: "Actual model result",
		renderedPrompt: "Summarize release.",
	});
});
it("starts with a question without spending, and applies proposals only after review", async () => {
	const apply = vi.fn();
	render(
		<PromptWorkbenchPanel
			draft={draft}
			organizationId="example-org"
			onApply={apply}
		/>,
	);
	expect(
		screen.getByText(/What would you like this prompt/),
	).toBeInTheDocument();
	expect(m.assist).not.toHaveBeenCalled();
	fireEvent.change(screen.getByLabelText("Ask the prompt assistant"), {
		target: { value: "Improve citations" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Send request" }));
	await screen.findByText("Cite sources for {{topic}}.");
	expect(apply).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("button", { name: "Apply proposal to draft" }),
	);
	expect(apply).toHaveBeenCalledWith(
		expect.objectContaining({ content: "Cite sources for {{topic}}." }),
	);
});
it("refuses applying a stale proposal even when the draft changes while the request is pending", async () => {
	let resolve!: (x: unknown) => void;
	m.assist.mockReturnValue(
		new Promise((r) => {
			resolve = r;
		}),
	);
	const apply = vi.fn();
	const v = render(
		<PromptWorkbenchPanel
			draft={draft}
			organizationId="example-org"
			onApply={apply}
		/>,
	);
	fireEvent.change(screen.getByLabelText("Ask the prompt assistant"), {
		target: { value: "Improve citations" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Send request" }));
	v.rerender(
		<PromptWorkbenchPanel
			draft={{ ...draft, content: "Changed" }}
			organizationId="example-org"
			onApply={apply}
		/>,
	);
	resolve({ message: "Proposal", proposal: draft });
	await screen.findByText(/Your draft changed/);
	expect(
		screen.queryByRole("button", { name: "Apply proposal to draft" }),
	).not.toBeInTheDocument();
	expect(apply).not.toHaveBeenCalled();
});
it("runs supplied inputs, shows exact output and marks results stale after an edit", async () => {
	const v = render(
		<PromptWorkbenchPanel
			draft={draft}
			organizationId="example-org"
			onApply={vi.fn()}
			initialTab="try"
		/>,
	);
	fireEvent.change(screen.getByLabelText("topic"), {
		target: { value: "release" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Run preview" }));
	await screen.findByText("Actual model result");
	expect(m.preview).toHaveBeenCalledWith({
		organizationId: "example-org",
		draft,
		variables: { topic: "release" },
	});
	v.rerender(
		<PromptWorkbenchPanel
			draft={{ ...draft, content: "Changed" }}
			organizationId="example-org"
			onApply={vi.fn()}
			initialTab="try"
		/>,
	);
	expect(
		screen.getByText(/result belongs to the previous preview/),
	).toBeInTheDocument();
});
it("shows failures without claiming a successful preview or losing the draft", async () => {
	m.preview.mockRejectedValue(Error("provider secret-value"));
	render(
		<PromptWorkbenchPanel
			draft={draft}
			organizationId="example-org"
			onApply={vi.fn()}
			initialTab="try"
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Run preview" }));
	await screen.findByRole("alert");
	expect(screen.getByRole("alert").textContent).not.toContain("secret-value");
	expect(screen.queryByLabelText("Preview result")).not.toBeInTheDocument();
});
it("guards editor X and preserves text when staying", async () => {
	const close = vi.fn();
	render(
		<PromptEditor
			organizationId="example-org"
			initialData={{ ...draft, tags: [], scope: "ORG", isPublic: false }}
			onSave={vi.fn()}
			onCancel={close}
			canEditScope={false}
		/>,
	);
	fireEvent.change(screen.getByLabelText("Prompt content"), {
		target: { value: "Changed instructions" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Close prompt editor" }),
	);
	expect(close).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
	expect(screen.getByLabelText("Prompt content")).toHaveValue(
		"Changed instructions",
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Close prompt editor" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
	expect(close).toHaveBeenCalledTimes(1);
});

it("keeps submitted but unconfirmed creation data dirty", () => {
	const close = vi.fn();
	render(
		<PromptEditor
			organizationId="example-org"
			creating
			initialData={{ ...draft, tags: [], scope: "ORG", isPublic: false }}
			onSave={vi.fn()}
			onCancel={close}
			canEditScope={false}
		/>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Close prompt editor" }),
	);
	expect(close).not.toHaveBeenCalled();
	expect(
		screen.getByRole("dialog", { name: "Discard unsaved prompt changes?" }),
	).toBeInTheDocument();
});

it("places workbench tabs in the top header and preserves inputs, results and assistant draft across tab switches", async () => {
	const user = userEvent.setup();
	render(
		<PromptEditor
			organizationId="example-org"
			initialData={{ ...draft, tags: [], scope: "ORG", isPublic: false }}
			onSave={vi.fn()}
			onCancel={vi.fn()}
			canEditScope={false}
		/>,
	);
	const header = screen
		.getByRole("heading", { name: "Edit Delivery" })
		.closest("header");
	if (!header) {
		throw new Error("Editor header missing");
	}
	expect(
		within(header).getByRole("tab", { name: "Try prompt" }),
	).toHaveAttribute("aria-selected", "true");
	fireEvent.change(screen.getByLabelText("topic"), {
		target: { value: "release" },
	});
	await user.click(screen.getByRole("button", { name: "Run preview" }));
	await screen.findByText("Actual model result");
	await user.click(
		within(header).getByRole("tab", { name: "Assistant", exact: true }),
	);
	fireEvent.change(screen.getByLabelText("Ask the prompt assistant"), {
		target: { value: "Keep this request" },
	});
	await user.click(within(header).getByRole("tab", { name: "Try prompt" }));
	expect(screen.getByLabelText("topic")).toHaveValue("release");
	expect(screen.getByText("Actual model result")).toBeInTheDocument();
	await user.click(
		within(header).getByRole("tab", { name: "Assistant", exact: true }),
	);
	expect(screen.getByLabelText("Ask the prompt assistant")).toHaveValue(
		"Keep this request",
	);
	expect(screen.getByLabelText("Prompt content")).toHaveValue(draft.content);
	expect(m.preview).toHaveBeenCalledTimes(1);
	expect(m.assist).not.toHaveBeenCalled();
});

it("renders Markdown preview output as a readable result", async () => {
	m.preview.mockResolvedValue({
		output: "## Delivery summary\n\n**Ready to review**\n\n| Item | Status |\n| --- | --- |\n| Build | Passed |",
		renderedPrompt: "Summarize release.",
	});
	render(
		<PromptWorkbenchPanel
			draft={draft}
			organizationId="example-org"
			onApply={vi.fn()}
			initialTab="try"
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Run preview" }));
	const result = await screen.findByRole("region", {
		name: "Preview result",
	});
	expect(
		within(result).getByRole("heading", {
			name: "Delivery summary",
			level: 2,
		}),
	).toBeInTheDocument();
	expect(within(result).getByRole("table")).toBeInTheDocument();
	expect(within(result).getByText("Ready to review").tagName).toBe("STRONG");
});

it("keeps raw output and clipboard contents exact while offering formatted results", async () => {
	const user = userEvent.setup();
	const text = "## Release\n\n- Verified **build**\n- Review remaining";
	m.preview.mockResolvedValue({
		output: text,
		renderedPrompt: "Summarize release.",
	});
	const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
	render(
		<PromptWorkbenchPanel
			draft={draft}
			organizationId="example-org"
			onApply={vi.fn()}
			initialTab="try"
		/>,
	);
	await user.click(screen.getByRole("button", { name: "Run preview" }));
	const result = await screen.findByRole("region", {
		name: "Preview result",
	});
	expect(
		within(result).getByRole("heading", { name: "Release" }),
	).toBeInTheDocument();
	await user.click(within(result).getByRole("tab", { name: "Raw text" }));
	expect(
		within(result).getByText(text, {
			exact: true,
			normalizer: (value) => value,
		}).tagName,
	).toBe("PRE");
	await user.click(
		within(result).getByRole("button", { name: "Copy result" }),
	);
	expect(copy).toHaveBeenCalledWith(text);
	expect(
		within(result).getByRole("button", { name: "Copied" }),
	).toBeInTheDocument();
	await user.click(within(result).getByRole("tab", { name: "Formatted" }));
	expect(
		within(result).getByRole("heading", { name: "Release" }),
	).toBeInTheDocument();
	copy.mockRestore();
});
it("does not execute model markup or fetch images when formatting output", async () => {
	m.preview.mockResolvedValue({
		output: "<script>window.previewInjection = true</script>\n\n![Tracker](https://example.com/track.png)\n\n[Unsafe](javascript:alert(1))",
		renderedPrompt: "Summarize release.",
	});
	render(
		<PromptWorkbenchPanel
			draft={draft}
			organizationId="example-org"
			onApply={vi.fn()}
			initialTab="try"
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Run preview" }));
	const result = await screen.findByRole("region", {
		name: "Preview result",
	});
	expect(result.querySelector("script")).toBeNull();
	expect(result.querySelector("img")).toBeNull();
	expect(result.querySelector('a[href^="javascript:"]')).toBeNull();
	expect(within(result).getByText("[Image: Tracker]")).toBeInTheDocument();
});
it("offers manual selection if clipboard access is unavailable", async () => {
	const user = userEvent.setup();
	const copy = vi
		.spyOn(navigator.clipboard, "writeText")
		.mockRejectedValue(Error("Clipboard denied"));
	render(
		<PromptWorkbenchPanel
			draft={draft}
			organizationId="example-org"
			onApply={vi.fn()}
			initialTab="try"
		/>,
	);
	await user.click(screen.getByRole("button", { name: "Run preview" }));
	await user.click(
		await screen.findByRole("button", { name: "Copy result" }),
	);
	expect(await screen.findByRole("status")).toHaveTextContent(
		"Open Raw text",
	);
	expect(screen.getByText("Actual model result")).toBeInTheDocument();
	copy.mockRestore();
});

it("builds JSON response expectations with fields and reports validation separately from execution", async () => {
	const user = userEvent.setup();
	m.preview.mockResolvedValue({
		output: '{"summary":"Ready"}',
		renderedPrompt: "Summarize release.",
		responseFormat: "JSON",
		validation: { status: "passed", issues: [] },
	});
	render(
		<PromptWorkbenchPanel
			draft={draft}
			organizationId="example-org"
			onApply={vi.fn()}
			initialTab="try"
		/>,
	);
	await user.click(screen.getByLabelText("Expected response"));
	await user.click(
		screen.getByRole("option", { name: "JSON with expected fields" }),
	);
	expect(screen.getByLabelText("Field 1 name")).toHaveValue("summary");
	await user.click(screen.getByRole("button", { name: "Run preview" }));
	await screen.findByText("JSON schema passed");
	expect(m.preview).toHaveBeenCalledWith(
		expect.objectContaining({
			draft: expect.objectContaining({
				responseContract: expect.objectContaining({
					format: "JSON",
					schema: expect.objectContaining({ required: ["summary"] }),
				}),
			}),
		}),
	);
});
it("preserves malformed schema text across tabs and blocks saving and model spending", async () => {
	const user = userEvent.setup();
	render(
		<PromptEditor
			organizationId="example-org"
			initialData={{ ...draft, tags: [], scope: "ORG", isPublic: false }}
			onSave={vi.fn()}
			onCancel={vi.fn()}
		/>,
	);
	await user.click(screen.getByLabelText("Expected response"));
	await user.click(
		screen.getByRole("option", { name: "JSON with expected fields" }),
	);
	await user.click(screen.getByText("Advanced JSON schema"));
	fireEvent.change(screen.getByLabelText("Response JSON schema"), {
		target: { value: "{" },
	});
	expect(screen.getByRole("button", { name: "Run preview" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
	await user.click(
		screen.getByRole("tab", { name: "Assistant", exact: true }),
	);
	await user.click(
		screen.getByRole("tab", { name: "Try prompt", exact: true }),
	);
	expect(screen.getByLabelText("Response JSON schema")).toHaveValue("{");
	expect(m.preview).not.toHaveBeenCalled();
});

it("does not discard a saved template engine when named inputs are switched off and on", () => {
	const save = vi.fn();
	render(
		<PromptEditor
			organizationId="example-org"
			initialData={{
				...draft,
				format: "LIQUID",
				scope: "ORG",
				tags: [],
				isPublic: false,
			}}
			onSave={save}
			onCancel={vi.fn()}
		/>,
	);
	fireEvent.click(screen.getByRole("checkbox", { name: "Use named inputs" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Use named inputs" }));
	fireEvent.change(screen.getByLabelText("Prompt content"), {
		target: { value: "Updated instructions" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
	expect(save).toHaveBeenCalledWith(
		expect.objectContaining({ format: "LIQUID" }),
	);
});
it("preserves unsupported saved response settings instead of saving AUTO", () => {
	const save = vi.fn();
	render(
		<PromptEditor
			organizationId="example-org"
			responseContractError="Unsupported saved response settings"
			initialData={{ ...draft, scope: "ORG", tags: [], isPublic: false }}
			onSave={save}
			onCancel={vi.fn()}
		/>,
	);
	expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Run preview" })).toBeDisabled();
	expect(screen.getByRole("alert")).toHaveTextContent(
		"Unsupported saved response settings",
	);
	expect(save).not.toHaveBeenCalled();
});
it("does not write an explicit AUTO contract when creating an ordinary prompt", () => {
	const save = vi.fn();
	render(
		<PromptEditor
			creating
			organizationId="example-org"
			initialData={{ ...draft, scope: "ORG", tags: [], isPublic: false }}
			onSave={save}
			onCancel={vi.fn()}
		/>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Create organization prompt" }),
	);
	expect(save).toHaveBeenCalled();
	expect(save.mock.calls[0][0]).not.toHaveProperty("responseContract");
});

it("keeps JSON field metadata and order, and resets a refused duplicate name", async () => {
	const changed = vi.fn();
	function Settings() {
		const [value, setValue] = useState<PromptResponseContract>({
			format: "JSON",
			schema: {
				type: "object",
				properties: {
					first: {
						type: "string",
						title: "Delivery",
						description: "Keep this guidance",
					},
					second: { type: "boolean" },
				},
				required: ["first"],
			},
		});
		return (
			<PromptResponseSettings
				value={value}
				onChange={(next) => {
					setValue(next);
					changed(next);
				}}
				onError={vi.fn()}
			/>
		);
	}
	render(<Settings />);
	const first = screen.getByRole("textbox", { name: "Field 1 name" });
	fireEvent.change(first, { target: { value: "second" } });
	fireEvent.blur(first);
	expect(first).toHaveValue("first");
	expect(changed).not.toHaveBeenCalled();
	fireEvent.change(first, { target: { value: "summary" } });
	fireEvent.blur(first);
	const schema = changed.mock.calls.at(-1)?.[0].schema;
	expect(Object.keys(schema.properties)).toEqual(["summary", "second"]);
	expect(schema.properties.summary).toEqual({
		type: "string",
		title: "Delivery",
		description: "Keep this guidance",
	});
	expect(schema.required).toEqual(["summary"]);
});
