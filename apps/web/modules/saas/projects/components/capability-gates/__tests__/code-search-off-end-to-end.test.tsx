/**
 * A brand-new project with code search off reaches a mounted surface that says
 * so (Fizzy #1930, A1).
 *
 * The shape: a PRD exists, a repository is connected, and code search is off —
 * the schema default, so the state most projects are in the moment they
 * connect a repository. Before the fix the gate called this "Repository not
 * indexed yet — indexing runs on its own" and waited forever for an index
 * nothing would ever build.
 *
 * Joined end to end rather than fixture to fixture: the gate is resolved by the
 * REAL server rule from that project shape, served through the real provider,
 * and rendered by the real banner — the one the Documents dialog mounts for the
 * selected type. API Specification is the generator this shape reaches: a PRD
 * grounds architecture, technical specification and QA strategy on its own, so
 * only the API specification has nothing but the repository to draw on.
 */

import { CAPABILITY_RULES_BY_KEY } from "@repo/api/modules/capabilities/registry";
import { resolveGate } from "@repo/api/modules/capabilities/resolve";
import type { CapabilityEvidence } from "@repo/api/modules/capabilities/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CapabilityGateBanner } from "../CapabilityGateBanner";
import { CapabilityGatesProvider } from "../useCapabilityGates";

const { gatesMock } = vi.hoisted(() => ({ gatesMock: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		capabilities: {
			gates: gatesMock,
			suppressWarning: vi.fn(),
			restoreWarnings: vi.fn(),
		},
		projects: { repositoryIntegrations: { reindex: vi.fn() } },
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_example",
		basePath: "/app/example-org",
	}),
}));

const IDLE = { running: false, lastProgressAt: null, lastRunFailed: false };

/** PRD present, repository connected and live, code search off. */
const BRAND_NEW_PROJECT: CapabilityEvidence = {
	projectId: "proj_example",
	viewer: { canEditProjectSettings: true, canUpdateProject: true },
	codebase: {
		connected: true,
		indexingEnabled: false,
		indexingAvailable: true,
		usable: false,
		healthy: true,
		integrationStatus: "ACTIVE",
		indexing: IDLE,
		lastIndexCompletedAt: null,
		retryTargetId: "integration_example",
		graphReady: false,
	},
	context: {
		total: 0,
		technical: 0,
		product: 0,
		processing: IDLE,
		hasFailedSource: false,
		technicalInFlight: 0,
		productInFlight: 0,
	},
	documents: {
		usableTypes: new Set(["PRD"]),
		inFlightTypes: new Set(),
		generating: IDLE,
	},
	descriptionLength: 120,
	scan: { ...IDLE, requiresCodebase: false },
};

const API_SPEC = "documents.generate-api-spec";

describe("a brand-new project with code search off", () => {
	it("tells the Documents dialog's API Specification generator to turn code search on", async () => {
		const rule = CAPABILITY_RULES_BY_KEY.get(API_SPEC);
		if (!rule) {
			throw new Error(`${API_SPEC} is not registered`);
		}
		gatesMock.mockResolvedValue({
			enabled: true,
			gates: [resolveGate(rule, BRAND_NEW_PROJECT, new Date())],
		});

		render(
			<QueryClientProvider client={new QueryClient()}>
				<CapabilityGatesProvider projectId="proj_example">
					<CapabilityGateBanner capabilityKey={API_SPEC} />
				</CapabilityGatesProvider>
			</QueryClientProvider>,
		);

		expect(
			await screen.findByText("reason.codebase.code-search-off.title"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "remedy.enableCodeSearch" }),
		).toBeInTheDocument();
		// A soft block — pasted source text can lift it — and not the spinner
		// that never stopped.
		expect(screen.getByRole("status")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
