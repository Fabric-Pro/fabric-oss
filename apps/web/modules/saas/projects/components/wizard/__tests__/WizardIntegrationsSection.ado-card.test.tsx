/**
 * Component tests for the Azure DevOps card in `WizardIntegrationsSection`
 * (Task Group 3 of the Azure DevOps code-repository spec).
 *
 * Spec:
 * - fabric/specs/2026-05-27-azure-devops-code-repository/spec.md §3.7, §5.1, §9.2
 * - fabric/specs/2026-05-27-azure-devops-code-repository/tasks.md Task 3.4
 *
 * Scope (per tasks.md 3.4):
 *   (a) the ADO card renders ONLY when `onAzureDevOpsReposChange` is provided;
 *   (b) the "N repos added" summary reflects the selection count;
 *   (c) chip add (initial repos render as chips) + remove (X control fires
 *       `onAzureDevOpsReposChange` with the repo filtered out);
 *   (d) the remove control is an accessible icon button (`aria-label`).
 *
 * The create-flow connect + startCodeSetup wiring is covered by the TG6 E2E
 * matrix; this file focuses on the section's card/chip UI only and never opens
 * the picker dialog (so no ADO network calls fire).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills (Radix Dialog / Tooltip need these even when closed) ──
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
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────
// The section reads org context from the hook (not props).
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

// The mounted (but closed) picker imports the orpc client at module load; stub
// it so the import resolves. No call is made because the dialog stays closed.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			azureDevOps: { listRepos: vi.fn() },
			repositoryIntegrations: { connect: vi.fn() },
		},
	},
}));

// next-intl is globally mocked in vitest.setup.ts to echo keys.

import {
	type AzureDevOpsRepo,
	WizardIntegrationsSection,
} from "../WizardIntegrationsSection";

// ── Fixtures ─────────────────────────────────────────────────────────────
function makeRepo(
	name: string,
	projectName: string,
	overrides: Partial<AzureDevOpsRepo> = {},
): AzureDevOpsRepo {
	const url = `https://dev.azure.com/acme/${projectName}/_git/${name}`;
	return {
		name,
		projectName,
		fullName: url,
		htmlUrl: url,
		defaultBranch: "main",
		isPrivate: true,
		language: null,
		...overrides,
	};
}

describe("WizardIntegrationsSection — Azure DevOps card", () => {
	// ── (a) gated on the onAzureDevOpsReposChange prop ──────────────────
	it("does NOT render the Azure DevOps card when onAzureDevOpsReposChange is absent", () => {
		// Render with no provider handlers so no sibling picker mounts — the
		// gate under test is purely the ADO card's `onAzureDevOpsReposChange`.
		render(<WizardIntegrationsSection sessionId="wiz_1" />);

		expect(screen.queryByText("Azure DevOps")).not.toBeInTheDocument();
	});

	it("renders the Azure DevOps card with an Add button when onAzureDevOpsReposChange is provided", () => {
		render(
			<WizardIntegrationsSection
				sessionId="wiz_1"
				selectedAzureDevOpsRepos={[]}
				onAzureDevOpsReposChange={vi.fn()}
			/>,
		);

		expect(screen.getByText("Azure DevOps")).toBeInTheDocument();
		// Empty-state summary mirrors the GitHub/GitLab cards.
		expect(screen.getByText(/no repositories added/i)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /add/i }),
		).toBeInTheDocument();
	});

	// ── (b) "N repos added" summary reflects the count ──────────────────
	it("shows a pluralized 'N repos added' summary for the current selection", () => {
		const repos = [
			makeRepo("api", "Platform"),
			makeRepo("web", "Platform"),
		];
		render(
			<WizardIntegrationsSection
				sessionId="wiz_1"
				selectedAzureDevOpsRepos={repos}
				onAzureDevOpsReposChange={vi.fn()}
			/>,
		);

		expect(screen.getByText("2 repos added")).toBeInTheDocument();
	});

	it("uses the singular 'repo added' for exactly one selection", () => {
		render(
			<WizardIntegrationsSection
				sessionId="wiz_1"
				selectedAzureDevOpsRepos={[makeRepo("api", "Platform")]}
				onAzureDevOpsReposChange={vi.fn()}
			/>,
		);

		expect(screen.getByText("1 repo added")).toBeInTheDocument();
	});

	// ── (c) chips render (add) with a readable project/repo label ───────
	it("renders one chip per selected repo using a readable {project}/{repo} label", () => {
		const repos = [makeRepo("api", "Platform"), makeRepo("ios", "Mobile")];
		render(
			<WizardIntegrationsSection
				sessionId="wiz_1"
				selectedAzureDevOpsRepos={repos}
				onAzureDevOpsReposChange={vi.fn()}
			/>,
		);

		expect(screen.getByText("Platform/api")).toBeInTheDocument();
		expect(screen.getByText("Mobile/ios")).toBeInTheDocument();
	});

	// ── (c) chip remove fires the change handler with the repo filtered ─
	it("removes a chip via its X control and emits the filtered selection", async () => {
		const repos = [
			makeRepo("api", "Platform"),
			makeRepo("web", "Platform"),
		];
		const onAzureDevOpsReposChange = vi.fn();
		const user = userEvent.setup();

		render(
			<WizardIntegrationsSection
				sessionId="wiz_1"
				selectedAzureDevOpsRepos={repos}
				onAzureDevOpsReposChange={onAzureDevOpsReposChange}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "Remove Platform/api" }),
		);

		expect(onAzureDevOpsReposChange).toHaveBeenCalledTimes(1);
		const [nextRepos] = onAzureDevOpsReposChange.mock.calls[0];
		expect(nextRepos.map((r: AzureDevOpsRepo) => r.name)).toEqual(["web"]);
	});

	// ── (d) the remove control is an accessible icon button ─────────────
	it("exposes an aria-label on each chip's remove control", () => {
		render(
			<WizardIntegrationsSection
				sessionId="wiz_1"
				selectedAzureDevOpsRepos={[makeRepo("api", "Platform")]}
				onAzureDevOpsReposChange={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Remove Platform/api" }),
		).toBeInTheDocument();
	});
});
