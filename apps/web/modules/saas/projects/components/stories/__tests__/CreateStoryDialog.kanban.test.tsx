/**
 * Unit tests for the Kanban `CreateStoryDialog` (StoriesRoadmap.tsx).
 *
 * Verifies the spec §4.2 form-shape:
 *   - No title input is rendered (server generates the title).
 *   - Description is required.
 *   - Submit is disabled while description is empty.
 *   - Submit calls `onSubmit` with `{ description, ... }` and NO `title` field.
 *
 * Plus the AI title-generation toast lifecycle:
 *   - `toast.loading` fires on submit with the `create.titleGenerating` key.
 *   - On success the loading toast is upgraded in-place to `toast.success`
 *     via the sonner `{ id }` idiom (`create.titleGenerated`).
 *   - On `titleSource: "untitled-fallback"` (kebab-case helper output) OR the
 *     SCREAMING_SNAKE `"UNTITLED_FALLBACK"` Prisma enum value, a separate
 *     `toast.warning` fires with `create.titleInsufficient`.
 *   - On `titleSource: "ai"` no `toast.warning` fires.
 *   - On mutation rejection the loading toast becomes `toast.error`
 *     (`create.titleGenerationFailed`) with the same id.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	(globalThis.URL.createObjectURL as unknown) = vi.fn(() => "blob:fake-url");
	(globalThis.URL.revokeObjectURL as unknown) = vi.fn();
});

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

// Sonner exposes named functions on the `toast` object. Each named branch
// (`loading`, `success`, `error`, `warning`) must be independently mockable so
// the test can assert the id-update idiom across toast types.
const toastLoading = vi.fn(() => "toast-id-1");
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		loading: (...args: unknown[]) => toastLoading(...args),
		success: (...args: unknown[]) => toastSuccess(...args),
		error: (...args: unknown[]) => toastError(...args),
		warning: (...args: unknown[]) => toastWarning(...args),
	},
}));

import { CreateStoryDialog } from "../CreateStoryDialog";

function makeProps(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		open: true,
		onOpenChange: vi.fn(),
		statusId: "status-1",
		statuses: [],
		projectId: "project-1",
		onSubmit: vi.fn(),
		isSubmitting: false,
		...overrides,
	};
}

describe("CreateStoryDialog (Kanban)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not render a title input", () => {
		render(
			<CreateStoryDialog
				{...(makeProps() as React.ComponentProps<
					typeof CreateStoryDialog
				>)}
			/>,
		);

		// No element labelled "Title" exists.
		const labels = screen.queryAllByText(/^title$/i);
		expect(labels).toHaveLength(0);
		// The textarea uses the new translation key `descriptionLabel`.
		expect(screen.getByLabelText("descriptionLabel")).toBeInTheDocument();
	});

	it("renders a required description textarea bound to the descriptionLabel key", () => {
		render(
			<CreateStoryDialog
				{...(makeProps() as React.ComponentProps<
					typeof CreateStoryDialog
				>)}
			/>,
		);

		const textarea = screen.getByLabelText(
			"descriptionLabel",
		) as HTMLTextAreaElement;
		expect(textarea.required).toBe(true);
	});

	it("disables submit while description is empty", () => {
		render(
			<CreateStoryDialog
				{...(makeProps() as React.ComponentProps<
					typeof CreateStoryDialog
				>)}
			/>,
		);

		const submit = screen.getByRole("button", { name: /^create$/i });
		expect(submit).toBeDisabled();
	});

	it("calls onSubmit with { description, ... } and NO title field", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<CreateStoryDialog
				{...(makeProps({ onSubmit }) as React.ComponentProps<
					typeof CreateStoryDialog
				>)}
			/>,
		);

		const textarea = screen.getByLabelText(
			"descriptionLabel",
		) as HTMLTextAreaElement;
		await user.type(textarea, "Users need SSO support.");

		const submit = screen.getByRole("button", { name: /^create$/i });
		expect(submit).not.toBeDisabled();
		await user.click(submit);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		const arg = onSubmit.mock.calls[0][0] as Record<string, unknown>;
		expect(arg).not.toHaveProperty("title");
		expect(arg.description).toBe("Users need SSO support.");
		expect(arg.projectId).toBe("project-1");
		expect(arg.statusId).toBe("status-1");
	});

	it("fires `toast.loading` with titleGenerating on submit and upgrades to `toast.success` on resolve", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn().mockResolvedValue({ titleSource: "AI" });
		render(
			<CreateStoryDialog
				{...(makeProps({ onSubmit }) as React.ComponentProps<
					typeof CreateStoryDialog
				>)}
			/>,
		);

		const textarea = screen.getByLabelText(
			"descriptionLabel",
		) as HTMLTextAreaElement;
		await user.type(textarea, "Users need SSO support.");
		await user.click(screen.getByRole("button", { name: /^create$/i }));

		// Loading fires first.
		expect(toastLoading).toHaveBeenCalledTimes(1);
		expect(toastLoading).toHaveBeenCalledWith("titleGenerating");

		// Success upgrades in place via the sonner `{ id }` idiom — the
		// id returned by `toast.loading` is reused so sonner replaces the
		// loading row instead of stacking a second toast.
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith("titleGenerated", {
			id: "toast-id-1",
		});

		// No soft-warn on `AI` title source.
		expect(toastWarning).not.toHaveBeenCalled();
		// No error on success.
		expect(toastError).not.toHaveBeenCalled();
	});

	it("fires `toast.warning` with titleInsufficient when titleSource is the SCREAMING_SNAKE Prisma enum UNTITLED_FALLBACK", async () => {
		const user = userEvent.setup();
		const onSubmit = vi
			.fn()
			.mockResolvedValue({ titleSource: "UNTITLED_FALLBACK" });
		render(
			<CreateStoryDialog
				{...(makeProps({ onSubmit }) as React.ComponentProps<
					typeof CreateStoryDialog
				>)}
			/>,
		);

		const textarea = screen.getByLabelText(
			"descriptionLabel",
		) as HTMLTextAreaElement;
		await user.type(textarea, "Short.");
		await user.click(screen.getByRole("button", { name: /^create$/i }));

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastWarning).toHaveBeenCalledTimes(1);
		expect(toastWarning).toHaveBeenCalledWith("titleInsufficient");
	});

	it("fires `toast.warning` when titleSource is the kebab-case helper output untitled-fallback", async () => {
		const user = userEvent.setup();
		const onSubmit = vi
			.fn()
			.mockResolvedValue({ titleSource: "untitled-fallback" });
		render(
			<CreateStoryDialog
				{...(makeProps({ onSubmit }) as React.ComponentProps<
					typeof CreateStoryDialog
				>)}
			/>,
		);

		await user.type(
			screen.getByLabelText("descriptionLabel") as HTMLTextAreaElement,
			"Short.",
		);
		await user.click(screen.getByRole("button", { name: /^create$/i }));

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastWarning).toHaveBeenCalledWith("titleInsufficient");
	});

	it("upgrades the loading toast to `toast.error` on mutation rejection", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn().mockRejectedValue(new Error("boom"));
		render(
			<CreateStoryDialog
				{...(makeProps({ onSubmit }) as React.ComponentProps<
					typeof CreateStoryDialog
				>)}
			/>,
		);

		await user.type(
			screen.getByLabelText("descriptionLabel") as HTMLTextAreaElement,
			"Users need SSO support.",
		);
		await user.click(screen.getByRole("button", { name: /^create$/i }));

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastError).toHaveBeenCalledWith("titleGenerationFailed", {
			id: "toast-id-1",
		});
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(toastWarning).not.toHaveBeenCalled();
	});

	it("renders the Loader2 spinner inside the submit button while submitting", () => {
		render(
			<CreateStoryDialog
				{...(makeProps({
					isSubmitting: true,
				}) as React.ComponentProps<typeof CreateStoryDialog>)}
			/>,
		);

		// The button label morphs to "Creating…" + a Loader2 spinner. We assert
		// the label text (`Creating…`) and the presence of the `animate-spin`
		// class on the icon, mirroring how the Roadmap variant signals progress.
		const submit = screen.getByRole("button", { name: /creating/i });
		expect(submit).toBeDisabled();
		expect(submit.querySelector(".animate-spin")).not.toBeNull();
	});

	it("passes picked files as the second arg to onSubmit", async () => {
		const onSubmit = vi.fn().mockResolvedValue({ titleSource: "ai" });
		render(
			<CreateStoryDialog
				{...(makeProps({ onSubmit }) as React.ComponentProps<
					typeof CreateStoryDialog
				>)}
			/>,
		);

		await userEvent.type(
			screen.getByLabelText("descriptionLabel"),
			"a thing is broken",
		);
		const file = new File([new Uint8Array(1024)], "shot.png", {
			type: "image/png",
		});
		const input = screen.getByTestId(
			"attachments-field-input",
		) as HTMLInputElement;
		await userEvent.upload(input, file);
		await userEvent.click(screen.getByRole("button", { name: /create/i }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		const [payload, files] = onSubmit.mock.calls[0];
		expect(payload.description).toBe("a thing is broken");
		expect(files).toHaveLength(1);
		expect(files[0].name).toBe("shot.png");
	});

	it("passes doc attachments (file + default designation) as the third arg to onSubmit", async () => {
		const onSubmit = vi.fn().mockResolvedValue({ titleSource: "ai" });
		render(
			<CreateStoryDialog
				{...(makeProps({ onSubmit }) as React.ComponentProps<
					typeof CreateStoryDialog
				>)}
			/>,
		);

		await userEvent.type(
			screen.getByLabelText("descriptionLabel"),
			"needs a spec",
		);
		const doc = new File([new Uint8Array(64)], "spec.docx", {
			type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		});
		const input = screen.getByTestId(
			"doc-attachments-field-input",
		) as HTMLInputElement;
		await userEvent.upload(input, doc, { applyAccept: false });
		await userEvent.click(screen.getByRole("button", { name: /create/i }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		const docAttachments = onSubmit.mock.calls[0][2];
		expect(docAttachments).toHaveLength(1);
		expect(docAttachments[0].file.name).toBe("spec.docx");
		expect(docAttachments[0].designation).toBe("UNLOCKED");
	});

	// ---- Source-scan regression guards ----
	//
	// PR 1 originally shipped a regex-based scan that was NOT brace-aware
	// (`useMutation\(\{[\s\S]*?\}\)` lazily stops at the first `})` it finds,
	// which can be a nested object literal inside the mutation body — not the
	// `})` that closes useMutation). It also only covered the since-deleted
	// StoriesKanban board, which is exactly how the parallel Roadmap race
	// slipped past CI and was caught by Codex during review.
	//
	// Fix: a paren-depth parser that walks `(` / `)` and stops at depth 0.
	// Strings and comments inside JS code can contain unbalanced parens, but
	// the actual TypeScript syntax around these useMutation calls never does
	// (verified by manual inspection), so a depth-only walker is safe enough
	// for a regression guard. If a future edit introduces an unbalanced-paren
	// string literal inside one of these blocks, the test will start passing
	// when it shouldn't — at that point we'd promote this to a real AST scan
	// via the `typescript` module.
	function extractCreateStoryMutationBody(src: string): string {
		const start = src.indexOf("createStoryMutation = useMutation(");
		if (start < 0) {
			return "";
		}
		let i = src.indexOf("(", start);
		if (i < 0) {
			return "";
		}
		let depth = 0;
		for (; i < src.length; i++) {
			const ch = src[i];
			if (ch === "(") {
				depth++;
			} else if (ch === ")") {
				depth--;
				if (depth === 0) {
					return src.slice(start, i + 1);
				}
			}
		}
		return "";
	}

	// Strip JS line and block comments before pattern matching so a comment
	// describing why a forbidden call was removed (e.g. "...where the
	// setCreateDialogOpen(false) call was removed...") doesn't trigger a
	// false positive. Comments inside the extracted block can legitimately
	// reference the pattern we're scanning for.
	function stripComments(src: string): string {
		return src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
	}

	it.each([
		[
			"StoriesRoadmap",
			"modules/saas/projects/components/stories/StoriesRoadmap.tsx",
		],
	])(
		"%s.createStoryMutation.onSuccess contains neither setCreateDialogOpen(false) NOR router.push(",
		async (_label, path) => {
			const fs = await import("node:fs");
			const src = fs.readFileSync(path, "utf8");
			const block = extractCreateStoryMutationBody(src);
			expect(block).not.toBe("");
			const codeOnly = stripComments(block);
			// Closing the dialog inside onSuccess races the deferred-upload
			// pipeline (uploads fire AFTER create returns; closing here unmounts
			// the dialog before they finish).
			expect(codeOnly).not.toMatch(
				/setCreateDialogOpen\s*\(\s*false\s*\)/,
			);
			// Navigating inside onSuccess races the same pipeline AND
			// updateStory — the user lands on the story page before the
			// description has been patched with the ## Attachments block
			// (Codex review of PR 1 caught this for Roadmap).
			expect(codeOnly).not.toMatch(/router\.push\s*\(/);
		},
	);
});
