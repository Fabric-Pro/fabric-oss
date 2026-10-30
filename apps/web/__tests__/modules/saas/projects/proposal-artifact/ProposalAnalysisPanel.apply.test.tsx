/**
 * `ProposalAnalysisPanel` — Apply recommendation and the Resolved state
 * (Fizzy #2946).
 *
 * Pinned here:
 *  - Apply recommendation sits beside a finding's response controls exactly
 *    where the server says the finding can be applied (`canApply`), for a
 *    member it lets respond, and only when the page takes the request; it
 *    hands the page the finding's id, the shown run and the stable key;
 *  - while that finding's revision is under way it says so in words, its
 *    controls are busy and its other actions wait, and no other finding's
 *    Apply can start a second revision;
 *  - nothing is offered while the analysis is greyed by a generation;
 *  - a Resolved finding shows its chip in words and offers Answer and Clear,
 *    and Confirm (never "Confirm again") when its author lost edit rights;
 *  - after an accepted revision the refetched analysis shows the finding
 *    Resolved and another finding the server still lets apply keeps Apply.
 *
 * `@tanstack/react-query` is real, and `next-intl` resolves the real en.json,
 * so a missing or renamed string fails the test.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

vi.mock("next-intl", async () => {
	const { createTranslator } =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const messages = (await import("@repo/i18n/translations/en.json")).default;
	const translators = new Map<string, unknown>();
	return {
		useTranslations: (namespace: string) => {
			if (!translators.has(namespace)) {
				translators.set(
					namespace,
					createTranslator({
						locale: "en",
						messages,
						namespace: namespace as never,
						onError: (error) => {
							throw error;
						},
					}),
				);
			}
			return translators.get(namespace);
		},
		useLocale: () => "en",
	};
});

const api = vi.hoisted(() => ({
	getAnalysis: vi.fn(),
	respondToFinding: vi.fn(),
	clearFindingResponse: vi.fn(),
	rerunAnalysis: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				getAnalysis: (input: unknown) => api.getAnalysis(input),
				respondToFinding: (input: unknown) =>
					api.respondToFinding(input),
				clearFindingResponse: (input: unknown) =>
					api.clearFindingResponse(input),
				rerunAnalysis: (input: unknown) => api.rerunAnalysis(input),
			},
		},
	},
}));

import messages from "@repo/i18n/translations/en.json";
import { ProposalAnalysisPanel } from "@saas/projects/components/proposal-artifact/ProposalAnalysisPanel";
import type { ProposalAnalysis } from "@saas/projects/components/proposal-artifact/use-proposal-analysis";
import {
	analysis,
	DOCUMENT_ID,
	finding,
	PROJECT_ID,
	RUN_ID,
	response,
	savedAnswer,
} from "./proposal-artifact-fixtures";

const copy = messages.projects.proposalArtifact.analysis;
const APPLY = copy.actions.applyRecommendation;

let client: QueryClient;

function renderPanel({
	onApplyRecommendation = vi.fn(),
	pendingRevisionFindingId = null as string | null,
	isGenerating = false,
	withApply = true,
} = {}) {
	const ui = (pending: string | null) => (
		<QueryClientProvider client={client}>
			<ProposalAnalysisPanel
				projectId={PROJECT_ID}
				documentId={DOCUMENT_ID}
				isGenerating={isGenerating}
				onApplyRecommendation={
					withApply ? onApplyRecommendation : undefined
				}
				pendingRevisionFindingId={pending}
			/>
		</QueryClientProvider>
	);
	const view = render(ui(pendingRevisionFindingId));
	return {
		...view,
		onApplyRecommendation,
		setPending: (pending: string | null) => view.rerender(ui(pending)),
	};
}

function serverSays(data: ProposalAnalysis) {
	api.getAnalysis.mockResolvedValue(data);
}

function item(title: string): HTMLElement {
	return screen.getByText(title).closest("li") as HTMLElement;
}

const actionNames = (title: string) =>
	within(item(title))
		.queryAllByRole("button")
		.map((button) => button.textContent);

/** Two section findings the server lets apply and one it does not. */
function threeFindings() {
	return analysis({
		findings: [
			finding({
				id: "f-scope",
				stableKey: "key-scope",
				title: "Scope gap",
				recommendation: "Name an owner for the migration.",
				canApply: true,
			}),
			finding({
				id: "f-pricing",
				stableKey: "key-pricing",
				title: "Pricing gap",
				recommendation: "State the payment terms.",
				canApply: true,
			}),
			finding({
				id: "f-document",
				stableKey: "key-document",
				title: "Whole document",
				recommendation: "Shorten the Proposal.",
				canApply: false,
			}),
		],
	});
}

beforeEach(() => {
	client = new QueryClient({
		defaultOptions: { queries: { retryDelay: 0 } },
	});
	for (const fn of Object.values(api)) {
		fn.mockReset();
	}
});

afterEach(() => {
	client.clear();
});

describe("ProposalAnalysisPanel — Apply recommendation", () => {
	it("offers Apply beside the response controls of each finding the server lets apply", async () => {
		serverSays(threeFindings());
		renderPanel();

		await screen.findByText("Scope gap");
		expect(actionNames("Scope gap")).toEqual([
			APPLY,
			copy.actions.confirm,
			copy.actions.answer,
		]);
		expect(actionNames("Pricing gap")).toContain(APPLY);
		expect(actionNames("Whole document")).not.toContain(APPLY);
	});

	it("hands the page the finding, the shown run and its stable key", async () => {
		serverSays(threeFindings());
		const { onApplyRecommendation } = renderPanel();

		await screen.findByText("Scope gap");
		await userEvent.click(
			within(item("Scope gap")).getByRole("button", { name: APPLY }),
		);

		expect(onApplyRecommendation).toHaveBeenCalledTimes(1);
		expect(onApplyRecommendation).toHaveBeenCalledWith({
			id: "f-scope",
			runId: RUN_ID,
			stableKey: "key-scope",
		});
		expect(api.respondToFinding).not.toHaveBeenCalled();
	});

	it("names the finding it applies to for assistive technology", async () => {
		serverSays(threeFindings());
		renderPanel();

		await screen.findByText("Scope gap");
		expect(
			within(item("Scope gap")).getByRole("button", { name: APPLY }),
		).toHaveAccessibleDescription("Scope gap");
	});

	it("offers nothing when the page takes no request, to a member the server refuses, or while a generation greys the analysis", async () => {
		serverSays(threeFindings());
		const withoutPage = renderPanel({ withApply: false });
		await screen.findByText("Scope gap");
		expect(actionNames("Scope gap")).not.toContain(APPLY);
		withoutPage.unmount();
		client.clear();

		serverSays({ ...threeFindings(), viewer: { canRespond: false } });
		const refused = renderPanel();
		await screen.findByText("Scope gap");
		expect(actionNames("Scope gap")).toEqual([]);
		refused.unmount();
		client.clear();

		serverSays(threeFindings());
		renderPanel({ isGenerating: true });
		await screen.findByText("Scope gap");
		expect(actionNames("Scope gap")).toEqual([]);
	});

	it("says a revision is under way, keeps the finding's actions waiting and starts no second one", async () => {
		serverSays(threeFindings());
		const { onApplyRecommendation } = renderPanel({
			pendingRevisionFindingId: "f-scope",
		});

		await screen.findByText("Scope gap");
		const pending = within(item("Scope gap"));
		expect(pending.getByText(copy.revisionInProgress)).toBeInTheDocument();
		const apply = pending.getByRole("button", { name: APPLY });
		expect(apply).toBeDisabled();
		expect(apply).toHaveAttribute("aria-busy", "true");
		for (const name of [copy.actions.confirm, copy.actions.answer]) {
			expect(pending.getByRole("button", { name })).toBeDisabled();
		}
		expect(
			item("Scope gap").querySelector("[aria-busy='true']"),
		).not.toBeNull();

		// Another finding keeps its answers, but cannot start a revision.
		const other = within(item("Pricing gap"));
		expect(other.getByRole("button", { name: APPLY })).toBeDisabled();
		expect(
			other.getByRole("button", { name: copy.actions.confirm }),
		).toBeEnabled();
		expect(other.queryByText(copy.revisionInProgress)).toBeNull();

		await userEvent.click(other.getByRole("button", { name: APPLY }));
		expect(onApplyRecommendation).not.toHaveBeenCalled();
	});

	it("frees the finding's actions once the revision settles without a change", async () => {
		serverSays(threeFindings());
		const view = renderPanel({ pendingRevisionFindingId: "f-scope" });
		await screen.findByText("Scope gap");

		view.setPending(null);

		const settled = within(item("Scope gap"));
		expect(settled.queryByText(copy.revisionInProgress)).toBeNull();
		expect(settled.getByRole("button", { name: APPLY })).toBeEnabled();
		expect(
			settled.getByRole("button", { name: copy.actions.confirm }),
		).toBeEnabled();
	});

	it("shows the finding Resolved after an accepted revision, and keeps Apply on another finding the server still lets apply", async () => {
		serverSays(threeFindings());
		const view = renderPanel({ pendingRevisionFindingId: "f-scope" });
		await screen.findByText("Scope gap");

		const before = threeFindings();
		serverSays({
			...before,
			findings: [
				{
					...before.findings[0],
					state: "RESOLVED",
					response: response({ kind: "RESOLVED", text: null }),
					canApply: false,
				},
				before.findings[1],
				before.findings[2],
			] as ProposalAnalysis["findings"],
		});
		view.setPending(null);
		await act(() => client.refetchQueries());

		const resolved = within(item("Scope gap"));
		expect(
			await resolved.findByText(copy.state.RESOLVED),
		).toBeInTheDocument();
		expect(actionNames("Scope gap")).toEqual([
			copy.actions.answer,
			copy.actions.clear,
		]);
		expect(
			within(item("Pricing gap")).getByRole("button", { name: APPLY }),
		).toBeEnabled();
	});

	it("has no accessibility violations while a revision is under way", async () => {
		serverSays(threeFindings());
		const { container } = renderPanel({
			pendingRevisionFindingId: "f-scope",
		});
		await screen.findByText("Scope gap");

		expect(await axe(container)).toHaveNoViolations();
	});
});

describe("ProposalAnalysisPanel — Resolved", () => {
	it("offers Confirm, never Confirm again, when the author lost edit rights, and records a confirmation that keeps the note", async () => {
		serverSays(
			analysis({
				findings: [
					finding({
						id: "f-1",
						stableKey: "key-1",
						title: "Applied earlier",
						state: "RESOLVED",
						response: response({
							kind: "RESOLVED",
							version: 2,
							text: "Owner named in the scope.",
							settledSkipReason: "AUTHOR_RIGHTS",
						}),
					}),
				],
			}),
		);
		api.respondToFinding.mockResolvedValue({
			outcome: "written",
			stableKey: "key-1",
			answeredRunId: RUN_ID,
			response: savedAnswer({
				kind: "CONFIRMED",
				version: 3,
				text: "Owner named in the scope.",
			}),
		});
		renderPanel();

		await screen.findByText("Applied earlier");
		expect(actionNames("Applied earlier")).toEqual([
			copy.actions.confirm,
			copy.actions.answer,
			copy.actions.clear,
		]);
		expect(actionNames("Applied earlier")).not.toContain(
			copy.actions.confirmAgain,
		);

		await userEvent.click(
			within(item("Applied earlier")).getByRole("button", {
				name: copy.actions.confirm,
			}),
		);

		expect(api.respondToFinding).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			runId: RUN_ID,
			findingId: "f-1",
			kind: "CONFIRMED",
			text: "Owner named in the scope.",
			responseId: "response-1",
			version: 2,
		});
	});

	it("clears a Resolved answer by the id and version the member saw", async () => {
		serverSays(
			analysis({
				findings: [
					finding({
						id: "f-1",
						stableKey: "key-1",
						title: "Applied",
						state: "RESOLVED",
						response: response({
							id: "response-7",
							kind: "RESOLVED",
							version: 4,
							text: null,
						}),
					}),
				],
			}),
		);
		api.clearFindingResponse.mockResolvedValue({ outcome: "cleared" });
		renderPanel();

		await screen.findByText("Applied");
		await userEvent.click(
			within(item("Applied")).getByRole("button", {
				name: copy.actions.clear,
			}),
		);

		expect(api.clearFindingResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				stableKey: "key-1",
				responseId: "response-7",
				version: 4,
			}),
		);
	});
});
