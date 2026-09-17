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

const updateCalls: Array<Record<string, unknown>> = [];

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getSettings: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["getSettings", o.input],
						queryFn: async () => settingsResponse.current,
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

function renderDialog() {
	return render(
		<InstructionsSettingsDialog
			projectId="p"
			open
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
	});

	it("shows the defaults as placeholder text and saves no override when untouched", async () => {
		renderDialog();
		const textarea = (await screen.findByLabelText(
			"textareaLabel",
		)) as HTMLTextAreaElement;
		await waitFor(() =>
			expect(textarea.placeholder).toBe("**/node_modules/**\nretro.md"),
		);
		// The project has no override, so nothing is seeded — the defaults
		// are readable but not editable content.
		expect(textarea.value).toBe("");

		await userEvent.click(screen.getByRole("button", { name: "save" }));
		await waitFor(() => expect(updateCalls).toHaveLength(1));
		// `null`, not `[]`: "no override", the same thing Reset writes.
		expect(updateCalls[0]).toEqual({ projectId: "p", ignoreGlobs: null });
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
});
