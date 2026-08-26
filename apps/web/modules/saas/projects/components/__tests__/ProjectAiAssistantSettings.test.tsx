/**
 * Tests for ProjectAiAssistantSettings — the project-level clarifying-question
 * frequency control (spec AC6). Covers render, the current value, admin gating
 * (read-only for non-admins), and the Minimal advisory note.
 *
 * The Radix Select dropdown is not opened here (portal + pointer-capture is
 * unreliable in jsdom); the save path is covered by the update-project
 * procedure test and live verification.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: (p: string) => `/app/test-org${p}`,
}));

import { ProjectAiAssistantSettings } from "../ProjectAiAssistantSettings";

function renderWith(
	props: React.ComponentProps<typeof ProjectAiAssistantSettings>,
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<ProjectAiAssistantSettings {...props} />
		</QueryClientProvider>,
	);
}

const baseProject = {
	id: "proj-1",
	organizationId: null,
	clarifyingQuestionFrequency: "BALANCED" as const,
	qaStrategyLevel: "STANDARD" as const,
};

describe("ProjectAiAssistantSettings", () => {
	it("renders the control with the project's current frequency hint", () => {
		renderWith({ project: baseProject, canEdit: true });
		expect(screen.getByText("Clarifying questions")).toBeInTheDocument();
		expect(screen.getByText("Frequency")).toBeInTheDocument();
		// BALANCED hint.
		expect(screen.getByText(/material ambiguity/i)).toBeInTheDocument();
		const combos = screen.getAllByRole("combobox");
		combos.forEach((combo) => expect(combo).not.toBeDisabled());
	});

	it("is read-only for non-admins with an explanatory note (AC6)", () => {
		renderWith({ project: baseProject, canEdit: false });
		const combos = screen.getAllByRole("combobox");
		combos.forEach((combo) => expect(combo).toBeDisabled());
		expect(
			screen.getAllByText(/only project admins can change this setting/i),
		).toHaveLength(2);
	});

	it("shows a Minimal advisory note when set to MINIMAL", () => {
		renderWith({
			project: { ...baseProject, clarifyingQuestionFrequency: "MINIMAL" },
			canEdit: true,
		});
		expect(
			screen.getByText(/the assistant will rarely ask/i),
		).toBeInTheDocument();
	});

	it("defaults to BALANCED when the project has no value", () => {
		renderWith({
			project: { id: "proj-1", organizationId: null },
			canEdit: true,
		});
		expect(screen.getByText(/material ambiguity/i)).toBeInTheDocument();
	});

	it("shows the tier tooltip + a Prompt Library deep link for admins (FU4)", () => {
		renderWith({
			project: { id: "proj-1", organizationId: null },
			canEdit: true,
		});
		expect(
			screen.getByRole("button", {
				name: /how clarifying-question frequency works/i,
			}),
		).toBeInTheDocument();
		const link = screen.getByRole("link", {
			name: /customize these prompts in the prompt library/i,
		});
		expect(link.getAttribute("href")).toContain("/prompts?search=");
	});

	it("hides the Prompt Library link for non-admins (FU4)", () => {
		renderWith({ project: baseProject, canEdit: false });
		expect(
			screen.queryByRole("link", { name: /customize these prompts/i }),
		).not.toBeInTheDocument();
	});

	it("renders the Testing Strategy depth control with the project's current level hint", () => {
		renderWith({ project: baseProject, canEdit: true });
		expect(screen.getByText("Testing Strategy depth")).toBeInTheDocument();
		// STANDARD hint.
		expect(
			screen.getByText(/regression, security, and browser matrix/i),
		).toBeInTheDocument();
	});

	it("Testing Strategy depth control is disabled for non-admins", () => {
		renderWith({ project: baseProject, canEdit: false });
		// There are two comboboxes: frequency and qa strategy
		const combos = screen.getAllByRole("combobox");
		expect(combos).toHaveLength(2);
		combos.forEach((combo) => expect(combo).toBeDisabled());
	});

	it("defaults Testing Strategy to STANDARD when the project has no value", () => {
		renderWith({
			project: { id: "proj-1", organizationId: null },
			canEdit: true,
		});
		expect(
			screen.getByText(/regression, security, and browser matrix/i),
		).toBeInTheDocument();
	});

	it("shows the LIGHT hint when qaStrategyLevel is LIGHT", () => {
		renderWith({
			project: { ...baseProject, qaStrategyLevel: "LIGHT" as const },
			canEdit: true,
		});
		expect(
			screen.getByText(/functional and acceptance tests only/i),
		).toBeInTheDocument();
	});

	it("shows the STRICT hint when qaStrategyLevel is STRICT", () => {
		renderWith({
			project: { ...baseProject, qaStrategyLevel: "STRICT" as const },
			canEdit: true,
		});
		expect(
			screen.getByText(/performance benchmarks and WCAG 2\.1 AA/i),
		).toBeInTheDocument();
	});

	it("shows the Testing Strategy tooltip button for the depth control", () => {
		renderWith({ project: baseProject, canEdit: true });
		expect(
			screen.getByRole("button", {
				name: /how testing strategy depth works/i,
			}),
		).toBeInTheDocument();
	});

	// The test-case generation toggles moved to Settings ▸ Testing; their tests
	// moved with them, to
	// `qa-settings/__tests__/ProjectTestCaseGenerationSettings.test.tsx`.
	// Noted rather than silently deleted so a reader looking for that coverage
	// here knows it still exists.
	it("no longer renders the test-case toggles, and points at their new home", () => {
		renderWith({ project: baseProject, canEdit: true });
		expect(
			screen.queryByRole("switch", {
				name: /generate manual test cases/i,
			}),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/now live in settings ▸ testing/i),
		).toBeInTheDocument();
	});
});
