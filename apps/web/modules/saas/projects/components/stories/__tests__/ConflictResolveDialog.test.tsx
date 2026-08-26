import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const checkPmSyncConflicts = vi.fn();
const resolveConflict = vi.fn();
const proposeAiMerge = vi.fn();
const resolveContentDrift = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				checkPmSyncConflicts: (...args: unknown[]) =>
					checkPmSyncConflicts(...args),
				resolveConflict: (...args: unknown[]) =>
					resolveConflict(...args),
				proposeAiMerge: (...args: unknown[]) => proposeAiMerge(...args),
			},
			pmStateChanges: {
				resolveContentDrift: (...args: unknown[]) =>
					resolveContentDrift(...args),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// Radix/JSDOM shims.
if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

import {
	ConflictResolveDialog,
	type ConflictResolveDialogProps,
} from "../ConflictResolveDialog";

const basePreview: NonNullable<ConflictResolveDialogProps["preview"]> = {
	pmCurrent: {
		title: "Checkout refactor",
		description: "PM-side description with extra remote detail.",
		lastChangedBy: "Jamie Rivera",
		lastChangedAt: "2026-05-20T10:30:00Z",
	},
	pmUrl: "https://example.test/ticket/1",
	pmTool: "azure-devops",
};

function baseProps(
	overrides: Partial<ConflictResolveDialogProps> = {},
): ConflictResolveDialogProps {
	return {
		open: true,
		onOpenChange: vi.fn(),
		projectId: "proj_1",
		organizationId: null,
		itemType: "feature",
		entityId: "feature_1",
		fabricTitle: "Checkout refactor",
		fabricDescription: "Fabric-side description with extra local detail.",
		fabricUpdatedAt: "2026-05-21T08:00:00Z",
		identifier: "F-039",
		preview: basePreview,
		onResolved: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveConflict.mockResolvedValue({ cleared: true });
	resolveContentDrift.mockResolvedValue({ change: {} });
	proposeAiMerge.mockResolvedValue({
		mergedTitle: "Merged title combining both sides",
		mergedDescription: "Merged description combining both sides.",
		truncated: false,
	});
	checkPmSyncConflicts.mockResolvedValue({
		results: [
			{
				id: "feature_1",
				itemType: "feature",
				hasConflict: true,
				pmCurrent: basePreview.pmCurrent,
				pmUrl: basePreview.pmUrl,
				pmTool: basePreview.pmTool,
			},
		],
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("ConflictResolveDialog", () => {
	it("renders both diff columns, the identifier/title header, and the action buttons", () => {
		render(<ConflictResolveDialog {...baseProps()} />);

		expect(screen.getByText("FABRIC")).toBeInTheDocument();
		expect(screen.getByText("PM TOOL")).toBeInTheDocument();
		expect(screen.getByText("F-039")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Use Fabric" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Use PM" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /AI merge/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Cancel" }),
		).toBeInTheDocument();
	});

	it("normalizes PM-side HTML to markdown in the diff (no raw tags vs Fabric markdown)", () => {
		render(
			<ConflictResolveDialog
				{...baseProps({
					fabricDescription: "# Setup\n\n**bold** text",
					preview: {
						...basePreview,
						pmCurrent: {
							...basePreview.pmCurrent,
							description:
								"<h1>Setup</h1>\n<p><strong>bold</strong> text and extra</p>",
						},
					},
				})}
			/>,
		);

		const pmColumn = screen.getByRole("region", { name: "PM TOOL" });
		// HTML was converted to markdown for a like-for-like diff — the raw tags
		// are gone and the PM side reads as markdown, matching Fabric's format.
		expect(pmColumn.textContent).not.toMatch(/<h1>|<strong>|<\/p>/);
		expect(pmColumn.textContent).toContain("# Setup");
		expect(pmColumn.textContent).toContain("**bold**");
	});

	it("shows PM author+timestamp under the PM column and a Fabric timestamp under the FABRIC column", () => {
		render(<ConflictResolveDialog {...baseProps()} />);

		// PM TOOL column: "Updated {when} by {author}" (same order as the Fabric
		// column) on the reference line, and the PM tool name on its own source
		// row (so it aligns with the Fabric side's source row).
		const pmColumn = screen.getByRole("region", { name: "PM TOOL" });
		expect(pmColumn.textContent).toMatch(/Updated .* by Jamie Rivera/);
		expect(pmColumn.textContent).toMatch(/Azure DevOps/);

		// FABRIC column: timestamp only (no author — Fabric has no updatedBy).
		const fabricColumn = screen.getByRole("region", { name: "FABRIC" });
		expect(fabricColumn.textContent).toMatch(/Updated/);
		expect(fabricColumn.textContent).not.toMatch(/Last changed by/);
	});

	it("renders the same number of metadata header rows on both columns so the diff below lines up", () => {
		render(<ConflictResolveDialog {...baseProps()} />);

		// Header rows are the muted <p> lines above the Title/Description (which
		// are text-foreground). Both columns must expose the same three —
		// reference line, source, word count — or the title/description below
		// start at different offsets and the diff no longer aligns.
		const headerRows = (region: HTMLElement) =>
			region.querySelectorAll("p.text-muted-foreground");
		const fabricRows = headerRows(
			screen.getByRole("region", { name: "FABRIC" }),
		);
		const pmRows = headerRows(
			screen.getByRole("region", { name: "PM TOOL" }),
		);
		expect(pmRows.length).toBe(3);
		expect(pmRows.length).toBe(fabricRows.length);
		// Each row must be single-line (truncate) so a long value can't wrap and
		// re-break the alignment despite matching row counts.
		for (const row of [...fabricRows, ...pmRows]) {
			expect(row.className).toContain("truncate");
		}
	});

	it("shows a fallback Fabric timestamp line when fabricUpdatedAt is absent", () => {
		render(
			<ConflictResolveDialog {...baseProps({ fabricUpdatedAt: null })} />,
		);
		const fabricColumn = screen.getByRole("region", { name: "FABRIC" });
		expect(fabricColumn.textContent).toMatch(/Updated date unavailable/);
	});

	it("shows explicit fallbacks under the PM column when author and date are both null", () => {
		render(
			<ConflictResolveDialog
				{...baseProps({
					preview: {
						...basePreview,
						pmCurrent: {
							...basePreview.pmCurrent,
							lastChangedBy: null,
							lastChangedAt: null,
						},
					},
				})}
			/>,
		);

		const pmColumn = screen.getByRole("region", { name: "PM TOOL" });
		expect(pmColumn.textContent).toMatch(/Updated date unavailable/);
		expect(pmColumn.textContent).toMatch(/Author unavailable/);
		// The "happy path" phrasing must not appear when both fields are missing.
		expect(pmColumn.textContent).not.toMatch(/Last changed by/);
	});

	it("disables AI merge for a title-only conflict (identical descriptions)", () => {
		const identicalDesc = "Same description on both sides.";
		render(
			<ConflictResolveDialog
				{...baseProps({
					fabricDescription: identicalDesc,
					preview: {
						...basePreview,
						pmCurrent: {
							...basePreview.pmCurrent,
							description: identicalDesc,
						},
					},
				})}
			/>,
		);

		expect(screen.getByRole("button", { name: /AI merge/ })).toBeDisabled();
	});

	it("Use PM calls resolveConflict with REMOTE + itemType and no overrideDescription", async () => {
		const onResolved = vi.fn();
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(
			<ConflictResolveDialog
				{...baseProps({ onResolved, onOpenChange })}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Use PM" }));

		await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
		// resolveConflict resolves the tenant scope server-side, so its input
		// takes no organizationId.
		expect(resolveConflict).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj_1",
				itemId: "feature_1",
				itemType: "feature",
				resolution: "REMOTE",
			}),
		);
		expect(resolveConflict.mock.calls[0][0]).not.toHaveProperty(
			"organizationId",
		);
		expect(resolveConflict.mock.calls[0][0]).not.toHaveProperty(
			"overrideDescription",
		);
		expect(onResolved).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("Use Fabric calls resolveConflict with LOCAL + itemType and no overrideDescription", async () => {
		const user = userEvent.setup();
		render(<ConflictResolveDialog {...baseProps()} />);

		await user.click(screen.getByRole("button", { name: "Use Fabric" }));

		await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
		expect(resolveConflict).toHaveBeenCalledWith(
			expect.objectContaining({
				resolution: "LOCAL",
				itemType: "feature",
				itemId: "feature_1",
			}),
		);
		expect(resolveConflict.mock.calls[0][0]).not.toHaveProperty(
			"overrideDescription",
		);
	});

	it("does NOT fire onResolved or close when the resolution couldn't sync (cleared: false)", async () => {
		// The PM push couldn't be enqueued — the dialog surfaces the typed
		// pmError instead of a false success; the conflict flag (and the pill)
		// intentionally stay, so the caller-owned invalidation must not run.
		resolveConflict.mockResolvedValueOnce({
			cleared: false,
			pmError: { kind: "EXPIRED" },
		});
		const onResolved = vi.fn();
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(
			<ConflictResolveDialog
				{...baseProps({ onResolved, onOpenChange })}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Use Fabric" }));

		await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
		// The typed error replaces the diff with the PM-unavailable panel.
		expect(
			await screen.findByText("Reconnect Azure DevOps"),
		).toBeInTheDocument();
		expect(onResolved).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("AI merge populates the editable middle column, and Accept calls resolveConflict with overrideTitle + overrideDescription", async () => {
		const user = userEvent.setup();
		render(<ConflictResolveDialog {...baseProps()} />);

		await user.click(screen.getByRole("button", { name: /AI merge/ }));

		await waitFor(() =>
			expect(proposeAiMerge).toHaveBeenCalledWith(
				expect.objectContaining({
					itemId: "feature_1",
					itemType: "feature",
					fabricTitle: "Checkout refactor",
					fabricDescription:
						"Fabric-side description with extra local detail.",
					pmDescription:
						"PM-side description with extra remote detail.",
				}),
			),
		);

		// The merged title lands in its own editable field.
		const titleInput = await screen.findByRole("textbox", {
			name: /AI-refined merged title/,
		});
		expect(titleInput).toHaveValue("Merged title combining both sides");

		const textarea = await screen.findByRole("textbox", {
			name: /AI-refined merged description/,
		});
		expect(textarea).toHaveValue(
			"Merged description combining both sides.",
		);

		// Edit the merged text, then Accept.
		await user.clear(textarea);
		await user.type(textarea, "User-edited merged text");

		await user.click(screen.getByRole("button", { name: /Accept merge/ }));

		await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
		expect(resolveConflict).toHaveBeenCalledWith(
			expect.objectContaining({
				resolution: "LOCAL",
				itemType: "feature",
				overrideTitle: "Merged title combining both sides",
				overrideDescription: "User-edited merged text",
			}),
		);
	});

	it("blocks Accept and warns when the AI merge is truncated, leaving Regenerate / Use Fabric / Use PM usable", async () => {
		proposeAiMerge.mockResolvedValueOnce({
			mergedTitle: "Partial title",
			mergedDescription: "Partial merge that ran out of room before the",
			truncated: true,
		});
		const user = userEvent.setup();
		render(<ConflictResolveDialog {...baseProps()} />);

		await user.click(screen.getByRole("button", { name: /AI merge/ }));

		// The cut-off warning is announced and Accept is disabled so the
		// incomplete text can't be written to Fabric / pushed to the PM tool.
		expect(await screen.findByRole("alert")).toHaveTextContent(/cut off/i);
		expect(
			screen.getByRole("button", { name: /Accept merge/ }),
		).toBeDisabled();

		// The escape hatches stay available.
		expect(
			screen.getByRole("button", { name: "Regenerate" }),
		).toBeEnabled();
		expect(
			screen.getByRole("button", { name: "Use Fabric" }),
		).toBeEnabled();
		expect(screen.getByRole("button", { name: "Use PM" })).toBeEnabled();
	});

	it("shows an inline Try again on AI-merge failure while Use Fabric / Use PM remain usable", async () => {
		proposeAiMerge.mockRejectedValueOnce(new Error("model down"));
		const user = userEvent.setup();
		render(<ConflictResolveDialog {...baseProps()} />);

		await user.click(screen.getByRole("button", { name: /AI merge/ }));

		const tryAgain = await screen.findByRole("button", {
			name: "Try again",
		});
		expect(tryAgain).toBeInTheDocument();
		// The truncation banner belongs to the ready state only — it must not
		// leak into the error state.
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		// No toast teardown — binary actions stay enabled.
		expect(
			screen.getByRole("button", { name: "Use Fabric" }),
		).toBeEnabled();
		expect(screen.getByRole("button", { name: "Use PM" })).toBeEnabled();

		// Try again re-runs the merge.
		proposeAiMerge.mockResolvedValueOnce({
			mergedTitle: "Recovered title",
			mergedDescription: "Recovered merge.",
		});
		await user.click(tryAgain);
		await waitFor(() => expect(proposeAiMerge).toHaveBeenCalledTimes(2));
		expect(
			await screen.findByRole("textbox", {
				name: /AI-refined merged description/,
			}),
		).toHaveValue("Recovered merge.");
	});

	it("confirms before Regenerate overwrites an edited middle column", async () => {
		const user = userEvent.setup();
		render(<ConflictResolveDialog {...baseProps()} />);

		await user.click(screen.getByRole("button", { name: /AI merge/ }));
		const textarea = await screen.findByRole("textbox", {
			name: /AI-refined merged description/,
		});

		// Edit the merge so the dirty flag trips.
		await user.type(textarea, " plus my edits");

		await user.click(screen.getByRole("button", { name: "Regenerate" }));

		// A confirmation gate appears instead of re-calling proposeAiMerge.
		const confirm = await screen.findByRole("alertdialog", {
			name: "Confirm regenerate",
		});
		expect(confirm).toBeInTheDocument();
		expect(proposeAiMerge).toHaveBeenCalledTimes(1);

		// Confirming triggers the regenerate.
		await user.click(
			within(confirm).getByRole("button", {
				name: "Regenerate anyway",
			}),
		);
		await waitFor(() => expect(proposeAiMerge).toHaveBeenCalledTimes(2));
	});

	it("fetches the single-item preview when none is supplied (Review Center path)", async () => {
		render(
			<ConflictResolveDialog {...baseProps({ preview: undefined })} />,
		);

		await waitFor(() =>
			expect(checkPmSyncConflicts).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj_1",
					items: [{ id: "feature_1", itemType: "feature" }],
				}),
			),
		);
		expect(await screen.findByText("PM TOOL")).toBeInTheDocument();
	});

	it("has no serious or critical axe violations", async () => {
		const { baseElement } = render(
			<ConflictResolveDialog {...baseProps()} />,
		);

		await waitFor(() =>
			expect(screen.getByRole("dialog")).toBeInTheDocument(),
		);

		const results = await axe(baseElement);
		expect(results).toHaveNoViolations();
	});
});

describe("ConflictResolveDialog — pull-drift mode (7.5)", () => {
	function pullDriftProps(
		overrides: Partial<ConflictResolveDialogProps> = {},
	): ConflictResolveDialogProps {
		return {
			open: true,
			onOpenChange: vi.fn(),
			projectId: "proj_1",
			organizationId: null,
			itemType: "story",
			entityId: "story_1",
			fabricTitle: "Checkout refactor",
			fabricDescription:
				"Fabric-side description with extra local detail.",
			identifier: "US-007",
			mode: "pull-drift",
			pendingChangeId: "pending_7",
			onResolved: vi.fn(),
			// No `preview` — pull-drift fetches the live PM content on open.
			...overrides,
		};
	}

	it("renders the pull-drift action set aligned with the conflict modal (Use PM / Use Fabric / AI merge) and not the old drift labels", async () => {
		render(<ConflictResolveDialog {...pullDriftProps()} />);

		expect(
			await screen.findByRole("button", { name: "Use PM" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Use Fabric" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /AI merge/ }),
		).toBeInTheDocument();

		expect(
			screen.queryByRole("button", { name: /Apply to Fabric/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Keep Fabric/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Dismiss/ }),
		).not.toBeInTheDocument();
	});

	it("Use PM calls resolveContentDrift with APPLY_ADO + the pending-change id, then closes + onResolved", async () => {
		const onResolved = vi.fn();
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(
			<ConflictResolveDialog
				{...pullDriftProps({ onResolved, onOpenChange })}
			/>,
		);

		await user.click(await screen.findByRole("button", { name: "Use PM" }));

		await waitFor(() =>
			expect(resolveContentDrift).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj_1",
					id: "pending_7",
					outcome: "APPLY_ADO",
				}),
			),
		);
		expect(resolveContentDrift.mock.calls[0][0]).not.toHaveProperty(
			"overrideDescription",
		);
		expect(onResolved).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("Use Fabric warns it will overwrite the PM tool (associated via aria-describedby), and confirming resolves with KEEP_FABRIC", async () => {
		const user = userEvent.setup();
		render(<ConflictResolveDialog {...pullDriftProps()} />);

		// Use Fabric does NOT resolve immediately — it gates behind a warning.
		await user.click(
			await screen.findByRole("button", { name: "Use Fabric" }),
		);
		expect(resolveContentDrift).not.toHaveBeenCalled();

		const warningDialog = await screen.findByRole("alertdialog", {
			name: "Confirm use Fabric",
		});
		// The warning must explicitly call out the PM-tool overwrite.
		expect(warningDialog).toHaveTextContent(/overwrite/i);
		expect(warningDialog).toHaveTextContent(/PM tool/i);

		// a11y: the warning copy is associated via aria-describedby.
		const describedBy = warningDialog.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		expect(
			document.getElementById(describedBy as string),
		).toHaveTextContent(/overwrite/i);

		await user.click(
			within(warningDialog).getByRole("button", {
				name: /Overwrite the PM tool/,
			}),
		);

		await waitFor(() =>
			expect(resolveContentDrift).toHaveBeenCalledWith(
				expect.objectContaining({ outcome: "KEEP_FABRIC" }),
			),
		);
	});

	it("AI merge populates the editable middle, and Accept resolves with AI_MERGE + the edited overrideDescription", async () => {
		const user = userEvent.setup();
		render(<ConflictResolveDialog {...pullDriftProps()} />);

		await user.click(
			await screen.findByRole("button", { name: /AI merge/ }),
		);

		const textarea = await screen.findByRole("textbox", {
			name: /AI-refined merged description/,
		});
		expect(textarea).toHaveValue(
			"Merged description combining both sides.",
		);

		await user.clear(textarea);
		await user.type(textarea, "Edited merged drift text");

		await user.click(screen.getByRole("button", { name: /Accept merge/ }));

		await waitFor(() =>
			expect(resolveContentDrift).toHaveBeenCalledWith(
				expect.objectContaining({
					outcome: "AI_MERGE",
					overrideTitle: "Merged title combining both sides",
					overrideDescription: "Edited merged drift text",
				}),
			),
		);
	});

	it("fetches the live PM content on open via checkPmSyncConflicts", async () => {
		render(<ConflictResolveDialog {...pullDriftProps()} />);

		await waitFor(() =>
			expect(checkPmSyncConflicts).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj_1",
					items: [{ id: "story_1", itemType: "story" }],
				}),
			),
		);
		expect(await screen.findByText("PM TOOL")).toBeInTheDocument();
	});

	it("has no serious or critical axe violations in pull-drift mode", async () => {
		const { baseElement } = render(
			<ConflictResolveDialog {...pullDriftProps()} />,
		);

		await waitFor(() =>
			expect(screen.getByRole("dialog")).toBeInTheDocument(),
		);
		await screen.findByRole("button", { name: "Use PM" });

		const results = await axe(baseElement);
		expect(results).toHaveNoViolations();
	});
});

describe("ConflictResolveDialog — Fabric author / source / word count", () => {
	it("human manual edit: shows 'by {name}' and the 'Manual edit' source label", () => {
		render(
			<ConflictResolveDialog
				{...baseProps({
					fabricAuthor: "Ada Lovelace",
					fabricSource: "MANUAL",
				})}
			/>,
		);
		const fabric = screen.getByRole("region", { name: "FABRIC" });
		expect(fabric.textContent).toMatch(/by Ada Lovelace/);
		expect(fabric.textContent).toMatch(/Manual edit/);
		expect(fabric.textContent).not.toMatch(/Author unavailable/);
		expect(fabric.textContent).not.toMatch(/Source unavailable/);
	});

	it("AI/system edit (no author): omits the author phrase but shows the source label", () => {
		render(
			<ConflictResolveDialog
				{...baseProps({
					fabricAuthor: null,
					fabricSource: "AI_BACKLOG_UPDATE",
				})}
			/>,
		);
		const fabric = screen.getByRole("region", { name: "FABRIC" });
		expect(fabric.textContent).toMatch(/AI backlog update/);
		expect(fabric.textContent).not.toMatch(/ by /);
		expect(fabric.textContent).not.toMatch(/Author unavailable/);
	});

	it("PM_PULL source interpolates the connected tool label", () => {
		render(
			<ConflictResolveDialog
				{...baseProps({ fabricAuthor: null, fabricSource: "PM_PULL" })}
			/>,
		);
		const fabric = screen.getByRole("region", { name: "FABRIC" });
		// pmTool "azure-devops" → "Pulled from Azure DevOps".
		expect(fabric.textContent).toMatch(/Pulled from /);
	});

	it("pre-feature row (both null): shows BOTH 'Author unavailable' and 'Source unavailable'", () => {
		render(
			<ConflictResolveDialog
				{...baseProps({ fabricAuthor: null, fabricSource: null })}
			/>,
		);
		const fabric = screen.getByRole("region", { name: "FABRIC" });
		expect(fabric.textContent).toMatch(/Author unavailable/);
		expect(fabric.textContent).toMatch(/Source unavailable/);
	});

	it("PM column shows a word count but NO source element", () => {
		render(<ConflictResolveDialog {...baseProps()} />);
		const pm = screen.getByRole("region", { name: "PM TOOL" });
		expect(pm.textContent).toMatch(/\d+ words/);
		expect(pm.textContent).not.toMatch(/Source unavailable/);
		expect(pm.textContent).not.toMatch(/Manual edit/);
	});

	it("each column shows a combined title+description word count", () => {
		render(<ConflictResolveDialog {...baseProps()} />);
		// "Checkout refactor" (2) + "Fabric-side description with extra local
		// detail." (6) = 8 words.
		expect(
			screen.getByRole("region", { name: "FABRIC" }).textContent,
		).toMatch(/8 words/);
		expect(
			screen.getByRole("region", { name: "PM TOOL" }).textContent,
		).toMatch(/\d+ words/);
	});

	it("renders '0 words' for an empty side", () => {
		render(
			<ConflictResolveDialog
				{...baseProps({ fabricTitle: "", fabricDescription: "" })}
			/>,
		);
		expect(
			screen.getByRole("region", { name: "FABRIC" }).textContent,
		).toMatch(/0 words/);
	});

	it("AI-refined column shows a LIVE word count that updates as the merge is edited", async () => {
		const user = userEvent.setup();
		render(<ConflictResolveDialog {...baseProps()} />);

		await user.click(screen.getByRole("button", { name: /AI merge/ }));
		const titleInput = await screen.findByRole("textbox", {
			name: /AI-refined merged title/,
		});

		const aiColumn = screen.getByRole("region", {
			name: "AI-refined title and description",
		});
		expect(aiColumn.textContent).toMatch(/\d+ words/);

		// Edit the title → the count recomputes live. New title "alpha beta
		// gamma" (3) + merged description "Merged description combining both
		// sides." (5) = 8 words.
		await user.clear(titleInput);
		await user.type(titleInput, "alpha beta gamma");
		expect(aiColumn.textContent).toMatch(/8 words/);
	});
});
