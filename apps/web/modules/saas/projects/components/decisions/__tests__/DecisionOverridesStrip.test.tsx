/**
 * DecisionOverridesStrip — the read-only, collapsible Overrides list inside the
 * Decisions tab. Backed by `architectureDecisions.overrides.list`; renders one
 * row per accepted override (when / who / decision / surface / conflict), and
 * renders NOTHING (returns null) once the query resolves with no overrides so
 * the tab isn't cluttered by a permanent empty strip. The toggle exposes
 * `aria-expanded`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const state = vi.hoisted(() => ({
	response: { overrides: [] as Array<Record<string, unknown>> },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			architectureDecisions: {
				overrides: {
					list: {
						queryOptions: (opts: { input: unknown }) => ({
							queryKey: ["decision-overrides", opts.input],
							queryFn: async () => state.response,
						}),
					},
				},
			},
		},
	},
}));

import { DecisionOverridesStrip } from "../DecisionOverridesStrip";

const overrideRow = {
	id: "row-1",
	createdAt: "2026-07-10T12:00:00.000Z",
	actorName: "Ada Reviewer",
	actorEmail: "ada@example.com",
	decisionId: "dec-1",
	decisionIdentifier: "ADR-012",
	decisionTitle: "Use Postgres for all persistence",
	surface: "backlog_proposal",
	artifactType: "pending_backlog_proposal",
	natureOfConflict: "The proposal introduces a MongoDB store.",
	conflictType: "violates_accepted",
};

function renderStrip() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<DecisionOverridesStrip projectId="proj-1" organizationId={null} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	state.response = { overrides: [] };
});

describe("DecisionOverridesStrip", () => {
	it("renders nothing once the query resolves with no overrides", async () => {
		state.response = { overrides: [] };
		renderStrip();

		// It may briefly show a loading header, then unmounts to null once the
		// empty result lands — mirroring the sibling MeetingCandidatesStrip.
		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "toggleAria" }),
			).not.toBeInTheDocument();
		});
	});

	it("renders collapsed once at least one override exists", async () => {
		state.response = { overrides: [overrideRow] };
		renderStrip();

		const toggle = await screen.findByRole("button", {
			name: "toggleAria",
		});
		expect(toggle).toHaveAttribute("aria-expanded", "false");
	});

	it("renders a row per override once expanded", async () => {
		state.response = { overrides: [overrideRow] };
		renderStrip();

		await userEvent.click(
			screen.getByRole("button", { name: "toggleAria" }),
		);

		expect(await screen.findByText("ADR-012")).toBeInTheDocument();
		expect(
			screen.getByText("Use Postgres for all persistence"),
		).toBeInTheDocument();
		expect(
			screen.getByText("The proposal introduces a MongoDB store."),
		).toBeInTheDocument();
		expect(screen.getByText("Ada Reviewer")).toBeInTheDocument();
		// Surface label comes from the (key-mocked) i18n namespace.
		expect(screen.getByText("surfaceBacklogProposal")).toBeInTheDocument();
	});

	it("has no axe violations while expanded with rows", async () => {
		state.response = { overrides: [overrideRow] };
		const { container } = renderStrip();

		await userEvent.click(
			screen.getByRole("button", { name: "toggleAria" }),
		);
		await screen.findByText("ADR-012");

		expect(await axe(container)).toHaveNoViolations();
	});
});
