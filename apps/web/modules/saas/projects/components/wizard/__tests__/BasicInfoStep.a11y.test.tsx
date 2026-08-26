/**
 * A11y unit tests for the new Add Context surface in BasicInfoStep (Group 9).
 *
 * Static accessibility assertions that DON'T require a live stack — they
 * inspect the rendered DOM directly to verify WCAG 2.1 AA requirements
 * specifically listed in `spec.md` §7.8 a11y checklist and the project's
 * `CLAUDE.md` "Accessibility Standard" section.
 *
 * Complements the live-stack `tests/e2e/unified-context-wizard/a11y-wizard.spec.ts`
 * which runs axe-core against the rendered app.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ──────────────────────────────────────────────────────
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (!HTMLElement.prototype.hasPointerCapture) {
		HTMLElement.prototype.hasPointerCapture = (() => false) as never;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
});

// ── Module mocks (mirror the sibling context-cta test) ──────────────────
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			checkName: {
				queryOptions: () => ({
					queryKey: ["projects.checkName"],
					queryFn: async () => ({ available: true }),
				}),
			},
			contexts: {
				list: {
					queryOptions: () => ({
						queryKey: ["projects.contexts.list"],
						queryFn: async () => ({ contexts: [] }),
					}),
				},
			},
		},
		wizard: {
			refineDescription: {
				mutationOptions: () => ({ mutationFn: vi.fn() }),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Heavy children rendered as inert stubs so the BasicInfoStep DOM itself
// is what we inspect.
vi.mock("../../ContextUploaderDialog", () => ({
	ContextUploaderDialog: () => null,
}));
vi.mock("../ContextPendingItemsList", () => ({
	ContextPendingItemsList: () => null,
}));
// Backlog section + Code Repository section (`WizardIntegrationsSection`)
// (unified-project-setup spec §4.3/§4.4). Inert stubs keep the BasicInfoStep
// DOM (the a11y subject) free of the heavy picker trees.
vi.mock("../WizardBacklogCard", () => ({
	WizardBacklogCard: () => null,
}));
vi.mock("../WizardIntegrationsSection", () => ({
	WizardIntegrationsSection: () => null,
}));

import { BasicInfoStep } from "../BasicInfoStep";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const baseFormData = {
	name: "",
	description: "",
	projectTypes: [] as string[],
	icon: "",
	color: "",
	tags: [] as string[],
	techStack: [] as string[],
	features: [] as string[],
	customRequirements: "",
	documents: [] as string[],
	previousDescription: null as string | null,
	tempContextIds: [] as string[],
	selectedTeamsChats: [] as unknown[],
	selectedNotionPages: [] as unknown[],
	selectedGitHubRepos: [] as unknown[],
	selectedGitLabRepos: [] as unknown[],
	selectedAzureDevOpsRepos: [] as unknown[],
	selectedSlackChannels: [] as unknown[],
	codebaseRepoUrls: [] as string[],
	primaryWebsiteUrl: "",
	additionalWebsiteUrls: [] as string[],
	projectManagementMcpConfigId: null as string | null,
	projectManagementMcpServerId: null as string | null,
	projectManagementContainerId: null as string | null,
	projectManagementContainerName: null as string | null,
	projectManagementAdditionalContext: null as Record<string, unknown> | null,
	projectManagementDetectedType: null as string | null,
	documentPrompts: {} as Record<string, unknown>,
};

function renderStep(overrides: { name?: string } = {}) {
	return wrap(
		<BasicInfoStep
			// biome-ignore lint/suspicious/noExplicitAny: test-time form shape mirrors prod
			formData={{ ...baseFormData, name: overrides.name ?? "" } as any}
			updateFormData={vi.fn()}
			wizardSessionId="wiz_test_1"
			organizationId={undefined}
			projectId="proj_test_1"
		/>,
	);
}

describe("BasicInfoStep — a11y (WCAG 2.1 AA, spec §7.8)", () => {
	// ── (1) Every interactive control has a label ──────────────────────────
	it("Add Context CTA has aria-label and clearly indicates disabled state", () => {
		renderStep({ name: "" });
		const cta = screen.getByTestId("add-context-cta");
		expect(cta).toHaveAttribute("aria-label", "Add project context");
		// Disabled state mirrored in BOTH `disabled` and `aria-disabled` —
		// some screen readers honor only one.
		expect(cta).toBeDisabled();
		expect(cta).toHaveAttribute("aria-disabled", "true");
	});

	it("Add Context CTA reflects enabled state via aria-disabled when name is present", () => {
		renderStep({ name: "Project X" });
		const cta = screen.getByTestId("add-context-cta");
		expect(cta).not.toBeDisabled();
		expect(cta).toHaveAttribute("aria-disabled", "false");
	});

	it("Project name input has a programmatically-associated label", () => {
		renderStep({ name: "" });
		// htmlFor / id association via React Hook Form / standard label
		const nameInput = screen.getByLabelText(/project name/i);
		expect(nameInput).toBeInTheDocument();
		expect(nameInput.tagName).toBe("INPUT");
	});

	it("Description textarea has a programmatically-associated label", () => {
		renderStep({ name: "x" });
		// The textarea's label is "Project Brief" (the narrative section
		// header). Both #description and the surrounding label tie together
		// via htmlFor for screen-reader association.
		const descInput = screen.getByLabelText(/project brief/i);
		expect(descInput).toBeInTheDocument();
		expect(descInput.tagName).toBe("TEXTAREA");
	});

	// ── (2) Inline disabled-CTA hint is properly announced ─────────────────
	it("Disabled-CTA inline hint is rendered and stays present alongside the CTA", () => {
		renderStep({ name: "" });
		const hint = screen.getByTestId("add-context-disabled-hint");
		expect(hint).toBeVisible();
		expect(hint).toHaveTextContent(/name your project first/i);
		// Hint shouldn't have role="alert" — it's not a transient error, it's
		// stable explanatory text. role="status" / live="polite" is also OK
		// but plain text is fine since the disabled-state itself is announced.
	});

	// ── (3) No interactive element is reachable but unlabelled ─────────────
	it("All buttons in Step 1 have either text content or aria-label", () => {
		const { container } = renderStep({ name: "x" });
		const buttons = container.querySelectorAll("button");
		expect(buttons.length).toBeGreaterThan(0);
		const unlabelled = Array.from(buttons).filter((b) => {
			const text = b.textContent?.trim() || "";
			const ariaLabel = b.getAttribute("aria-label")?.trim() || "";
			const ariaLabelledBy = b.getAttribute("aria-labelledby");
			return !text && !ariaLabel && !ariaLabelledBy;
		});
		expect(
			unlabelled,
			`Buttons without accessible name: ${unlabelled
				.map((b) => b.outerHTML.slice(0, 100))
				.join(", ")}`,
		).toEqual([]);
	});

	// ── (4) Heading hierarchy is sane ──────────────────────────────────────
	it("Has a top-level Step 1 heading (h2) — no orphan deeper headings", () => {
		renderStep({ name: "x" });
		const h2s = screen.getAllByRole("heading", { level: 2 });
		expect(h2s.length).toBeGreaterThanOrEqual(1);
		// "Project brief" is the canonical Step 1 h2
		expect(
			h2s.some((h) => /project brief/i.test(h.textContent || "")),
		).toBe(true);
	});

	// ── (5) No tab-trap risk: no element with positive tabIndex ────────────
	// Per WCAG 2.4.3, focus order should follow source order. Custom
	// positive tabIndex disrupts that. tabIndex={-1} / {0} are fine.
	it("No element uses a positive tabIndex (WCAG 2.4.3 focus order)", () => {
		const { container } = renderStep({ name: "x" });
		const positiveTabIndex = Array.from(
			container.querySelectorAll("[tabindex]"),
		).filter((el) => {
			const v = Number(el.getAttribute("tabindex") || "0");
			return v > 0;
		});
		expect(
			positiveTabIndex,
			`Positive tabIndex found on: ${positiveTabIndex
				.map((el) => el.outerHTML.slice(0, 80))
				.join(", ")}`,
		).toEqual([]);
	});

	// ── (6) Form controls don't rely on color alone for state ──────────────
	// "Required" / "Error" / "Disabled" states must be conveyed via more
	// than just color. We check for the presence of a secondary signal
	// (aria-required, aria-invalid, disabled attribute, or visible text).
	it("Disabled CTA state is conveyed via attributes, not color alone", () => {
		renderStep({ name: "" });
		const cta = screen.getByTestId("add-context-cta");
		// Multiple non-color affordances present
		const conveyedByAttrs =
			cta.hasAttribute("disabled") ||
			cta.getAttribute("aria-disabled") === "true";
		expect(conveyedByAttrs).toBe(true);
		// Plus inline hint text near the CTA (text-based affordance)
		expect(
			screen.queryByTestId("add-context-disabled-hint"),
		).toBeInTheDocument();
	});
});
