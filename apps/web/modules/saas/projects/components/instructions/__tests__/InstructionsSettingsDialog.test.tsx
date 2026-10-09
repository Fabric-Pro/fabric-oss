/**
 * M5: the dialog seeded its textarea with `ignoreGlobs ?? defaultIgnoreGlobs`
 * and saved whatever was in it, so opening Settings to READ the rules and
 * pressing Save silently moved the project from layer `default` to layer
 * `project` — pinning a copy of that day's defaults, after which changes to
 * `DEFAULT_IGNORE_GLOBS` never reached the project again.
 *
 * `next-intl` is left on the shared echoing mock (`vitest.setup.ts`): what is
 * under test is which value is written, not the copy.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const settingsResponse = vi.hoisted(() => ({
	current: {
		ignoreGlobs: null as string[] | null,
		defaultIgnoreGlobs: ["**/node_modules/**", "retro.md"],
		sourceOfTruth: null,
	},
}));

const settingsGate = vi.hoisted(() => ({
	hold: false,
	release: null as (() => void) | null,
}));

const updateCalls: Array<Record<string, unknown>> = [];

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getSettings: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["getSettings", o.input],
						queryFn: async () => {
							if (settingsGate.hold) {
								await new Promise<void>((resolve) => {
									settingsGate.release = resolve;
								});
							}
							return settingsResponse.current;
						},
					}),
				},
				updateSettings: {
					mutationOptions: (
						opts: {
							onSuccess?: (d: unknown, v: unknown) => void;
							onError?: (e: Error) => void;
						} = {},
					) => ({
						mutationFn: async (input: unknown) => {
							updateCalls.push(input as Record<string, unknown>);
							return { ok: true };
						},
						...opts,
					}),
				},
			},
		},
	},
}));

import { InstructionsSettingsDialog } from "../InstructionsSettingsDialog";

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderDialog({
	canEdit = true,
	repositoryMode = false,
}: {
	canEdit?: boolean;
	repositoryMode?: boolean;
} = {}) {
	return render(
		<InstructionsSettingsDialog
			projectId="p"
			open
			canEdit={canEdit}
			repositoryMode={repositoryMode}
			onOpenChange={() => undefined}
		/>,
		{ wrapper: TestQueryProvider },
	);
}

describe("InstructionsSettingsDialog", () => {
	beforeEach(() => {
		updateCalls.length = 0;
		vi.clearAllMocks();
		settingsResponse.current = {
			ignoreGlobs: null,
			defaultIgnoreGlobs: ["**/node_modules/**", "retro.md"],
			sourceOfTruth: null,
		};
		settingsGate.hold = false;
		settingsGate.release = null;
	});

	it("lists the defaults in effect as text, not placeholder, and saves no override when untouched", async () => {
		renderDialog();
		const textarea = (await screen.findByLabelText(
			"textareaLabel",
		)) as HTMLTextAreaElement;
		const defaults = await screen.findByTestId(
			"instructions-settings-defaults",
		);
		expect(defaults).toHaveTextContent("**/node_modules/**");
		expect(defaults).toHaveTextContent("retro.md");
		expect(textarea.placeholder).not.toContain("node_modules");
		// The project has no override, so nothing is seeded — the defaults
		// are readable but not editable content.
		expect(textarea.value).toBe("");

		await userEvent.click(screen.getByRole("button", { name: "save" }));
		await waitFor(() => expect(updateCalls).toHaveLength(1));
		// `null`, not `[]`: "no override", the same thing Reset writes.
		expect(updateCalls[0]).toEqual({ projectId: "p", ignoreGlobs: null });
	});

	it("describes the rules for repository mode and shows a visible label on the globs", async () => {
		renderDialog({ repositoryMode: true });
		const textarea = await screen.findByLabelText("textareaLabel");
		expect(screen.getByText("descriptionRepository")).toBeInTheDocument();
		expect(screen.queryByText("description")).not.toBeInTheDocument();
		const label = screen.getByText("textareaLabel");
		expect(label.tagName).toBe("LABEL");
		expect(label).toHaveAttribute("for", textarea.id);
	});

	it("seeds from the project's own override and saves the edited list", async () => {
		settingsResponse.current = {
			ignoreGlobs: ["dist/**"],
			defaultIgnoreGlobs: ["**/node_modules/**", "retro.md"],
			sourceOfTruth: null,
		};
		renderDialog();
		const textarea = (await screen.findByLabelText(
			"textareaLabel",
		)) as HTMLTextAreaElement;
		await waitFor(() => expect(textarea.value).toBe("dist/**"));

		await userEvent.type(textarea, "\nbuild/**");
		await userEvent.click(screen.getByRole("button", { name: "save" }));
		await waitFor(() => expect(updateCalls).toHaveLength(1));
		expect(updateCalls[0]).toEqual({
			projectId: "p",
			ignoreGlobs: ["dist/**", "build/**"],
		});
	});

	it("does not enable Save or Reset until the settings read has seeded the form", async () => {
		settingsGate.hold = true;
		renderDialog();

		const textarea = screen.getByLabelText("textareaLabel");
		expect(textarea).toHaveAttribute("readonly");
		expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "resetToDefaults" }),
		).toBeDisabled();

		await waitFor(() => expect(settingsGate.release).not.toBeNull());
		settingsGate.hold = false;
		settingsGate.release?.();

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "save" })).toBeEnabled(),
		);
	});

	it("keeps an in-progress draft when the settings query refetches", async () => {
		settingsResponse.current = {
			ignoreGlobs: ["dist/**"],
			defaultIgnoreGlobs: ["**/node_modules/**", "retro.md"],
			sourceOfTruth: null,
		};
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<InstructionsSettingsDialog
					projectId="p"
					open
					canEdit
					onOpenChange={() => undefined}
				/>
			</QueryClientProvider>,
		);
		const textarea = (await screen.findByLabelText(
			"textareaLabel",
		)) as HTMLTextAreaElement;
		await waitFor(() => expect(textarea.value).toBe("dist/**"));
		await userEvent.type(textarea, "\nlocal/**");

		settingsResponse.current = {
			ignoreGlobs: ["generated/**"],
			defaultIgnoreGlobs: ["**/node_modules/**", "retro.md"],
			sourceOfTruth: null,
		};
		await client.invalidateQueries({ queryKey: ["getSettings"] });

		await waitFor(() => expect(textarea.value).toBe("dist/**\nlocal/**"));
	});

	it("reset writes null explicitly", async () => {
		settingsResponse.current = {
			ignoreGlobs: ["dist/**"],
			defaultIgnoreGlobs: ["**/node_modules/**", "retro.md"],
			sourceOfTruth: null,
		};
		renderDialog();
		await screen.findByLabelText("textareaLabel");
		await userEvent.click(
			screen.getByRole("button", { name: "resetToDefaults" }),
		);
		await waitFor(() => expect(updateCalls).toHaveLength(1));
		expect(updateCalls[0]).toEqual({ projectId: "p", ignoreGlobs: null });
	});

	it("renders the repository section it is given", async () => {
		render(
			<InstructionsSettingsDialog
				projectId="p"
				open
				canEdit
				onOpenChange={() => undefined}
				repositorySection={<section data-testid="repository-section" />}
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(
			await screen.findByTestId("repository-section"),
		).toBeInTheDocument();
	});
});

/**
 * Someone who may not change the settings still sees them. The save used to be
 * offered to everyone and refused afterwards with a FORBIDDEN toast; now the
 * list reads as text, there is no Save or Reset, and one sentence says why.
 */
describe("InstructionsSettingsDialog — a reader", () => {
	beforeEach(() => {
		updateCalls.length = 0;
		settingsResponse.current = {
			ignoreGlobs: ["dist/**"],
			defaultIgnoreGlobs: ["**/node_modules/**"],
			sourceOfTruth: null,
		};
	});

	it("shows the rules the project has, read-only", async () => {
		renderDialog({ canEdit: false });

		const textarea = (await screen.findByLabelText(
			"textareaLabel",
		)) as HTMLTextAreaElement;
		await waitFor(() => expect(textarea.value).toBe("dist/**"));
		expect(textarea).toHaveAttribute("readonly");
	});

	it("offers neither Save nor Reset to defaults, and says why in one sentence", async () => {
		renderDialog({ canEdit: false });

		await screen.findByLabelText("textareaLabel");
		expect(screen.queryByRole("button", { name: "save" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "resetToDefaults" }),
		).toBeNull();
		expect(
			screen.getByTestId("instructions-settings-read-only"),
		).toHaveTextContent("readOnlyNotice");
		expect(
			en.projects.codingInstructions.settingsDialog.readOnlyNotice,
		).toBe(
			"You can see these settings, but only people who can change coding instructions can edit them.",
		);
	});

	it("can still be closed", async () => {
		const onOpenChange = vi.fn();
		render(
			<InstructionsSettingsDialog
				projectId="p"
				open
				canEdit={false}
				onOpenChange={onOpenChange}
			/>,
			{ wrapper: TestQueryProvider },
		);

		await userEvent.click(
			await screen.findByRole("button", { name: "close" }),
		);

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(updateCalls).toHaveLength(0);
	});

	it("an editor sees no read-only notice", async () => {
		renderDialog({ canEdit: true });

		await screen.findByLabelText("textareaLabel");
		expect(
			screen.queryByTestId("instructions-settings-read-only"),
		).toBeNull();
	});

	// A move of the uploaded instructions into a repository pauses the ignore
	// rules too (Fizzy #2878 §9): the server would refuse the save, so the
	// dialog says why and offers none.
	describe("while a move into a repository has paused changes", () => {
		const REASON =
			"Moving to example-org/instructions: pull request #12 is open. Changes are paused until it is merged and synced, or the move is canceled.";

		function renderPaused() {
			return render(
				<InstructionsSettingsDialog
					projectId="p"
					open
					canEdit
					pausedReason={REASON}
					onOpenChange={() => undefined}
				/>,
				{ wrapper: TestQueryProvider },
			);
		}

		it("says why the rules cannot be changed, in the sentence a refused save gives", async () => {
			renderPaused();

			const notice = await screen.findByTestId(
				"instructions-settings-read-only",
			);

			expect(notice).toHaveTextContent(REASON);
		});

		it("offers no Save or Reset, and the rules read as text", async () => {
			renderPaused();

			const textarea = (await screen.findByLabelText(
				"textareaLabel",
			)) as HTMLTextAreaElement;

			expect(textarea).toHaveAttribute("readonly");
			expect(screen.queryByRole("button", { name: "save" })).toBeNull();
			expect(
				screen.queryByRole("button", { name: "resetToDefaults" }),
			).toBeNull();
			expect(screen.getByRole("button", { name: "close" })).toBeVisible();
		});
	});

	it("names the dialog 'Coding instructions settings', not 'Coding-instructions settings'", () => {
		expect(en.projects.codingInstructions.settingsDialog.title).toBe(
			"Coding instructions settings",
		);
	});

	it("keeps the glob help out of the dialog's subtitle and lists no defaults once the project has its own rules", async () => {
		const copy = en.projects.codingInstructions.settingsDialog;
		expect(copy.description).not.toMatch(/glob/i);
		expect(copy.descriptionRepository).not.toMatch(/glob/i);
		expect(copy.textareaHint).toMatch(/one glob per line/i);

		settingsResponse.current = {
			ignoreGlobs: ["dist/**"],
			defaultIgnoreGlobs: ["**/node_modules/**", "retro.md"],
			sourceOfTruth: null,
		};
		renderDialog();
		const textarea = (await screen.findByLabelText(
			"textareaLabel",
		)) as HTMLTextAreaElement;
		await waitFor(() => expect(textarea.value).toBe("dist/**"));
		expect(
			screen.queryByTestId("instructions-settings-defaults"),
		).toBeNull();
	});
});
