/**
 * Tests for ProjectAiAssistantSettings — the project-level clarifying-question
 * frequency and Testing Strategy depth controls (spec AC6). Covers render, the
 * current value, admin gating (read-only for non-admins), the Minimal advisory
 * note, and that choosing an option writes through `projects.update`.
 *
 * Both controls are radio groups of option cards (they replaced two selects),
 * so every level's hint is on the page and the save path is driven here.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const updateMock = vi.fn(async (..._a: unknown[]) => ({
	project: { id: "proj-1" },
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { update: (...a: unknown[]) => updateMock(...a) },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryKey: (args: { input: unknown }) => [
					"projects.get",
					args.input,
				],
			},
		},
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

const frequencyGroup = () =>
	screen.getByRole("radiogroup", { name: "Clarifying questions" });
const depthGroup = () =>
	screen.getByRole("radiogroup", { name: "Testing Strategy depth" });

beforeEach(() => {
	updateMock.mockClear();
});

describe("ProjectAiAssistantSettings", () => {
	it("renders both radio groups with the project's current values checked", () => {
		renderWith({ project: baseProject, canEdit: true });
		const frequency = within(frequencyGroup()).getAllByRole("radio");
		expect(frequency).toHaveLength(3);
		expect(
			within(frequencyGroup()).getByRole("radio", { name: /Balanced/ }),
		).toHaveAttribute("aria-checked", "true");
		expect(
			within(depthGroup()).getByRole("radio", { name: /Standard/ }),
		).toHaveAttribute("aria-checked", "true");
		// Every level's hint is visible, not only the selected one's.
		expect(screen.getByText(/material ambiguity/i)).toBeInTheDocument();
		expect(screen.getByText(/genuinely blocked/i)).toBeInTheDocument();
		for (const radio of screen.getAllByRole("radio")) {
			expect(radio).not.toBeDisabled();
		}
	});

	it("writes the chosen frequency through projects.update", async () => {
		const user = userEvent.setup();
		renderWith({ project: baseProject, canEdit: true });

		const thorough = within(frequencyGroup()).getByRole("radio", {
			name: /Thorough/,
		});
		await user.click(thorough);

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "proj-1",
					clarifyingQuestionFrequency: "THOROUGH",
				}),
			),
		);
		expect(thorough).toHaveAttribute("aria-checked", "true");
	});

	it("writes the chosen Testing Strategy depth through projects.update", async () => {
		const user = userEvent.setup();
		renderWith({ project: baseProject, canEdit: true });

		await user.click(
			within(depthGroup()).getByRole("radio", {
				name: /Production\/Enterprise/,
			}),
		);

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "proj-1",
					qaStrategyLevel: "STRICT",
				}),
			),
		);
	});

	it("is read-only for non-admins with an explanatory note (AC6)", async () => {
		const user = userEvent.setup();
		renderWith({ project: baseProject, canEdit: false });
		const radios = screen.getAllByRole("radio");
		expect(radios).toHaveLength(6);
		for (const radio of radios) {
			expect(radio).toBeDisabled();
		}
		expect(
			screen.getByText(/only project admins can change these settings/i),
		).toBeInTheDocument();

		await user.click(
			within(frequencyGroup()).getByRole("radio", { name: /Thorough/ }),
		);
		expect(updateMock).not.toHaveBeenCalled();
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

	it("defaults to BALANCED and STANDARD when the project has no value", () => {
		renderWith({
			project: { id: "proj-1", organizationId: null },
			canEdit: true,
		});
		expect(
			within(frequencyGroup()).getByRole("radio", { name: /Balanced/ }),
		).toHaveAttribute("aria-checked", "true");
		expect(
			within(depthGroup()).getByRole("radio", { name: /Standard/ }),
		).toHaveAttribute("aria-checked", "true");
	});

	it("marks the default level of each control", () => {
		renderWith({ project: baseProject, canEdit: true });
		expect(
			within(frequencyGroup()).getByRole("radio", { name: /Balanced/ }),
		).toHaveTextContent("Default");
		expect(
			within(depthGroup()).getByRole("radio", { name: /Standard/ }),
		).toHaveTextContent("Default");
	});

	it("filters the page's prompt list to the clarifying prompts when it has one", async () => {
		const user = userEvent.setup();
		const onShowClarifyingPrompts = vi.fn();
		renderWith({
			project: baseProject,
			canEdit: true,
			onShowClarifyingPrompts,
		});
		await user.click(
			screen.getByRole("button", {
				name: /see the prompt behind each level/i,
			}),
		);
		expect(onShowClarifyingPrompts).toHaveBeenCalledTimes(1);
	});

	it("links to the Prompt Library instead where the page has no prompt list", () => {
		renderWith({ project: baseProject, canEdit: true });
		const link = screen.getByRole("link", {
			name: /see the prompt behind each level/i,
		});
		expect(link.getAttribute("href")).toBe(
			"/app/test-org/prompts?search=Clarifying%20Questions",
		);
	});

	// The test-case generation toggles moved to Settings ▸ Testing; their tests
	// moved with them, to
	// `qa-settings/__tests__/ProjectTestCaseGenerationSettings.test.tsx`.
	it("no longer renders the test-case toggles, and opens their new home", async () => {
		const user = userEvent.setup();
		const onOpenTestingSettings = vi.fn();
		renderWith({
			project: baseProject,
			canEdit: true,
			onOpenTestingSettings,
		});
		expect(
			screen.queryByRole("switch", {
				name: /generate manual test cases/i,
			}),
		).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: /settings ▸ testing/i }),
		);
		expect(onOpenTestingSettings).toHaveBeenCalledTimes(1);
	});

	it("names Settings ▸ Testing without a link while that tab is gated off", () => {
		renderWith({ project: baseProject, canEdit: true });
		expect(screen.getByText(/settings ▸ testing/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /settings ▸ testing/i }),
		).not.toBeInTheDocument();
	});
});
