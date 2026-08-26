/**
 * Tests for the test-case generation policy on Settings ▸ Testing.
 *
 * These moved here with the toggles themselves — they used to live in
 * `ProjectAiAssistantSettings.test.tsx` and asserted the same behaviours on the
 * AI Assistant page. The controls changed address, not behaviour, so the
 * coverage was relocated rather than rewritten or dropped.
 *
 * The "Open bugs for failing tests" toggle is covered here for the first time:
 * it sat in the same section on the old page with no test of its own.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const updateMock = vi.fn(async () => ({ project: { id: "proj-1" } }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { update: (...a: unknown[]) => updateMock(...a) },
	},
}));

import { ProjectTestCaseGenerationSettings } from "../ProjectTestCaseGenerationSettings";

function renderWith(
	props: React.ComponentProps<typeof ProjectTestCaseGenerationSettings>,
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<ProjectTestCaseGenerationSettings {...props} />
		</QueryClientProvider>,
	);
}

const baseProject = { id: "proj-1", organizationId: null };

describe("ProjectTestCaseGenerationSettings", () => {
	it("renders the toggles with schema defaults (generation on, TDD off, auto-bug off)", () => {
		renderWith({ project: baseProject, canEdit: true });
		expect(
			screen.getByRole("switch", { name: /generate manual test cases/i }),
		).toBeChecked();
		expect(
			screen.getByRole("switch", { name: /apply tdd approach/i }),
		).not.toBeChecked();
		expect(
			screen.getByRole("switch", {
				name: /open bugs for failing tests/i,
			}),
		).not.toBeChecked();
	});

	it("reflects explicit values and disables TDD while generation is off", () => {
		renderWith({
			project: {
				...baseProject,
				generateManualTestCases: false,
				applyTddApproach: true,
			},
			canEdit: true,
		});
		const generate = screen.getByRole("switch", {
			name: /generate manual test cases/i,
		});
		const tdd = screen.getByRole("switch", { name: /apply tdd approach/i });
		expect(generate).not.toBeChecked();
		expect(tdd).toBeChecked();
		// TDD ordering does nothing while generation is off — disable it and say why.
		expect(tdd).toBeDisabled();
		expect(
			screen.getByText(/no effect until you turn generation on/i),
		).toBeInTheDocument();
	});

	it("disables every toggle for non-admins and says why", () => {
		renderWith({ project: baseProject, canEdit: false });
		expect(
			screen.getByRole("switch", { name: /generate manual test cases/i }),
		).toBeDisabled();
		expect(
			screen.getByRole("switch", { name: /apply tdd approach/i }),
		).toBeDisabled();
		expect(
			screen.getByRole("switch", {
				name: /open bugs for failing tests/i,
			}),
		).toBeDisabled();
		expect(
			screen.getByText(/only project admins can change these settings/i),
		).toBeInTheDocument();
	});

	it("persists a generation-toggle change through projects.update", async () => {
		renderWith({ project: baseProject, canEdit: true });
		fireEvent.click(
			screen.getByRole("switch", { name: /generate manual test cases/i }),
		);
		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ generateManualTestCases: false }),
			),
		);
	});

	it("persists the auto-bug toggle through projects.update", async () => {
		// The write this asserts is the one that turns a failing CI test into a
		// filed bug without anyone reading it, so "did the switch actually save"
		// is worth pinning rather than assuming.
		renderWith({ project: baseProject, canEdit: true });
		fireEvent.click(
			screen.getByRole("switch", {
				name: /open bugs for failing tests/i,
			}),
		);
		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ autoCreateBugsFromFailures: true }),
			),
		);
	});

	it("carries the project's organizationId on the write", async () => {
		// A settings write that loses the org id is the shape of a cross-tenant
		// bug, so it is asserted rather than left to the procedure's own tests.
		renderWith({
			project: { id: "proj-2", organizationId: "org-9" },
			canEdit: true,
		});
		fireEvent.click(
			screen.getByRole("switch", { name: /apply tdd approach/i }),
		);
		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "proj-2",
					organizationId: "org-9",
					applyTddApproach: true,
				}),
			),
		);
	});
});
