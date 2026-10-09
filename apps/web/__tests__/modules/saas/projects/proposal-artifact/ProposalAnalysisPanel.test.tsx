/**
 * `ProposalAnalysisPanel` — the Internal Analysis tab of a Proposal
 * (Fizzy #2801).
 *
 * Pinned here: every state of a run says its own sentence (not run, queued,
 * running, timed out, failed per error code, complete, empty); findings are
 * grouped Blocking, Important, Informational and ordered by position inside
 * each group; a finding's type is written out, not only coloured; model
 * output renders as text, never markup; a stale or context-free run is
 * labelled; a regeneration greys the previous run; and a refusal shows one
 * neutral line, nothing the server said, and is never retried.
 *
 * `@tanstack/react-query` is real, with the hook's own retry policy (only the
 * delay is zeroed), and `next-intl` resolves the real en.json, so a missing
 * or renamed string fails the test.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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

const api = vi.hoisted(() => ({ getAnalysis: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				getAnalysis: (input: unknown) => api.getAnalysis(input),
			},
		},
	},
}));

import messages from "@repo/i18n/translations/en.json";
import { ProposalAnalysisPanel } from "@saas/projects/components/proposal-artifact/ProposalAnalysisPanel";
import {
	analysisRun,
	DOCUMENT_ID,
	finding,
	orpcError,
	PROJECT_ID,
} from "./proposal-artifact-fixtures";

const copy = messages.projects.proposalArtifact.analysis;

let client: QueryClient;

function renderPanel({ isGenerating = false, awaitingNewRun = false } = {}) {
	return render(
		<QueryClientProvider client={client}>
			<ProposalAnalysisPanel
				projectId={PROJECT_ID}
				documentId={DOCUMENT_ID}
				isGenerating={isGenerating}
				awaitingNewRun={awaitingNewRun}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	client = new QueryClient({
		defaultOptions: { queries: { retryDelay: 0 } },
	});
	api.getAnalysis.mockReset();
});

afterEach(() => {
	client.clear();
});

describe("ProposalAnalysisPanel — run states", () => {
	it("shows a loading state until the first answer", async () => {
		api.getAnalysis.mockReturnValue(new Promise(() => {}));
		renderPanel();

		expect(await screen.findByText(copy.loading)).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { level: 2, name: copy.title }),
		).toBeInTheDocument();
	});

	it("says no analysis has run yet for a document without one", async () => {
		api.getAnalysis.mockResolvedValue(null);
		renderPanel();

		expect(await screen.findByText(copy.notRun)).toBeInTheDocument();
		expect(api.getAnalysis).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
		});
	});

	it("says one will run after a generation that is under way", async () => {
		api.getAnalysis.mockResolvedValue(null);
		renderPanel({ isGenerating: true });

		expect(
			await screen.findByText(copy.afterGeneration),
		).toBeInTheDocument();
		expect(screen.queryByText(copy.notRun)).not.toBeInTheDocument();
	});

	it("says a queued run waits for the Main Document", async () => {
		api.getAnalysis.mockResolvedValue(analysisRun({ status: "PENDING" }));
		renderPanel();

		const pending = await screen.findByText(copy.pending);
		// A polite status, so the move to RUNNING is announced.
		expect(pending.closest("output")).not.toBeNull();
	});

	it("says a run is in progress", async () => {
		api.getAnalysis.mockResolvedValue(analysisRun({ status: "RUNNING" }));
		renderPanel();

		expect(await screen.findByText(copy.running)).toBeInTheDocument();
	});

	it("reports a run that stopped responding instead of showing it as running", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({ status: "RUNNING", timedOut: true }),
		);
		renderPanel();

		expect(await screen.findByText(copy.timedOut)).toBeInTheDocument();
		expect(screen.getByText(copy.failedHint)).toBeInTheDocument();
		expect(screen.queryByText(copy.running)).not.toBeInTheDocument();
	});

	it.each([
		"AI_PROVIDER_NOT_CONFIGURED",
		"PROMPT_NOT_BOUND",
		"GUEST_TRIGGERED",
		"PROMPT_RENDER_FAILED",
		"MODEL_ERROR",
		"START_FAILED",
		"TIMED_OUT",
	] as const)("explains a run that failed with %s", async (errorCode) => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({
				status: "FAILED",
				errorCode,
				errorMessage: "Stored message",
			}),
		);
		renderPanel();

		expect(
			await screen.findByText(copy.failed[errorCode]),
		).toBeInTheDocument();
		expect(screen.getByText(copy.failedTitle)).toBeInTheDocument();
		expect(screen.getByText(copy.failedHint)).toBeInTheDocument();
	});

	it("names the guest rule for a generation started by a project guest", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({ status: "FAILED", errorCode: "GUEST_TRIGGERED" }),
		);
		renderPanel();

		expect(
			await screen.findByText(/generations started by project guests/),
		).toBeInTheDocument();
	});

	it("falls back to the generic failure for an unknown or missing code", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({ status: "FAILED", errorCode: "SOMETHING_NEW" }),
		);
		const first = renderPanel();
		expect(
			await screen.findByText(copy.failed.unknown),
		).toBeInTheDocument();
		first.unmount();
		client.clear();

		api.getAnalysis.mockResolvedValue(
			analysisRun({ status: "FAILED", errorCode: null }),
		);
		renderPanel();
		expect(
			await screen.findByText(copy.failed.unknown),
		).toBeInTheDocument();
	});

	it("never shows the stored error message, only the copy for its code", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({
				status: "FAILED",
				errorCode: "MODEL_ERROR",
				errorMessage: "Stored message that must not render",
			}),
		);
		renderPanel();

		await screen.findByText(copy.failed.MODEL_ERROR);
		expect(
			screen.queryByText(/Stored message that must not render/),
		).not.toBeInTheDocument();
	});

	it("says a complete run found nothing", async () => {
		api.getAnalysis.mockResolvedValue(analysisRun({ findings: [] }));
		renderPanel();

		expect(await screen.findByText(copy.empty)).toBeInTheDocument();
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — findings", () => {
	it("groups Blocking, Important, Informational with counts, ordered by position", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({
				// Deliberately out of order: the panel sorts, not the server.
				findings: [
					finding({
						severity: "INFORMATIONAL",
						title: "Info first",
						position: 0,
					}),
					finding({
						severity: "BLOCKING",
						title: "Blocking second",
						position: 5,
					}),
					finding({
						severity: "IMPORTANT",
						title: "Important only",
						position: 2,
					}),
					finding({
						severity: "BLOCKING",
						title: "Blocking first",
						position: 1,
					}),
				],
			}),
		);
		renderPanel();

		const groups = await screen.findAllByRole("heading", { level: 3 });
		expect(groups.map((heading) => heading.textContent)).toEqual([
			`${copy.severity.BLOCKING} 2`,
			`${copy.severity.IMPORTANT} 1`,
			`${copy.severity.INFORMATIONAL} 1`,
		]);

		const titles = screen
			.getAllByRole("listitem")
			.map((item) => item.querySelector("p")?.textContent);
		expect(titles).toEqual([
			"Blocking first",
			"Blocking second",
			"Important only",
			"Info first",
		]);
		expect(screen.getByText("4 findings")).toBeInTheDocument();
	});

	it("keeps an empty severity group, saying it has none", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({ findings: [finding({ severity: "IMPORTANT" })] }),
		);
		renderPanel();

		const blocking = await screen.findByRole("region", {
			name: `${copy.severity.BLOCKING} 0`,
		});
		expect(within(blocking).getByText(copy.groupEmpty)).toBeInTheDocument();
	});

	it("writes out each finding's type, with recommendation and section as secondary text", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({
				findings: [
					finding({
						severity: "BLOCKING",
						type: "SOURCE_VALIDATION",
						title: "Unverified client figure",
						detail: "The rollout headcount has no source.",
						recommendation:
							"Confirm the headcount with the client.",
						sectionHeading: "Timeline",
					}),
					finding({ type: "COMMERCIAL", title: "Payment terms" }),
				],
			}),
		);
		renderPanel();

		const item = (
			await screen.findByText("Unverified client figure")
		).closest("li") as HTMLElement;
		expect(
			within(item).getByText(copy.type.SOURCE_VALIDATION),
		).toBeInTheDocument();
		expect(
			within(item).getByText("The rollout headcount has no source."),
		).toBeInTheDocument();
		expect(within(item).getByText(copy.recommendation)).toBeInTheDocument();
		expect(
			within(item).getByText("Confirm the headcount with the client."),
		).toBeInTheDocument();
		expect(within(item).getByText("Section: Timeline")).toBeInTheDocument();

		const other = screen
			.getByText("Payment terms")
			.closest("li") as HTMLElement;
		expect(
			within(other).getByText(copy.type.COMMERCIAL),
		).toBeInTheDocument();
		expect(
			within(other).queryByText(copy.recommendation),
		).not.toBeInTheDocument();
	});

	it("renders a finding containing markup as escaped text", async () => {
		const title = '<img src="x" onerror="alert(1)">Injected';
		const detail =
			"<script>alert(2)</script> **not bold** [link](https://example.com)";
		api.getAnalysis.mockResolvedValue(
			analysisRun({
				findings: [
					finding({
						title,
						detail,
						recommendation: "<b>bold?</b>",
						sectionHeading: "<em>Scope</em>",
					}),
				],
			}),
		);
		const { container } = renderPanel();

		expect(await screen.findByText(title)).toBeInTheDocument();
		expect(screen.getByText(detail)).toBeInTheDocument();
		expect(screen.getByText("<b>bold?</b>")).toBeInTheDocument();
		expect(screen.getByText("Section: <em>Scope</em>")).toBeInTheDocument();
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("b, strong, em, a")).toBeNull();
	});

	it("labels a run of an earlier version as stale", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({ isStale: true, findings: [finding()] }),
		);
		renderPanel();

		expect(await screen.findByText(copy.stale)).toBeInTheDocument();
	});

	it("shows no stale banner for a current run", async () => {
		api.getAnalysis.mockResolvedValue(analysisRun({ findings: [] }));
		renderPanel();

		await screen.findByText(copy.empty);
		expect(screen.queryByText(copy.stale)).not.toBeInTheDocument();
	});

	it("notes a complete run that had no source context", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({ contextCount: 0, findings: [] }),
		);
		renderPanel();

		expect(await screen.findByText(copy.noContext)).toBeInTheDocument();
	});

	it("does not add the context note to a run that did not complete", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({
				status: "FAILED",
				errorCode: "MODEL_ERROR",
				contextCount: 0,
			}),
		);
		renderPanel();

		await screen.findByText(copy.failed.MODEL_ERROR);
		expect(screen.queryByText(copy.noContext)).not.toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — during a regeneration", () => {
	it("keeps the previous run visible, greyed, and says a new one follows", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({
				isStale: true,
				findings: [finding({ title: "Previous finding" })],
			}),
		);
		renderPanel({ isGenerating: true });

		expect(
			await screen.findByText(copy.newRunAfterGeneration),
		).toBeInTheDocument();
		const previous = screen.getByText("Previous finding");
		expect(previous.closest(".opacity-60")).not.toBeNull();
		// The notice replaces the stale banner while the new run is pending.
		expect(screen.queryByText(copy.stale)).not.toBeInTheDocument();
	});

	it("says the analysis of a generation that just ended is on its way, not that the next one runs it", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({
				isStale: true,
				findings: [finding({ title: "Previous finding" })],
			}),
		);
		renderPanel({ awaitingNewRun: true });

		expect(
			await screen.findByText(copy.awaitingNewRun),
		).toBeInTheDocument();
		const previous = screen.getByText("Previous finding");
		expect(previous.closest(".opacity-60")).not.toBeNull();
		expect(screen.queryByText(copy.stale)).not.toBeInTheDocument();
	});

	it("says the first analysis is on its way once its generation ends", async () => {
		api.getAnalysis.mockResolvedValue(null);
		renderPanel({ awaitingNewRun: true });

		expect(await screen.findByText(copy.awaiting)).toBeInTheDocument();
		expect(screen.queryByText(copy.notRun)).not.toBeInTheDocument();
	});

	it("shows a current run as it is while awaiting, with no notice", async () => {
		api.getAnalysis.mockResolvedValue(analysisRun({ findings: [] }));
		renderPanel({ awaitingNewRun: true });

		await screen.findByText(copy.empty);
		expect(screen.queryByText(copy.awaitingNewRun)).not.toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — refusals and faults", () => {
	it("renders one neutral line for FORBIDDEN, nothing the server said, and never retries", async () => {
		api.getAnalysis.mockRejectedValue(
			orpcError(
				"FORBIDDEN",
				"Secret: organization membership required for example-org",
				{ code: "ORGANIZATION_MEMBERSHIP_REQUIRED" },
			),
		);
		const { container } = renderPanel();

		expect(await screen.findByText(copy.unavailable)).toBeInTheDocument();
		expect(container).not.toHaveTextContent(/Secret|example-org/);
		expect(container).not.toHaveTextContent(
			/ORGANIZATION_MEMBERSHIP_REQUIRED/,
		);
		expect(
			screen.queryByRole("button", { name: copy.retry }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("list")).not.toBeInTheDocument();

		// Retries run immediately in this client; a denial must not get any.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(api.getAnalysis).toHaveBeenCalledTimes(1);
	});

	it("treats NOT_FOUND (gate off, document gone) the same way", async () => {
		api.getAnalysis.mockRejectedValue(orpcError("NOT_FOUND"));
		renderPanel();

		expect(await screen.findByText(copy.unavailable)).toBeInTheDocument();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(api.getAnalysis).toHaveBeenCalledTimes(1);
	});

	it("offers a retry after a fault, without the error's text", async () => {
		api.getAnalysis.mockRejectedValue(
			orpcError("INTERNAL_SERVER_ERROR", "Database exploded"),
		);
		const { container } = renderPanel();

		expect(await screen.findByText(copy.loadFailed)).toBeInTheDocument();
		expect(container).not.toHaveTextContent(/Database exploded/);
		const calls = api.getAnalysis.mock.calls.length;

		api.getAnalysis.mockResolvedValue(null);
		await userEvent.click(screen.getByRole("button", { name: copy.retry }));
		expect(await screen.findByText(copy.notRun)).toBeInTheDocument();
		expect(api.getAnalysis.mock.calls.length).toBeGreaterThan(calls);
	});
});

describe("ProposalAnalysisPanel — after a good answer", () => {
	it("stops showing findings once a refetch is refused", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({ findings: [finding({ title: "Internal note" })] }),
		);
		renderPanel();
		await screen.findByText("Internal note");

		api.getAnalysis.mockRejectedValue(orpcError("FORBIDDEN"));
		await act(() => client.refetchQueries());

		expect(await screen.findByText(copy.unavailable)).toBeInTheDocument();
		expect(screen.queryByText("Internal note")).not.toBeInTheDocument();
	});

	it("keeps the last answer through a fault on a refetch", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({ findings: [finding({ title: "Still here" })] }),
		);
		renderPanel();
		await screen.findByText("Still here");

		api.getAnalysis.mockRejectedValue(orpcError("INTERNAL_SERVER_ERROR"));
		await act(() => client.refetchQueries());

		await waitFor(() =>
			expect(
				client.getQueryState([
					"projects",
					"proposalArtifact",
					"analysis",
					PROJECT_ID,
					DOCUMENT_ID,
				])?.status,
			).toBe("error"),
		);
		expect(screen.getByText("Still here")).toBeInTheDocument();
		expect(screen.queryByText(copy.loadFailed)).not.toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — accessibility", () => {
	it("has no axe violations with findings, when failed, and while regenerating", async () => {
		api.getAnalysis.mockResolvedValue(
			analysisRun({
				isStale: true,
				contextCount: 0,
				findings: [
					finding({
						severity: "BLOCKING",
						recommendation: "Do this.",
						sectionHeading: "Scope",
					}),
					finding({ severity: "INFORMATIONAL" }),
				],
			}),
		);
		const complete = renderPanel();
		await screen.findByText(copy.stale);
		expect(await axe(complete.container)).toHaveNoViolations();
		complete.unmount();
		client.clear();

		api.getAnalysis.mockResolvedValue(
			analysisRun({ status: "FAILED", errorCode: "MODEL_ERROR" }),
		);
		const failed = renderPanel();
		await screen.findByText(copy.failed.MODEL_ERROR);
		expect(await axe(failed.container)).toHaveNoViolations();
		failed.unmount();
		client.clear();

		api.getAnalysis.mockResolvedValue(
			analysisRun({ findings: [finding()] }),
		);
		const regenerating = renderPanel({ isGenerating: true });
		await screen.findByText(copy.newRunAfterGeneration);
		await waitFor(async () =>
			expect(await axe(regenerating.container)).toHaveNoViolations(),
		);
	});
});
