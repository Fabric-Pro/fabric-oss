/**
 * `ProposalAnalysisPanel` — the Internal Analysis tab of a Proposal
 * (Fizzy #2801, Fizzy #2946).
 *
 * Pinned here:
 *  - every state of the analysis says its own sentence (not run, a first run
 *    queued, running or failed per error code, complete, empty), and a newer
 *    run that fails leaves the complete run's findings visible under a
 *    banner;
 *  - findings are grouped Blocking, Important, Informational, those waiting
 *    for a decision first; a finding's type and state are written out, not
 *    only coloured; model output renders as text, never markup;
 *  - a member with edit rights confirms, answers and clears per state, with
 *    optimistic updates undone on refusal; stale writes keep the draft;
 *    drafts survive refetches and newer runs by stable key; actions follow
 *    the server's `viewer.canRespond`, never a role the page passes in;
 *  - re-run states, refusals and the source line; evidence chips; answers no
 *    longer raised; one polite live region, and every action reachable by
 *    keyboard;
 *  - a refusal of the read shows one neutral line and is never retried;
 *  - the run's report sits after unsaved answers and above the findings;
 *    "Full report" stays open through polls and the greyed state, closes
 *    for a newer run, and only the member's own re-run moves focus back to
 *    it.
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

const parse = vi.hoisted(() => ({ fail: false }));

vi.mock(
	"@saas/projects/components/proposal-artifact/report-citations-remark",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@saas/projects/components/proposal-artifact/report-citations-remark")
			>();
		return {
			...actual,
			remarkReportCitations: vi.fn(
				(
					options: Parameters<typeof actual.remarkReportCitations>[0],
				) => {
					if (parse.fail) {
						throw new Error("The renderer failed");
					}
					return actual.remarkReportCitations(options);
				},
			),
		};
	},
);

import messages from "@repo/i18n/translations/en.json";
import { ProposalAnalysisPanel } from "@saas/projects/components/proposal-artifact/ProposalAnalysisPanel";
import { remarkReportCitations } from "@saas/projects/components/proposal-artifact/report-citations-remark";
import type { ProposalAnalysis } from "@saas/projects/components/proposal-artifact/use-proposal-analysis";
import {
	analysis,
	DOCUMENT_ID,
	finding,
	newerRun,
	noAnalysis,
	noLongerRaised,
	orpcError,
	PROJECT_ID,
	RUN_ID,
	report,
	response,
	savedAnswer,
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

/** The server's answer to every read from now on. */
function serverSays(data: ProposalAnalysis) {
	api.getAnalysis.mockResolvedValue(data);
}

/** The list item of the finding with this title. */
function item(title: string): HTMLElement {
	return screen.getByText(title).closest("li") as HTMLElement;
}

/** The panel's live region. */
function liveRegion(container: HTMLElement): HTMLElement {
	return container.querySelector("output[aria-live='polite']") as HTMLElement;
}

/** A promise the test settles, to look at the page mid-write. */
function deferred<T>() {
	let settle!: (value: T) => void;
	let fail!: (error: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	return { promise, settle, fail };
}

beforeEach(() => {
	client = new QueryClient({
		defaultOptions: { queries: { retryDelay: 0 } },
	});
	for (const fn of Object.values(api)) {
		fn.mockReset();
	}
	parse.fail = false;
	vi.mocked(remarkReportCitations).mockClear();
});

afterEach(() => {
	client.clear();
});

describe("ProposalAnalysisPanel — analysis states", () => {
	it("shows a loading state until the first answer", async () => {
		api.getAnalysis.mockReturnValue(new Promise(() => {}));
		renderPanel();

		expect(await screen.findByText(copy.loading)).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { level: 2, name: copy.title }),
		).toBeInTheDocument();
	});

	it("says no analysis has run yet, and offers no re-run", async () => {
		serverSays(noAnalysis());
		renderPanel();

		expect(await screen.findByText(copy.notRun)).toBeInTheDocument();
		expect(api.getAnalysis).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
		});
		expect(
			screen.queryByRole("button", { name: copy.rerun.button }),
		).not.toBeInTheDocument();
	});

	it("says one will run after a generation that is under way", async () => {
		serverSays(noAnalysis());
		renderPanel({ isGenerating: true });

		expect(
			await screen.findByText(copy.afterGeneration),
		).toBeInTheDocument();
		expect(screen.queryByText(copy.notRun)).not.toBeInTheDocument();
	});

	it("says a first run waits for the Main Document, then runs", async () => {
		serverSays(
			analysis({
				run: null,
				newerRun: newerRun({ kind: "GENERATION", status: "PENDING" }),
			}),
		);
		renderPanel();
		expect(await screen.findByText(copy.pending)).toBeInTheDocument();

		serverSays(
			analysis({
				run: null,
				newerRun: newerRun({ kind: "GENERATION", status: "RUNNING" }),
			}),
		);
		await act(() => client.refetchQueries());
		expect(await screen.findByText(copy.running)).toBeInTheDocument();
	});

	it("says a first re-run is under way", async () => {
		serverSays(analysis({ run: null, newerRun: newerRun() }));
		renderPanel();

		expect(await screen.findByText(copy.rerunRunning)).toBeInTheDocument();
	});

	it("reports a first run that stopped responding instead of showing it as running", async () => {
		serverSays(
			analysis({
				run: null,
				newerRun: newerRun({ status: "RUNNING", timedOut: true }),
			}),
		);
		renderPanel();

		expect(await screen.findByText(copy.timedOut)).toBeInTheDocument();
		expect(screen.getByText(copy.failedHint)).toBeInTheDocument();
		expect(screen.queryByText(copy.rerunRunning)).not.toBeInTheDocument();
	});

	it.each([
		"AI_PROVIDER_NOT_CONFIGURED",
		"PROMPT_NOT_BOUND",
		"GUEST_TRIGGERED",
		"PROMPT_RENDER_FAILED",
		"MODEL_ERROR",
		"START_FAILED",
		"TIMED_OUT",
	] as const)(
		"explains a first run that failed with %s",
		async (errorCode) => {
			serverSays(
				analysis({
					run: null,
					newerRun: newerRun({ status: "FAILED", errorCode }),
				}),
			);
			renderPanel();

			expect(
				await screen.findByText(copy.failed[errorCode]),
			).toBeInTheDocument();
			expect(screen.getByText(copy.failedTitle)).toBeInTheDocument();
			expect(screen.getByText(copy.failedHint)).toBeInTheDocument();
		},
	);

	it("falls back to the generic failure for an unknown or missing code", async () => {
		serverSays(
			analysis({
				run: null,
				newerRun: newerRun({
					status: "FAILED",
					errorCode: "SOMETHING_NEW",
				}),
			}),
		);
		const first = renderPanel();
		expect(
			await screen.findByText(copy.failed.unknown),
		).toBeInTheDocument();
		first.unmount();
		client.clear();

		serverSays(
			analysis({
				run: null,
				newerRun: newerRun({ status: "FAILED", errorCode: null }),
			}),
		);
		renderPanel();
		expect(
			await screen.findByText(copy.failed.unknown),
		).toBeInTheDocument();
	});

	it("says a complete run found nothing", async () => {
		serverSays(analysis({ findings: [] }));
		renderPanel();

		expect(await screen.findByText(copy.empty)).toBeInTheDocument();
		expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — a newer run over the shown one", () => {
	it("keeps the complete run's findings under a failure banner with Re-run", async () => {
		serverSays(
			analysis({
				findings: [finding({ title: "Still shown" })],
				newerRun: newerRun({
					status: "FAILED",
					errorCode: "MODEL_ERROR",
				}),
			}),
		);
		renderPanel();

		expect(
			await screen.findByText(copy.newerFailedTitle),
		).toBeInTheDocument();
		expect(screen.getByText(copy.failed.MODEL_ERROR)).toBeInTheDocument();
		expect(screen.getByText(copy.newerFailedKept)).toBeInTheDocument();
		expect(screen.getByText("Still shown")).toBeInTheDocument();
		// One Re-run, inside the banner.
		const rerun = screen.getAllByRole("button", {
			name: copy.rerun.button,
		});
		expect(rerun).toHaveLength(1);
		expect(rerun[0]?.closest("[role='note']")?.textContent).toContain(
			copy.newerFailedTitle,
		);
	});

	it("says a newer run is under way above the findings, which stay answerable", async () => {
		serverSays(
			analysis({
				findings: [finding({ title: "Answer me" })],
				newerRun: newerRun({ kind: "GENERATION", status: "RUNNING" }),
			}),
		);
		renderPanel();

		expect(await screen.findByText(copy.newerRunning)).toBeInTheDocument();
		expect(
			within(item("Answer me")).getByRole("button", {
				name: copy.actions.confirm,
			}),
		).toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — findings", () => {
	it("groups by severity with counts, decisions first, then by position", async () => {
		serverSays(
			analysis({
				// Deliberately out of order: the panel sorts, not the server.
				findings: [
					finding({
						severity: "INFORMATIONAL",
						title: "Info first",
						position: 0,
					}),
					finding({
						severity: "BLOCKING",
						title: "Blocking answered",
						position: 1,
						state: "CONFIRMED",
						response: response({ kind: "CONFIRMED", text: null }),
					}),
					finding({
						severity: "IMPORTANT",
						title: "Important only",
						position: 2,
					}),
					finding({
						severity: "BLOCKING",
						title: "Blocking open",
						position: 5,
					}),
					finding({
						severity: "BLOCKING",
						title: "Blocking to review",
						position: 7,
						state: "NEEDS_REVIEW",
						reason: "SECTION_CHANGED",
						response: response(),
					}),
				],
			}),
		);
		renderPanel();

		const groups = await screen.findAllByRole("heading", { level: 3 });
		expect(groups.map((heading) => heading.textContent)).toEqual([
			`${copy.severity.BLOCKING} 3`,
			`${copy.severity.IMPORTANT} 1`,
			`${copy.severity.INFORMATIONAL} 1`,
		]);

		const titles = screen
			.getAllByRole("listitem")
			.filter((element) => element.classList.contains("rounded-lg"))
			.map((element) => element.querySelector("p")?.textContent);
		expect(titles).toEqual([
			"Blocking open",
			"Blocking to review",
			"Blocking answered",
			"Important only",
			"Info first",
		]);
		expect(screen.getByText("4 of 5 need a decision")).toBeInTheDocument();
	});

	it("keeps an empty severity group, saying it has none", async () => {
		serverSays(
			analysis({ findings: [finding({ severity: "IMPORTANT" })] }),
		);
		renderPanel();

		const blocking = await screen.findByRole("region", {
			name: `${copy.severity.BLOCKING} 0`,
		});
		expect(within(blocking).getByText(copy.groupEmpty)).toBeInTheDocument();
	});

	it("writes out each finding's type, with recommendation, section and folded titles as secondary text", async () => {
		serverSays(
			analysis({
				findings: [
					finding({
						severity: "BLOCKING",
						type: "SOURCE_VALIDATION",
						title: "Unverified client figure",
						detail: "The rollout headcount has no source.",
						recommendation:
							"Confirm the headcount with the client.",
						sectionHeading: "Timeline",
						foldedTitles: ["Headcount unclear"],
					}),
					finding({ type: "COMMERCIAL", title: "Payment terms" }),
				],
			}),
		);
		renderPanel();

		const first = (
			await screen.findByText("Unverified client figure")
		).closest("li") as HTMLElement;
		expect(
			within(first).getByText(copy.type.SOURCE_VALIDATION),
		).toBeInTheDocument();
		expect(
			within(first).getByText("The rollout headcount has no source."),
		).toBeInTheDocument();
		expect(
			within(first).getByText(copy.recommendation),
		).toBeInTheDocument();
		expect(
			within(first).getByText("Confirm the headcount with the client."),
		).toBeInTheDocument();
		expect(
			within(first).getByText("Section: Timeline"),
		).toBeInTheDocument();
		expect(
			within(first).getByText("Also raised as: Headcount unclear"),
		).toBeInTheDocument();

		const other = item("Payment terms");
		expect(
			within(other).getByText(copy.type.COMMERCIAL),
		).toBeInTheDocument();
		expect(
			within(other).queryByText(copy.recommendation),
		).not.toBeInTheDocument();
	});

	it("renders a finding and an answer containing markup as escaped text", async () => {
		const title = '<img src="x" onerror="alert(1)">Injected';
		const detail =
			"<script>alert(2)</script> **not bold** [link](https://example.com)";
		serverSays(
			analysis({
				findings: [
					finding({
						title,
						detail,
						recommendation: "<b>bold?</b>",
						sectionHeading: "<em>Scope</em>",
						state: "RESPONDED",
						response: response({ text: "<i>answer</i>" }),
					}),
				],
			}),
		);
		const { container } = renderPanel();

		expect(await screen.findByText(title)).toBeInTheDocument();
		expect(screen.getByText(detail)).toBeInTheDocument();
		expect(screen.getByText("<b>bold?</b>")).toBeInTheDocument();
		expect(screen.getByText("Section: <em>Scope</em>")).toBeInTheDocument();
		expect(screen.getByText("<i>answer</i>")).toBeInTheDocument();
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("b, strong, em, i, a")).toBeNull();
	});

	it("labels a run of an earlier version as stale, and a current one not", async () => {
		serverSays(analysis({ isStale: true, findings: [finding()] }));
		const stale = renderPanel();
		expect(await screen.findByText(copy.stale)).toBeInTheDocument();
		stale.unmount();
		client.clear();

		serverSays(analysis({ findings: [] }));
		renderPanel();
		await screen.findByText(copy.empty);
		expect(screen.queryByText(copy.stale)).not.toBeInTheDocument();
	});

	it("notes a complete run that had no source context", async () => {
		serverSays(analysis({ run: { contextCount: 0 }, findings: [] }));
		renderPanel();

		expect(await screen.findByText(copy.noContext)).toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — during a regeneration", () => {
	it("keeps the previous run visible, greyed and read-only, and says a new one follows", async () => {
		serverSays(
			analysis({
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
		expect(
			screen.queryByRole("button", { name: copy.actions.confirm }),
		).not.toBeInTheDocument();
	});

	it("disables Re-run while the document generates, saying why", async () => {
		serverSays(analysis({ findings: [finding()] }));
		renderPanel({ isGenerating: true });

		const rerun = await screen.findByRole("button", {
			name: copy.rerun.button,
		});
		expect(rerun).toBeDisabled();
		expect(screen.getByText(copy.rerun.generating)).toBeInTheDocument();
	});

	it("says the analysis of a generation that just ended is on its way", async () => {
		serverSays(
			analysis({
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
		serverSays(noAnalysis());
		renderPanel({ awaitingNewRun: true });

		expect(await screen.findByText(copy.awaiting)).toBeInTheDocument();
		expect(screen.queryByText(copy.notRun)).not.toBeInTheDocument();
	});

	it("shows a current run as it is while awaiting, with no notice", async () => {
		serverSays(analysis({ findings: [] }));
		renderPanel({ awaitingNewRun: true });

		await screen.findByText(copy.empty);
		expect(screen.queryByText(copy.awaitingNewRun)).not.toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — states and their actions", () => {
	const actionNames = (title: string) =>
		within(item(title))
			.queryAllByRole("button")
			.map((button) => button.textContent);

	it.each([
		{
			state: "UNADDRESSED" as const,
			actions: [copy.actions.confirm, copy.actions.answer],
		},
		{
			state: "CONFIRMED" as const,
			actions: [copy.actions.answer, copy.actions.clear],
		},
		{
			state: "RESPONDED" as const,
			actions: [
				copy.actions.editAnswer,
				copy.actions.confirm,
				copy.actions.clear,
			],
		},
		{
			state: "RESOLVED" as const,
			actions: [copy.actions.answer, copy.actions.clear],
		},
		{
			state: "NEEDS_REVIEW" as const,
			actions: [
				copy.actions.confirmAgain,
				copy.actions.answerAgain,
				copy.actions.clear,
			],
		},
	])(
		"$state shows its chip in words and offers $actions",
		async ({ state, actions }) => {
			serverSays(
				analysis({
					findings: [
						finding({
							title: "The finding",
							state,
							reason:
								state === "NEEDS_REVIEW"
									? "SECTION_CHANGED"
									: null,
							response:
								state === "UNADDRESSED"
									? null
									: response({
											kind:
												state === "CONFIRMED" ||
												state === "RESOLVED"
													? state
													: "RESPONDED",
										}),
						}),
					],
				}),
			);
			renderPanel();

			await screen.findByText("The finding");
			expect(
				within(item("The finding")).getByText(copy.state[state]),
			).toBeInTheDocument();
			expect(actionNames("The finding")).toEqual(actions);
		},
	);

	it("shows why an answer needs review, with the earlier answer", async () => {
		serverSays(
			analysis({
				findings: [
					finding({
						title: "Changed",
						state: "NEEDS_REVIEW",
						reason: "SECTION_CHANGED",
						response: response({ text: "We cover it in phase 2." }),
					}),
					finding({
						title: "Gone",
						state: "NEEDS_REVIEW",
						reason: "SECTION_NOT_FOUND",
						response: response({ kind: "CONFIRMED", text: null }),
					}),
					finding({
						title: "Again",
						state: "NEEDS_REVIEW",
						reason: "RAISED_AGAIN",
						response: response(),
					}),
				],
			}),
		);
		renderPanel();

		await screen.findByText("Changed");
		const changed = within(item("Changed"));
		expect(
			changed.getByText(copy.reason.SECTION_CHANGED),
		).toBeInTheDocument();
		expect(
			changed.getByText("Earlier answer by Dana Example"),
		).toBeInTheDocument();
		expect(
			changed.getByText("We cover it in phase 2."),
		).toBeInTheDocument();
		const gone = within(item("Gone"));
		expect(
			gone.getByText(copy.reason.SECTION_NOT_FOUND),
		).toBeInTheDocument();
		expect(
			gone.getByText("Previously confirmed by Dana Example"),
		).toBeInTheDocument();
		expect(
			within(item("Again")).getByText(copy.reason.RAISED_AGAIN),
		).toBeInTheDocument();
	});

	it("offers no action at all when the server says the member may not respond", async () => {
		serverSays(
			analysis({
				findings: [
					finding({ title: "Open" }),
					finding({
						title: "Answered",
						state: "RESPONDED",
						response: response(),
					}),
				],
				noLongerRaised: [noLongerRaised()],
				viewer: { canRespond: false },
			}),
		);
		renderPanel();

		await screen.findByText("Open");
		expect(
			within(item("Open")).getByText(copy.state.UNADDRESSED),
		).toBeInTheDocument();
		for (const name of [
			copy.actions.confirm,
			copy.actions.answer,
			copy.actions.editAnswer,
			copy.actions.clear,
			copy.rerun.button,
		]) {
			expect(
				screen.queryByRole("button", { name }),
			).not.toBeInTheDocument();
		}
	});

	it("offers the actions when the server says the member may respond", async () => {
		serverSays(
			analysis({
				findings: [finding({ title: "Open" })],
				viewer: { canRespond: true },
			}),
		);
		renderPanel();

		await screen.findByText("Open");
		expect(actionNames("Open")).toEqual([
			copy.actions.confirm,
			copy.actions.answer,
		]);
		expect(
			screen.getByRole("button", { name: copy.rerun.button }),
		).toBeInTheDocument();
	});

	it("offers nothing on a finding without a key, saying a re-run gives it one", async () => {
		serverSays(
			analysis({
				findings: [
					finding({
						title: "Before keys",
						stableKey: null,
						keyed: false,
					}),
				],
			}),
		);
		renderPanel();

		await screen.findByText("Before keys");
		expect(actionNames("Before keys")).toEqual([]);
		expect(
			within(item("Before keys")).getByText(copy.notKeyed),
		).toBeInTheDocument();
	});

	it("says an answer whose author lost edit rights is not applied, and confirms it again as it stands", async () => {
		serverSays(
			analysis({
				findings: [
					finding({
						id: "f-1",
						stableKey: "key-1",
						title: "Former author",
						state: "RESPONDED",
						response: response({
							version: 3,
							text: "Agreed with the client.",
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
				version: 4,
				text: "Agreed with the client.",
			}),
		});
		renderPanel();

		await screen.findByText("Former author");
		expect(
			within(item("Former author")).getByText(copy.authorRights),
		).toBeInTheDocument();
		await userEvent.click(
			within(item("Former author")).getByRole("button", {
				name: copy.actions.confirm,
			}),
		);

		expect(api.respondToFinding).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			runId: RUN_ID,
			findingId: "f-1",
			kind: "RESPONDED",
			text: "Agreed with the client.",
			responseId: "response-1",
			version: 3,
		});
	});

	it("keeps Needs Review's own chip over the author rule", async () => {
		serverSays(
			analysis({
				findings: [
					finding({
						title: "Both",
						state: "NEEDS_REVIEW",
						reason: "SECTION_CHANGED",
						response: response({
							settledSkipReason: "NEEDS_REVIEW",
						}),
					}),
				],
			}),
		);
		renderPanel();

		await screen.findByText("Both");
		expect(
			within(item("Both")).getByText(copy.state.NEEDS_REVIEW),
		).toBeInTheDocument();
		expect(screen.queryByText(copy.authorRights)).not.toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — confirm, answer, clear", () => {
	const open = () =>
		finding({ id: "f-1", stableKey: "key-1", title: "Open finding" });

	it("confirms at once, sends the run and finding, and announces it", async () => {
		serverSays(analysis({ findings: [open()] }));
		const write = deferred<unknown>();
		api.respondToFinding.mockReturnValue(write.promise);
		const { container } = renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.confirm,
			}),
		);

		// Shown before the server answers, saying it is saving.
		await waitFor(() =>
			expect(
				within(item("Open finding")).getByText(copy.state.CONFIRMED),
			).toBeInTheDocument(),
		);
		expect(
			within(item("Open finding")).getByText(copy.answer.saving),
		).toBeInTheDocument();
		expect(api.respondToFinding).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			runId: RUN_ID,
			findingId: "f-1",
			kind: "CONFIRMED",
			text: undefined,
		});
		// A first answer names no earlier one, so the server only creates.
		const [sent] = api.respondToFinding.mock.calls[0] ?? [];
		expect(sent).not.toHaveProperty("responseId");
		expect(sent).not.toHaveProperty("version");

		serverSays(
			analysis({
				findings: [
					{
						...open(),
						state: "CONFIRMED",
						response: response({ kind: "CONFIRMED", text: null }),
					},
				],
			}),
		);
		await act(async () => {
			write.settle({
				outcome: "written",
				stableKey: "key-1",
				answeredRunId: RUN_ID,
				response: savedAnswer({ kind: "CONFIRMED", text: null }),
			});
		});
		await waitFor(() =>
			expect(liveRegion(container)).toHaveTextContent(
				copy.announce.confirmed,
			),
		);
		expect(
			within(item("Open finding")).getByText("Confirmed by Dana Example"),
		).toBeInTheDocument();
	});

	it("undoes a confirmation the server fails, saying so in generic words", async () => {
		serverSays(analysis({ findings: [open()] }));
		api.respondToFinding.mockRejectedValue(
			orpcError("INTERNAL_SERVER_ERROR", "Database exploded"),
		);
		const { container } = renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.confirm,
			}),
		);

		expect(
			await within(item("Open finding")).findByText(
				copy.errors.saveFailed,
			),
		).toBeInTheDocument();
		expect(
			within(item("Open finding")).getByText(copy.state.UNADDRESSED),
		).toBeInTheDocument();
		expect(container).not.toHaveTextContent(/Database exploded/);
	});

	it("shows nothing sensitive when the server forbids an answer", async () => {
		serverSays(analysis({ findings: [open()] }));
		api.respondToFinding.mockRejectedValue(
			orpcError(
				"FORBIDDEN",
				"Secret: membership required for example-org",
				{
					code: "ORGANIZATION_MEMBERSHIP_REQUIRED",
				},
			),
		);
		const { container } = renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.answer,
			}),
		);
		await userEvent.type(
			screen.getByLabelText(copy.editor.label),
			"Our answer",
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.save }),
		);

		expect(
			await within(item("Open finding")).findByText(
				copy.errors.forbidden,
			),
		).toBeInTheDocument();
		expect(container).not.toHaveTextContent(
			/Secret|example-org|ORGANIZATION_MEMBERSHIP_REQUIRED/,
		);
		// The draft is kept.
		expect(screen.getByLabelText(copy.editor.label)).toHaveValue(
			"Our answer",
		);
	});

	it("answers in plain text with a counter, optimistically, and closes the field on save", async () => {
		serverSays(analysis({ findings: [open()] }));
		const write = deferred<unknown>();
		api.respondToFinding.mockReturnValue(write.promise);
		const { container } = renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.answer,
			}),
		);
		const field = screen.getByLabelText(copy.editor.label);
		expect(field).toHaveFocus();
		await userEvent.type(field, "Phase 2 covers it.");
		expect(screen.getByText("18 / 2000 characters")).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.save }),
		);

		await waitFor(() =>
			expect(
				within(item("Open finding")).getByText(copy.state.RESPONDED),
			).toBeInTheDocument(),
		);
		expect(api.respondToFinding).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: RUN_ID,
				findingId: "f-1",
				kind: "RESPONDED",
				text: "Phase 2 covers it.",
			}),
		);

		await act(async () => {
			write.settle({
				outcome: "written",
				stableKey: "key-1",
				answeredRunId: RUN_ID,
				response: savedAnswer({ text: "Phase 2 covers it." }),
			});
		});
		await waitFor(() =>
			expect(
				screen.queryByLabelText(copy.editor.label),
			).not.toBeInTheDocument(),
		);
		expect(liveRegion(container)).toHaveTextContent(copy.announce.answered);
	});

	it("refuses an answer over the limit before sending it", async () => {
		serverSays(analysis({ findings: [open()] }));
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.answer,
			}),
		);
		const field = screen.getByLabelText(copy.editor.label);
		await userEvent.click(field);
		await userEvent.paste("x".repeat(2001));

		expect(field).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByText(/2001 \/ 2000 characters/)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: copy.actions.save }),
		).toBeDisabled();
	});

	it("prefills Edit answer and Answer again, and notes a bare earlier confirmation", async () => {
		serverSays(
			analysis({
				findings: [
					finding({
						title: "Answered once",
						state: "RESPONDED",
						response: response({ text: "First answer." }),
					}),
					finding({
						title: "Review confirmed",
						state: "NEEDS_REVIEW",
						reason: "RAISED_AGAIN",
						response: response({ kind: "CONFIRMED", text: null }),
					}),
				],
			}),
		);
		renderPanel();

		await screen.findByText("Answered once");
		await userEvent.click(
			within(item("Answered once")).getByRole("button", {
				name: copy.actions.editAnswer,
			}),
		);
		expect(
			within(item("Answered once")).getByLabelText(copy.editor.label),
		).toHaveValue("First answer.");

		await userEvent.click(
			within(item("Review confirmed")).getByRole("button", {
				name: copy.actions.answerAgain,
			}),
		);
		const review = within(item("Review confirmed"));
		expect(review.getByLabelText(copy.editor.label)).toHaveValue("");
		expect(
			review.getByText(copy.editor.previouslyConfirmed),
		).toBeInTheDocument();
	});

	it("keeps the draft when the analysis changed, and applies it to the current finding", async () => {
		serverSays(analysis({ findings: [open()] }));
		api.respondToFinding.mockResolvedValueOnce({
			outcome: "stale",
			reason: "RUN_CHANGED",
			current: null,
		});
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.answer,
			}),
		);
		await userEvent.type(
			screen.getByLabelText(copy.editor.label),
			"Kept draft",
		);
		// Meanwhile a newer run raised the same finding under a new id.
		serverSays(
			analysis({
				run: { id: "analysis-2" },
				findings: [
					finding({
						id: "f-9",
						stableKey: "key-1",
						title: "Open finding",
					}),
				],
			}),
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.save }),
		);

		expect(
			await screen.findByText(copy.conflict.runChanged),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(
				within(item("Open finding")).getByLabelText(copy.editor.label),
			).toHaveValue("Kept draft"),
		);

		api.respondToFinding.mockResolvedValueOnce({
			outcome: "written",
			stableKey: "key-1",
			answeredRunId: "analysis-2",
			response: savedAnswer({ text: "Kept draft" }),
		});
		await userEvent.click(
			await screen.findByRole("button", { name: copy.actions.apply }),
		);
		await waitFor(() =>
			expect(api.respondToFinding).toHaveBeenLastCalledWith(
				expect.objectContaining({
					runId: "analysis-2",
					findingId: "f-9",
					text: "Kept draft",
				}),
			),
		);
	});

	it("shows a colleague's answer beside the kept draft, and replaces it on request", async () => {
		serverSays(
			analysis({
				findings: [
					{
						...open(),
						state: "RESPONDED",
						response: response({ version: 2, text: "Old answer." }),
					},
				],
			}),
		);
		api.respondToFinding.mockResolvedValueOnce({
			outcome: "stale",
			reason: "VERSION_CHANGED",
			current: savedAnswer({
				id: "response-2",
				version: 3,
				text: "Their newer answer.",
				author: { id: "user-2", name: "Sam Example" },
			}),
		});
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.editAnswer,
			}),
		);
		const field = screen.getByLabelText(copy.editor.label);
		await userEvent.clear(field);
		await userEvent.type(field, "My answer.");
		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.save }),
		);

		expect(
			await screen.findByText("Sam Example saved an answer meanwhile:"),
		).toBeInTheDocument();
		expect(screen.getByText("Their newer answer.")).toBeInTheDocument();
		expect(screen.getByLabelText(copy.editor.yourDraft)).toHaveValue(
			"My answer.",
		);

		api.respondToFinding.mockResolvedValueOnce({
			outcome: "written",
			stableKey: "key-1",
			answeredRunId: RUN_ID,
			response: savedAnswer({ version: 4, text: "My answer." }),
		});
		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.replaceWithMine }),
		);
		expect(api.respondToFinding).toHaveBeenLastCalledWith(
			expect.objectContaining({
				kind: "RESPONDED",
				text: "My answer.",
				responseId: "response-2",
				version: 3,
			}),
		);
	});

	it("saves against the answer the draft was opened on, so a colleague's answer brought by a refetch is never replaced unseen", async () => {
		const answered = (
			version: number,
			text: string,
			author: { id: string; name: string },
		) =>
			analysis({
				findings: [
					{
						...open(),
						state: "RESPONDED",
						response: response({ version, text, author }),
					},
				],
			});
		serverSays(
			answered(2, "Old answer.", { id: "user-1", name: "Dana Example" }),
		);
		const theirs = savedAnswer({
			version: 3,
			text: "Their newer answer.",
			author: { id: "user-2", name: "Sam Example" },
		});
		// The server's compare-and-swap: only the answer it holds, by id and
		// version, is taken.
		api.respondToFinding.mockImplementation(
			async (input: {
				responseId?: string;
				version?: number;
				text?: string;
			}) =>
				input.responseId === theirs.id &&
				input.version === theirs.version
					? {
							outcome: "written",
							stableKey: "key-1",
							answeredRunId: RUN_ID,
							response: savedAnswer({
								version: 4,
								text: input.text ?? null,
							}),
						}
					: {
							outcome: "stale",
							reason: "VERSION_CHANGED",
							current: theirs,
						},
		);
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.editAnswer,
			}),
		);
		const field = screen.getByLabelText(copy.editor.label);
		await userEvent.clear(field);
		await userEvent.type(field, "My answer.");

		// A colleague saves while the draft is open; a refetch shows it.
		serverSays(
			answered(3, "Their newer answer.", {
				id: "user-2",
				name: "Sam Example",
			}),
		);
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(
				within(item("Open finding")).getByText(
					"Answered by Sam Example",
				),
			).toBeInTheDocument(),
		);

		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.save }),
		);
		expect(
			await screen.findByText("Sam Example saved an answer meanwhile:"),
		).toBeInTheDocument();
		expect(api.respondToFinding).toHaveBeenCalledTimes(1);
		expect(api.respondToFinding).toHaveBeenLastCalledWith(
			expect.objectContaining({
				text: "My answer.",
				responseId: "response-1",
				version: 2,
			}),
		);
		expect(screen.getByLabelText(copy.editor.yourDraft)).toHaveValue(
			"My answer.",
		);

		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.replaceWithMine }),
		);
		await waitFor(() =>
			expect(api.respondToFinding).toHaveBeenCalledTimes(2),
		);
		expect(api.respondToFinding).toHaveBeenLastCalledWith(
			expect.objectContaining({
				text: "My answer.",
				responseId: "response-1",
				version: 3,
			}),
		);
	});

	it("saves against the answer the draft was opened on, so one a colleague cleared and gave again at the same version is never replaced unseen", async () => {
		const answered = (
			id: string,
			text: string,
			author: { id: string; name: string },
		) =>
			analysis({
				findings: [
					{
						...open(),
						state: "RESPONDED",
						response: response({ id, version: 1, text, author }),
					},
				],
			});
		serverSays(
			answered("response-1", "Old answer.", {
				id: "user-1",
				name: "Dana Example",
			}),
		);
		// A new row, back at version 1: the version alone cannot tell it from
		// the answer the draft was opened on.
		const theirs = savedAnswer({
			id: "response-2",
			version: 1,
			text: "Their new answer.",
			author: { id: "user-2", name: "Sam Example" },
		});
		api.respondToFinding.mockImplementation(
			async (input: {
				responseId?: string;
				version?: number;
				text?: string;
			}) =>
				input.responseId === theirs.id &&
				input.version === theirs.version
					? {
							outcome: "written",
							stableKey: "key-1",
							answeredRunId: RUN_ID,
							response: savedAnswer({
								id: theirs.id,
								version: 2,
								text: input.text ?? null,
							}),
						}
					: {
							outcome: "stale",
							reason: "VERSION_CHANGED",
							current: theirs,
						},
		);
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.editAnswer,
			}),
		);
		const field = screen.getByLabelText(copy.editor.label);
		await userEvent.clear(field);
		await userEvent.type(field, "My answer.");

		// A colleague clears the answer and gives a new one while the draft
		// is open; a refetch shows it.
		serverSays(
			answered("response-2", "Their new answer.", {
				id: "user-2",
				name: "Sam Example",
			}),
		);
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(
				within(item("Open finding")).getByText(
					"Answered by Sam Example",
				),
			).toBeInTheDocument(),
		);

		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.save }),
		);
		expect(
			await screen.findByText("Sam Example saved an answer meanwhile:"),
		).toBeInTheDocument();
		expect(api.respondToFinding).toHaveBeenCalledTimes(1);
		expect(api.respondToFinding).toHaveBeenLastCalledWith(
			expect.objectContaining({
				text: "My answer.",
				responseId: "response-1",
				version: 1,
			}),
		);
		expect(screen.getByLabelText(copy.editor.yourDraft)).toHaveValue(
			"My answer.",
		);

		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.replaceWithMine }),
		);
		await waitFor(() =>
			expect(api.respondToFinding).toHaveBeenCalledTimes(2),
		);
		expect(api.respondToFinding).toHaveBeenLastCalledWith(
			expect.objectContaining({
				text: "My answer.",
				responseId: "response-2",
				version: 1,
			}),
		);
	});

	it("gives a first answer when a colleague cleared the one the draft was opened on", async () => {
		serverSays(
			analysis({
				findings: [
					{
						...open(),
						state: "RESPONDED",
						response: response({ version: 2, text: "Old answer." }),
					},
				],
			}),
		);
		api.respondToFinding.mockResolvedValueOnce({
			outcome: "stale",
			reason: "VERSION_CHANGED",
			current: null,
		});
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.editAnswer,
			}),
		);
		const field = screen.getByLabelText(copy.editor.label);
		await userEvent.clear(field);
		await userEvent.type(field, "My answer.");
		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.save }),
		);
		expect(
			await screen.findByText(copy.conflict.versionCleared),
		).toBeInTheDocument();

		api.respondToFinding.mockResolvedValueOnce({
			outcome: "written",
			stableKey: "key-1",
			answeredRunId: RUN_ID,
			response: savedAnswer({ id: "response-3", text: "My answer." }),
		});
		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.replaceWithMine }),
		);
		await waitFor(() =>
			expect(api.respondToFinding).toHaveBeenCalledTimes(2),
		);
		const [sent] = api.respondToFinding.mock.calls[1] ?? [];
		expect(sent).toMatchObject({ kind: "RESPONDED", text: "My answer." });
		expect(sent).not.toHaveProperty("responseId");
		expect(sent).not.toHaveProperty("version");
	});

	it("keeps a draft typed before a newer run that raises the same key", async () => {
		serverSays(analysis({ findings: [open()] }));
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.answer,
			}),
		);
		await userEvent.type(
			screen.getByLabelText(copy.editor.label),
			"Half-written",
		);

		serverSays(
			analysis({
				run: { id: "analysis-2" },
				findings: [
					finding({
						id: "f-7",
						stableKey: "key-1",
						title: "Open finding",
					}),
				],
			}),
		);
		await act(() => client.refetchQueries());

		await waitFor(() =>
			expect(
				within(item("Open finding")).getByLabelText(copy.editor.label),
			).toHaveValue("Half-written"),
		);
	});

	it("keeps a draft whose finding the newer run does not raise, listed apart", async () => {
		serverSays(analysis({ findings: [open()] }));
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.answer,
			}),
		);
		await userEvent.type(
			screen.getByLabelText(copy.editor.label),
			"Orphaned words",
		);

		serverSays(
			analysis({
				run: { id: "analysis-2" },
				findings: [finding({ stableKey: "key-other", title: "Other" })],
			}),
		);
		await act(() => client.refetchQueries());

		const unsaved = await screen.findByRole("region", {
			name: copy.orphan.title,
		});
		expect(
			within(unsaved).getByText("Written for: Open finding"),
		).toBeInTheDocument();
		expect(within(unsaved).getByText("Orphaned words")).toBeInTheDocument();

		await userEvent.click(
			within(unsaved).getByRole("button", { name: copy.orphan.discard }),
		);
		expect(
			screen.queryByRole("region", { name: copy.orphan.title }),
		).not.toBeInTheDocument();
	});

	it("clears an answer at once, naming the answer shown by id and version", async () => {
		serverSays(
			analysis({
				findings: [
					{
						...open(),
						state: "CONFIRMED",
						response: response({ kind: "CONFIRMED", version: 6 }),
					},
				],
			}),
		);
		const write = deferred<unknown>();
		api.clearFindingResponse.mockReturnValue(write.promise);
		const { container } = renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.clear,
			}),
		);
		await waitFor(() =>
			expect(
				within(item("Open finding")).getByText(copy.state.UNADDRESSED),
			).toBeInTheDocument(),
		);
		expect(api.clearFindingResponse).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			stableKey: "key-1",
			responseId: "response-1",
			version: 6,
		});

		await act(async () => {
			write.settle({ outcome: "cleared", stableKey: "key-1" });
		});
		await waitFor(() =>
			expect(liveRegion(container)).toHaveTextContent(
				copy.announce.cleared,
			),
		);
	});
});

describe("ProposalAnalysisPanel — focus after an action", () => {
	const open = () =>
		finding({ id: "f-1", stableKey: "key-1", title: "Open finding" });
	const confirmed = () =>
		analysis({
			findings: [
				{
					...open(),
					state: "CONFIRMED",
					response: response({
						kind: "CONFIRMED",
						text: null,
						version: 6,
					}),
				},
			],
		});
	const button = (name: string) =>
		within(item("Open finding")).getByRole("button", { name });

	it("moves focus to the next control once Confirm is saved, and a refetch never moves it", async () => {
		serverSays(analysis({ findings: [open()] }));
		const write = deferred<unknown>();
		api.respondToFinding.mockReturnValue(write.promise);
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(button(copy.actions.confirm));
		// The control used is gone while the write runs.
		expect(
			within(item("Open finding")).queryByRole("button", {
				name: copy.actions.confirm,
			}),
		).not.toBeInTheDocument();

		serverSays(confirmed());
		await act(async () => {
			write.settle({
				outcome: "written",
				stableKey: "key-1",
				answeredRunId: RUN_ID,
				response: savedAnswer({ kind: "CONFIRMED", text: null }),
			});
		});
		await waitFor(() => expect(button(copy.actions.answer)).toHaveFocus());

		// Focus the page dropped is left alone by a refetch that changes
		// the finding's controls.
		(document.activeElement as HTMLElement).blur();
		serverSays(analysis({ findings: [open()] }));
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(button(copy.actions.confirm)).toBeInTheDocument(),
		);
		expect(document.body).toHaveFocus();
	});

	it("leaves focus the member moved elsewhere while the write ran", async () => {
		serverSays(analysis({ findings: [open()] }));
		const write = deferred<unknown>();
		api.respondToFinding.mockReturnValue(write.promise);
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(button(copy.actions.confirm));
		const rerun = screen.getByRole("button", { name: copy.rerun.button });
		rerun.focus();

		serverSays(confirmed());
		await act(async () => {
			write.settle({
				outcome: "written",
				stableKey: "key-1",
				answeredRunId: RUN_ID,
				response: savedAnswer({ kind: "CONFIRMED", text: null }),
			});
		});
		await waitFor(() =>
			expect(button(copy.actions.answer)).not.toBeDisabled(),
		);
		expect(rerun).toHaveFocus();
	});

	it("moves focus to the next control once Clear is saved", async () => {
		serverSays(confirmed());
		api.clearFindingResponse.mockResolvedValue({
			outcome: "cleared",
			stableKey: "key-1",
		});
		renderPanel();

		await screen.findByText("Open finding");
		serverSays(analysis({ findings: [open()] }));
		await userEvent.click(button(copy.actions.clear));

		await waitFor(() => expect(button(copy.actions.confirm)).toHaveFocus());
	});

	it("moves focus to the finding's first control once an answer is saved", async () => {
		serverSays(analysis({ findings: [open()] }));
		const write = deferred<unknown>();
		api.respondToFinding.mockReturnValue(write.promise);
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(button(copy.actions.answer));
		await userEvent.type(
			screen.getByLabelText(copy.editor.label),
			"Phase 2 covers it.",
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.save }),
		);

		serverSays(
			analysis({
				findings: [
					{
						...open(),
						state: "RESPONDED",
						response: response({ text: "Phase 2 covers it." }),
					},
				],
			}),
		);
		await act(async () => {
			write.settle({
				outcome: "written",
				stableKey: "key-1",
				answeredRunId: RUN_ID,
				response: savedAnswer({ text: "Phase 2 covers it." }),
			});
		});
		await waitFor(() =>
			expect(button(copy.actions.editAnswer)).toHaveFocus(),
		);
	});

	it("moves focus to the finding's first control when the answer is cancelled", async () => {
		serverSays(analysis({ findings: [open()] }));
		renderPanel();

		await screen.findByText("Open finding");
		await userEvent.click(button(copy.actions.answer));
		await userEvent.type(
			screen.getByLabelText(copy.editor.label),
			"Not this.",
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.cancel }),
		);

		await waitFor(() => expect(button(copy.actions.confirm)).toHaveFocus());
		expect(
			screen.queryByLabelText(copy.editor.label),
		).not.toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — re-run", () => {
	const shown = () => analysis({ findings: [finding()] });

	it("says what a re-run checks and starts one", async () => {
		serverSays(shown());
		api.rerunAnalysis.mockResolvedValue({ runId: "analysis-2" });
		renderPanel();

		expect(await screen.findByText(copy.rerun.note)).toBeInTheDocument();
		const reads = api.getAnalysis.mock.calls.length;
		serverSays(analysis({ findings: [finding()], newerRun: newerRun() }));
		await userEvent.click(
			screen.getByRole("button", { name: copy.rerun.button }),
		);

		expect(api.rerunAnalysis).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
		});
		await waitFor(() =>
			expect(api.getAnalysis.mock.calls.length).toBeGreaterThan(reads),
		);
		expect(
			await screen.findByRole("button", { name: copy.rerun.running }),
		).toBeDisabled();
	});

	it("says a rate-limited refusal in its own words", async () => {
		serverSays(shown());
		api.rerunAnalysis.mockRejectedValue(
			orpcError("TOO_MANY_REQUESTS", "Too many", { retryAfter: 125 }),
		);
		renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: copy.rerun.button }),
		);
		expect(
			await screen.findByText(
				"Too many re-runs in this organization. Try again in 3 minutes.",
				{ selector: "p" },
			),
		).toBeInTheDocument();
	});

	it.each([
		["ANALYSIS_IN_PROGRESS", copy.rerun.conflictRunning],
		["DOCUMENT_GENERATING", copy.rerun.conflictGenerating],
	])("says CONFLICT %s in its own words", async (code, message) => {
		serverSays(shown());
		api.rerunAnalysis.mockRejectedValue(
			orpcError("CONFLICT", "Server words", { code }),
		);
		const { container } = renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: copy.rerun.button }),
		);
		expect(
			await screen.findByText(message, { selector: "p" }),
		).toBeInTheDocument();
		// Said once more, in the live region.
		expect(liveRegion(container)).toHaveTextContent(message);
		expect(container).not.toHaveTextContent(/Server words/);
	});

	it("says no analysis prompt is bound", async () => {
		serverSays(shown());
		api.rerunAnalysis.mockRejectedValue(
			orpcError("PRECONDITION_FAILED", "x", {
				code: "PROPOSAL_PROMPT_NOT_BOUND",
			}),
		);
		renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: copy.rerun.button }),
		);
		expect(
			await screen.findByText(copy.rerun.promptNotBound, {
				selector: "p",
			}),
		).toBeInTheDocument();
	});

	it("says any other failure generically", async () => {
		serverSays(shown());
		api.rerunAnalysis.mockRejectedValue(
			orpcError("INTERNAL_SERVER_ERROR", "Temporal down"),
		);
		const { container } = renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: copy.rerun.button }),
		);
		expect(
			await screen.findByText(copy.rerun.failed, { selector: "p" }),
		).toBeInTheDocument();
		expect(container).not.toHaveTextContent(/Temporal down/);
	});
});

describe("ProposalAnalysisPanel — evidence", () => {
	it("links a linkable context in a new tab, opens others in a popover, and marks removed sources", async () => {
		serverSays(
			analysis({
				findings: [
					finding({
						title: "Cited finding",
						evidence: [
							{
								source: 1,
								kind: "projectContext",
								contextType: "LINK",
								title: "Kickoff notes",
								excerpt: "The client wants SSO.",
								link: {
									contextId: "ctx-1",
									href: "/app/example-org/projects/project-1/contexts/ctx-1",
								},
							},
							{
								source: 2,
								kind: "company",
								title: "Rate card",
								excerpt: "Senior rate is fixed.",
							},
							{ source: 3, kind: "removed" },
						],
					}),
				],
			}),
		);
		const { container } = renderPanel();

		await screen.findByText("Cited finding");
		const cited = within(item("Cited finding"));

		const link = cited.getByRole("link", {
			name: `Kickoff notes ${copy.evidence.opensInNewTab}`,
		});
		expect(link).toHaveAttribute(
			"href",
			"/app/example-org/projects/project-1/contexts/ctx-1",
		);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		expect(link.querySelector("svg[aria-hidden='true']")).not.toBeNull();

		await userEvent.click(
			cited.getByRole("button", { name: "View source: Rate card" }),
		);
		const popover = await screen.findByRole("dialog");
		expect(
			within(popover).getByText("Senior rate is fixed."),
		).toBeInTheDocument();

		const removed = cited.getByText(copy.evidence.removed);
		expect(removed.closest("a, button")).toBeNull();
		// Source numbers never show.
		expect(container).not.toHaveTextContent(/\[S\d+\]/);
	});

	it("shows a source with no text to show as a plain chip, with nothing to open", async () => {
		serverSays(
			analysis({
				findings: [
					finding({
						title: "Cited finding",
						evidence: [
							{ source: 1, kind: "summary", title: null },
							{ source: 2, kind: "other", title: "Call notes" },
							{
								source: 3,
								kind: "company",
								title: "Rate card",
								excerpt: null,
							},
							{
								source: 4,
								kind: "projectContext",
								contextType: "FILE",
								title: "Brief",
								excerpt: null,
								link: null,
							},
						],
					}),
				],
			}),
		);
		renderPanel();

		await screen.findByText("Cited finding");
		const cited = within(item("Cited finding"));
		for (const label of [
			copy.evidence.kind.summary,
			"Call notes",
			"Rate card",
			"Brief",
		]) {
			expect(cited.getByText(label).closest("a, button")).toBeNull();
		}
		expect(cited.queryAllByRole("button", { name: /View source/ })).toEqual(
			[],
		);
	});
});

describe("ProposalAnalysisPanel — no longer raised", () => {
	it("lists answers to findings no longer raised, collapsed, with state and Clear", async () => {
		serverSays(
			analysis({
				findings: [finding()],
				noLongerRaised: [
					noLongerRaised({
						stableKey: "key-gone",
						findingTitle: "Dropped finding",
						state: "NEEDS_REVIEW",
						reason: "SECTION_NOT_FOUND",
						response: response({ version: 2, text: "We said so." }),
					}),
				],
			}),
		);
		api.clearFindingResponse.mockResolvedValue({
			outcome: "cleared",
			stableKey: "key-gone",
		});
		renderPanel();

		const toggle = await screen.findByRole("button", {
			name: "No longer raised (1)",
		});
		expect(screen.queryByText("Dropped finding")).not.toBeInTheDocument();
		await userEvent.click(toggle);

		const answer = item("Dropped finding");
		expect(
			within(answer).getByText(copy.state.NEEDS_REVIEW),
		).toBeInTheDocument();
		expect(
			within(answer).getByText(copy.reason.SECTION_NOT_FOUND),
		).toBeInTheDocument();
		expect(
			within(answer).getByText("Earlier answer by Dana Example"),
		).toBeInTheDocument();
		expect(within(answer).getByText("We said so.")).toBeInTheDocument();

		await userEvent.click(
			within(answer).getByRole("button", { name: copy.actions.clear }),
		);
		expect(api.clearFindingResponse).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			stableKey: "key-gone",
			responseId: "response-1",
			version: 2,
		});
	});

	it("says an answer whose author lost edit rights is not applied, and that only such answers and those needing review are held back", async () => {
		serverSays(
			analysis({
				findings: [finding()],
				noLongerRaised: [
					noLongerRaised({
						stableKey: "key-former",
						findingTitle: "Answered by a former editor",
						state: "RESPONDED",
						response: response({
							settledSkipReason: "AUTHOR_RIGHTS",
						}),
					}),
					noLongerRaised({
						stableKey: "key-review",
						findingTitle: "Answer needing review",
						state: "NEEDS_REVIEW",
						reason: "SECTION_NOT_FOUND",
						response: response({
							settledSkipReason: "NEEDS_REVIEW",
						}),
					}),
					noLongerRaised({
						stableKey: "key-applied",
						findingTitle: "Answer still applied",
						state: "CONFIRMED",
						response: response({ kind: "CONFIRMED", text: null }),
					}),
				],
			}),
		);
		renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: "No longer raised (3)" }),
		);
		expect(
			screen.getByText(copy.noLongerRaised.description),
		).toBeInTheDocument();
		expect(
			within(item("Answered by a former editor")).getByText(
				copy.authorRights,
			),
		).toBeInTheDocument();
		expect(
			within(item("Answer needing review")).queryByText(
				copy.authorRights,
			),
		).not.toBeInTheDocument();
		expect(
			within(item("Answer still applied")).queryByText(copy.authorRights),
		).not.toBeInTheDocument();
	});
});

describe("ProposalAnalysisPanel — focus after clearing an answer no longer raised", () => {
	const gone = (stableKey: string, findingTitle: string) =>
		noLongerRaised({
			stableKey,
			findingTitle,
			response: response({ id: `response-${stableKey}` }),
		});
	const clearOf = (title: string) =>
		within(item(title)).getByRole("button", { name: copy.actions.clear });

	it("moves focus to the Clear of the answer now in its place, or of the one before it when it was last", async () => {
		serverSays(
			analysis({
				findings: [finding()],
				noLongerRaised: [
					gone("key-a", "First dropped"),
					gone("key-b", "Second dropped"),
					gone("key-c", "Third dropped"),
				],
			}),
		);
		const first = deferred<unknown>();
		api.clearFindingResponse.mockReturnValueOnce(first.promise);
		renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: "No longer raised (3)" }),
		);
		await userEvent.click(clearOf("First dropped"));
		// The answer goes at once, and the focused Clear with it.
		await waitFor(() =>
			expect(screen.queryByText("First dropped")).not.toBeInTheDocument(),
		);
		expect(document.body).toHaveFocus();

		serverSays(
			analysis({
				findings: [finding()],
				noLongerRaised: [
					gone("key-b", "Second dropped"),
					gone("key-c", "Third dropped"),
				],
			}),
		);
		await act(async () => {
			first.settle({ outcome: "cleared", stableKey: "key-a" });
		});
		await waitFor(() => expect(clearOf("Second dropped")).toHaveFocus());

		api.clearFindingResponse.mockResolvedValueOnce({
			outcome: "cleared",
			stableKey: "key-c",
		});
		serverSays(
			analysis({
				findings: [finding()],
				noLongerRaised: [gone("key-b", "Second dropped")],
			}),
		);
		await userEvent.click(clearOf("Third dropped"));
		await waitFor(() =>
			expect(screen.queryByText("Third dropped")).not.toBeInTheDocument(),
		);
		await waitFor(() => expect(clearOf("Second dropped")).toHaveFocus());
		expect(api.clearFindingResponse).toHaveBeenLastCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			stableKey: "key-c",
			responseId: "response-key-c",
			version: 1,
		});
	});

	it("moves focus to the panel's heading once the last answer is cleared and the group is gone", async () => {
		serverSays(
			analysis({
				findings: [finding()],
				noLongerRaised: [gone("key-a", "Only dropped")],
			}),
		);
		api.clearFindingResponse.mockResolvedValue({
			outcome: "cleared",
			stableKey: "key-a",
		});
		const { container } = renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: "No longer raised (1)" }),
		);
		serverSays(analysis({ findings: [finding()] }));
		await userEvent.click(clearOf("Only dropped"));

		await waitFor(() =>
			expect(
				screen.getByRole("heading", { level: 2, name: copy.title }),
			).toHaveFocus(),
		);
		expect(
			screen.queryByRole("button", { name: /No longer raised/ }),
		).not.toBeInTheDocument();
		expect(liveRegion(container)).toHaveTextContent(copy.announce.cleared);
	});

	it("brings back a refused clear in the open group, with focus on its Clear and the reason beside it", async () => {
		serverSays(
			analysis({
				findings: [finding()],
				noLongerRaised: [gone("key-a", "Only dropped")],
			}),
		);
		const write = deferred<unknown>();
		api.clearFindingResponse.mockReturnValue(write.promise);
		renderPanel();

		await userEvent.click(
			await screen.findByRole("button", { name: "No longer raised (1)" }),
		);
		await userEvent.click(clearOf("Only dropped"));
		await waitFor(() =>
			expect(screen.queryByText("Only dropped")).not.toBeInTheDocument(),
		);

		await act(async () => {
			write.settle({
				outcome: "stale",
				reason: "VERSION_CHANGED",
				current: savedAnswer({ id: "response-key-a", version: 2 }),
			});
		});
		await waitFor(() => expect(clearOf("Only dropped")).toHaveFocus());
		expect(
			within(item("Only dropped")).getByText(copy.errors.clearStale),
		).toBeInTheDocument();
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

		serverSays(noAnalysis());
		await userEvent.click(screen.getByRole("button", { name: copy.retry }));
		expect(await screen.findByText(copy.notRun)).toBeInTheDocument();
		expect(api.getAnalysis.mock.calls.length).toBeGreaterThan(calls);
	});

	it("stops showing findings once a refetch is refused", async () => {
		serverSays(
			analysis({ findings: [finding({ title: "Internal note" })] }),
		);
		renderPanel();
		await screen.findByText("Internal note");

		api.getAnalysis.mockRejectedValue(orpcError("FORBIDDEN"));
		await act(() => client.refetchQueries());

		expect(await screen.findByText(copy.unavailable)).toBeInTheDocument();
		expect(screen.queryByText("Internal note")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: copy.rerun.button }),
		).not.toBeInTheDocument();
	});

	it("keeps the last answer through a fault on a refetch", async () => {
		serverSays(analysis({ findings: [finding({ title: "Still here" })] }));
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
	const rich = () =>
		analysis({
			isStale: true,
			run: { contextCount: 0 },
			findings: [
				finding({
					severity: "BLOCKING",
					title: "Open blocking",
					recommendation: "Do this.",
					sectionHeading: "Scope",
					evidence: [
						{
							source: 1,
							kind: "projectContext",
							contextType: "LINK",
							title: "Kickoff notes",
							excerpt: "Excerpt.",
							link: {
								contextId: "ctx-1",
								href: "/app/example-org/projects/project-1/contexts/ctx-1",
							},
						},
						{ source: 2, kind: "summary", title: null },
						{
							source: 4,
							kind: "company",
							title: "Rate card",
							excerpt: "Senior rate is fixed.",
						},
						{ source: 3, kind: "removed" },
					],
				}),
				finding({
					severity: "INFORMATIONAL",
					title: "Answered info",
					state: "RESPONDED",
					response: response(),
				}),
			],
			noLongerRaised: [noLongerRaised()],
		});

	it("has no axe violations with findings and actions, when a first run failed, and while regenerating", async () => {
		serverSays(rich());
		const complete = renderPanel();
		await screen.findByText(copy.stale);
		expect(await axe(complete.container)).toHaveNoViolations();
		complete.unmount();
		client.clear();

		serverSays(
			analysis({
				run: null,
				newerRun: newerRun({
					status: "FAILED",
					errorCode: "MODEL_ERROR",
				}),
			}),
		);
		const failed = renderPanel();
		await screen.findByText(copy.failed.MODEL_ERROR);
		expect(await axe(failed.container)).toHaveNoViolations();
		failed.unmount();
		client.clear();

		serverSays(analysis({ findings: [finding()] }));
		const regenerating = renderPanel({ isGenerating: true });
		await screen.findByText(copy.newRunAfterGeneration);
		await waitFor(async () =>
			expect(await axe(regenerating.container)).toHaveNoViolations(),
		);
	});

	it("has exactly one live region, polite", async () => {
		serverSays(
			analysis({
				...rich(),
				newerRun: newerRun({
					status: "FAILED",
					errorCode: "MODEL_ERROR",
				}),
			}),
		);
		const { container } = renderPanel();
		await screen.findByText(copy.newerFailedTitle);

		const live = container.querySelectorAll(
			"[aria-live], [role='status'], [role='alert'], [role='log'], output",
		);
		expect(live).toHaveLength(1);
		expect(live[0]).toHaveAttribute("aria-live", "polite");
	});

	it("reaches every action, chip and link with Tab", async () => {
		serverSays(rich());
		renderPanel();
		await screen.findByText("Open blocking");

		const reached: string[] = [];
		for (let step = 0; step < 20; step++) {
			await userEvent.tab();
			const active = document.activeElement as HTMLElement | null;
			if (!active || active === document.body) {
				break;
			}
			reached.push(active.textContent?.trim() ?? "");
		}

		for (const name of [
			copy.rerun.button,
			"Kickoff notes",
			"Rate card",
			copy.actions.confirm,
			copy.actions.answer,
			copy.actions.editAnswer,
			copy.actions.clear,
			"No longer raised (1)",
		]) {
			expect(reached.some((text) => text.startsWith(name))).toBe(true);
		}
	});

	it("announces when a newer run starts and when it fails", async () => {
		serverSays(analysis({ findings: [finding()] }));
		const { container } = renderPanel();
		await screen.findByText(copy.rerun.note);

		serverSays(analysis({ findings: [finding()], newerRun: newerRun() }));
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(liveRegion(container)).toHaveTextContent(
				copy.announce.runStarted,
			),
		);

		serverSays(
			analysis({
				findings: [finding()],
				newerRun: newerRun({
					status: "FAILED",
					errorCode: "MODEL_ERROR",
				}),
			}),
		);
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(liveRegion(container)).toHaveTextContent(
				copy.announce.runFailed,
			),
		);
	});
});

describe("ProposalAnalysisPanel — report", () => {
	const reportCopy = copy.report;
	const CONTEXT_HREF = "/app/example-org/projects/project-1/contexts/ctx-1";
	const citations = [
		{
			source: 2,
			evidence: {
				source: 2,
				kind: "projectContext" as const,
				contextType: "LINK",
				title: "Kickoff notes",
				excerpt: "The client wants SSO.",
				link: { contextId: "ctx-1", href: CONTEXT_HREF },
			},
		},
		{
			source: 3,
			evidence: {
				source: 3,
				kind: "company" as const,
				title: "Rate card",
				excerpt: "Senior rate is fixed.",
			},
		},
	];
	const cited = (overrides: Parameters<typeof report>[0] = {}) =>
		report({
			text: "## Detail\n\nThe client wants SSO [S2]. Rates are fixed [S3].",
			citations,
			...overrides,
		});

	function panel({ isGenerating = false } = {}) {
		return (
			<QueryClientProvider client={client}>
				<ProposalAnalysisPanel
					projectId={PROJECT_ID}
					documentId={DOCUMENT_ID}
					isGenerating={isGenerating}
				/>
			</QueryClientProvider>
		);
	}

	const reportRegion = () =>
		screen.getByRole("region", { name: reportCopy.title });
	const fullReport = () =>
		screen.getByRole("button", { name: reportCopy.fullReport });
	const linkChip = () =>
		screen.getByRole("link", {
			name: `S2: Kickoff notes ${copy.evidence.opensInNewTab}`,
		});

	/** `a` comes before `b` in the document. */
	const precedes = (a: Node, b: Node) =>
		Boolean(
			a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
		);

	it("shows the run's report after unsaved answers and above the findings", async () => {
		const open = finding({ stableKey: "key-1", title: "Open finding" });
		serverSays(analysis({ findings: [open] }));
		renderPanel();
		await screen.findByText("Open finding");
		expect(
			screen.queryByRole("region", { name: reportCopy.title }),
		).not.toBeInTheDocument();

		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.answer,
			}),
		);
		await userEvent.type(
			screen.getByLabelText(copy.editor.label),
			"Unsaved words",
		);
		serverSays(
			analysis({
				run: { id: "analysis-2" },
				findings: [
					finding({ stableKey: "key-2", title: "New finding" }),
				],
				report: cited(),
			}),
		);
		await act(() => client.refetchQueries());

		const region = await screen.findByRole("region", {
			name: reportCopy.title,
		});
		const unsaved = screen.getByRole("region", { name: copy.orphan.title });
		const summary = screen.getByText(
			"1 of 1 needs a decision",
		) as HTMLElement;
		expect(precedes(unsaved, region)).toBe(true);
		expect(precedes(region, summary)).toBe(true);
		expect(precedes(region, screen.getByText("New finding"))).toBe(true);
		expect(
			within(region).getByText("Ready to send after two fixes"),
		).toBeInTheDocument();
		expect(fullReport()).toHaveAttribute("aria-expanded", "false");
	});

	it("shows the report with zero findings, and the empty-findings copy", async () => {
		serverSays(analysis({ findings: [], report: report() }));
		renderPanel();

		expect(
			await screen.findByRole("region", { name: reportCopy.title }),
		).toBeInTheDocument();
		expect(screen.getByText(copy.empty)).toBeInTheDocument();
	});

	it("puts the stale and failed-newer banners above the report, saying the analysis below stays", async () => {
		expect(copy.newerFailedKept).toMatch(/analysis below/);
		expect(copy.newerRunning).toMatch(/analysis below/);
		expect(copy.newerRerunRunning).toMatch(/analysis below/);

		serverSays(
			analysis({
				isStale: true,
				report: report(),
				findings: [finding()],
				newerRun: newerRun({
					status: "FAILED",
					errorCode: "MODEL_ERROR",
				}),
			}),
		);
		const failed = renderPanel();
		const kept = await screen.findByText(copy.newerFailedKept);
		expect(precedes(screen.getByText(copy.stale), reportRegion())).toBe(
			true,
		);
		expect(precedes(kept, reportRegion())).toBe(true);
		failed.unmount();
		client.clear();

		serverSays(
			analysis({
				report: report(),
				findings: [finding()],
				newerRun: newerRun({ kind: "RERUN", status: "RUNNING" }),
			}),
		);
		renderPanel();
		const running = await screen.findByText(copy.newerRerunRunning);
		expect(precedes(running, reportRegion())).toBe(true);
	});

	it("keeps the full report open through a poll and the greyed state, and closes it for a newer run", async () => {
		serverSays(
			analysis({
				isStale: true,
				findings: [finding()],
				report: cited(),
			}),
		);
		const view = render(panel());
		await userEvent.click(
			await screen.findByRole("button", { name: reportCopy.fullReport }),
		);
		expect(screen.getByText(/The client wants SSO/)).toBeInTheDocument();

		await act(() => client.refetchQueries());
		expect(fullReport()).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText(/The client wants SSO/)).toBeInTheDocument();

		// A generation starts: the same run, greyed and remounted.
		view.rerender(panel({ isGenerating: true }));
		expect(
			await screen.findByText(copy.newRunAfterGeneration),
		).toBeInTheDocument();
		expect(reportRegion().closest(".opacity-60")).not.toBeNull();
		expect(fullReport()).toHaveAttribute("aria-expanded", "true");

		view.rerender(panel());
		await waitFor(() =>
			expect(reportRegion().closest(".opacity-60")).toBeNull(),
		);
		expect(fullReport()).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText(/The client wants SSO/)).toBeInTheDocument();

		serverSays(
			analysis({
				run: { id: "analysis-2" },
				findings: [finding()],
				report: cited({ text: "The newer text." }),
			}),
		);
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(fullReport()).toHaveAttribute("aria-expanded", "false"),
		);
		expect(screen.queryByText("The newer text.")).not.toBeInTheDocument();
	});

	it("returns focus to Full report after the member's own re-run, when focus was in the report", async () => {
		serverSays(analysis({ findings: [finding()], report: cited() }));
		api.rerunAnalysis.mockResolvedValue({ runId: "analysis-2" });
		renderPanel();
		await userEvent.click(
			await screen.findByRole("button", { name: reportCopy.fullReport }),
		);

		serverSays(
			analysis({
				findings: [finding()],
				report: cited(),
				newerRun: newerRun(),
			}),
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.rerun.button }),
		);
		await screen.findByRole("button", { name: copy.rerun.running });
		linkChip().focus();
		expect(linkChip()).toHaveFocus();

		serverSays(
			analysis({
				run: { id: "analysis-2" },
				findings: [finding()],
				report: cited({ text: "The newer text [S2]." }),
			}),
		);
		await act(() => client.refetchQueries());

		await waitFor(() => expect(fullReport()).toHaveFocus());
		expect(fullReport()).toHaveAttribute("aria-expanded", "false");
	});

	it("falls back to the report's heading, then the panel's, when the re-run leaves no Full report", async () => {
		serverSays(analysis({ findings: [finding()], report: cited() }));
		api.rerunAnalysis.mockResolvedValue({ runId: "analysis-2" });
		renderPanel();
		await userEvent.click(
			await screen.findByRole("button", { name: reportCopy.fullReport }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.rerun.button }),
		);
		await waitFor(() => expect(api.rerunAnalysis).toHaveBeenCalled());
		linkChip().focus();

		serverSays(
			analysis({
				run: { id: "analysis-2" },
				findings: [finding()],
				report: report({ text: null }),
			}),
		);
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(
				screen.getByRole("heading", {
					level: 3,
					name: reportCopy.title,
				}),
			).toHaveFocus(),
		);

		api.rerunAnalysis.mockResolvedValue({ runId: "analysis-3" });
		await userEvent.click(
			screen.getByRole("button", { name: copy.rerun.button }),
		);
		await waitFor(() => expect(api.rerunAnalysis).toHaveBeenCalledTimes(2));
		screen
			.getByRole("heading", { level: 3, name: reportCopy.title })
			.focus();

		serverSays(
			analysis({
				run: { id: "analysis-3" },
				findings: [finding()],
				report: null,
			}),
		);
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(
				screen.getByRole("heading", { level: 2, name: copy.title }),
			).toHaveFocus(),
		);
		expect(
			screen.queryByRole("region", { name: reportCopy.title }),
		).not.toBeInTheDocument();
	});

	it("moves no focus when a poll brings a newer run, or a run other than the member's re-run", async () => {
		serverSays(analysis({ findings: [finding()], report: cited() }));
		renderPanel();
		await userEvent.click(
			await screen.findByRole("button", { name: reportCopy.fullReport }),
		);
		linkChip().focus();

		serverSays(
			analysis({
				run: { id: "analysis-2" },
				findings: [finding()],
				report: cited(),
			}),
		);
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(fullReport()).toHaveAttribute("aria-expanded", "false"),
		);
		expect(document.body).toHaveFocus();

		// The member's re-run started analysis-3; a generation's analysis-4
		// is what arrives.
		api.rerunAnalysis.mockResolvedValue({ runId: "analysis-3" });
		await userEvent.click(fullReport());
		await userEvent.click(
			screen.getByRole("button", { name: copy.rerun.button }),
		);
		await waitFor(() => expect(api.rerunAnalysis).toHaveBeenCalled());
		linkChip().focus();
		serverSays(
			analysis({
				run: { id: "analysis-4" },
				findings: [finding()],
				report: cited(),
			}),
		);
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(fullReport()).toHaveAttribute("aria-expanded", "false"),
		);
		expect(document.body).toHaveFocus();
	});

	it("keeps an open source popover open and focused through an identical poll", async () => {
		serverSays(analysis({ findings: [finding()], report: cited() }));
		renderPanel();
		await userEvent.click(
			await screen.findByRole("button", { name: reportCopy.fullReport }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "S3: Rate card" }),
		);
		const popover = await screen.findByRole("dialog");
		await waitFor(() =>
			expect(popover.contains(document.activeElement)).toBe(true),
		);

		await act(() => client.refetchQueries());
		expect(screen.getByRole("dialog")).toBe(popover);
		expect(popover.contains(document.activeElement)).toBe(true);
	});

	it("keeps the report readable while greyed: Full report and chips work, and no answer action shows", async () => {
		serverSays(
			analysis({ isStale: true, findings: [finding()], report: cited() }),
		);
		renderPanel({ isGenerating: true });
		await screen.findByText(copy.newRunAfterGeneration);
		expect(reportRegion().closest(".opacity-60")).not.toBeNull();
		expect(
			screen.queryByRole("button", { name: copy.actions.confirm }),
		).not.toBeInTheDocument();

		await userEvent.click(fullReport());
		expect(linkChip()).toHaveAttribute("href", CONTEXT_HREF);
		await userEvent.click(
			screen.getByRole("button", { name: "S3: Rate card" }),
		);
		expect(
			within(await screen.findByRole("dialog")).getByText(
				"Senior rate is fixed.",
			),
		).toBeInTheDocument();
	});

	it("keeps the report on screen through an optimistic answer, and typing does not parse it again", async () => {
		const open = finding({ stableKey: "key-1", title: "Open finding" });
		serverSays(analysis({ findings: [open], report: cited() }));
		const write = deferred<unknown>();
		api.respondToFinding.mockReturnValue(write.promise);
		renderPanel();
		await userEvent.click(
			await screen.findByRole("button", { name: reportCopy.fullReport }),
		);
		expect(remarkReportCitations).toHaveBeenCalledTimes(1);

		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.answer,
			}),
		);
		await userEvent.type(
			screen.getByLabelText(copy.editor.label),
			"Phase 2 covers it.",
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.actions.save }),
		);
		await waitFor(() =>
			expect(
				within(item("Open finding")).getByText(copy.state.RESPONDED),
			).toBeInTheDocument(),
		);
		expect(linkChip()).toBeInTheDocument();
		expect(fullReport()).toHaveAttribute("aria-expanded", "true");
		expect(remarkReportCitations).toHaveBeenCalledTimes(1);

		serverSays(
			analysis({
				findings: [
					{
						...open,
						state: "RESPONDED",
						response: response({ text: "Phase 2 covers it." }),
					},
				],
				report: cited(),
			}),
		);
		await act(async () => {
			write.settle({
				outcome: "written",
				stableKey: "key-1",
				answeredRunId: RUN_ID,
				response: savedAnswer({ text: "Phase 2 covers it." }),
			});
		});
		await waitFor(() =>
			expect(
				screen.queryByLabelText(copy.editor.label),
			).not.toBeInTheDocument(),
		);
		expect(linkChip()).toBeInTheDocument();
		expect(remarkReportCitations).toHaveBeenCalledTimes(1);
	});

	it("shows the text as plain text when its rendering throws, and the findings stay usable", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		parse.fail = true;
		const open = finding({ stableKey: "key-1", title: "Open finding" });
		serverSays(analysis({ findings: [open], report: cited() }));
		api.respondToFinding.mockResolvedValue({
			outcome: "written",
			stableKey: "key-1",
			answeredRunId: RUN_ID,
			response: savedAnswer({ kind: "CONFIRMED", text: null }),
		});
		renderPanel();
		await userEvent.click(
			await screen.findByRole("button", { name: reportCopy.fullReport }),
		);

		expect(
			await screen.findByText(reportCopy.plainTextNote),
		).toBeInTheDocument();
		expect(screen.getByText(/The client wants SSO \[S2\]/)).toHaveClass(
			"whitespace-pre-wrap",
		);
		await userEvent.click(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.confirm,
			}),
		);
		expect(api.respondToFinding).toHaveBeenCalledWith(
			expect.objectContaining({ findingId: open.id, kind: "CONFIRMED" }),
		);
		vi.mocked(console.error).mockRestore();
	});

	it("has no axe violations with the full report open, one live region, and every control reachable by Tab", async () => {
		serverSays(
			analysis({
				findings: [finding({ title: "Open finding" })],
				report: cited({
					beforeSending: ["Confirm the hosting region"],
					textTruncated: true,
					text: [
						"# Detail",
						"",
						"The client wants SSO [S2].",
						"",
						"| Item | Source |",
						"| --- | --- |",
						"| Rates | [S3] |",
						"",
						"```",
						"code",
						"```",
					].join("\n"),
				}),
			}),
		);
		const { container } = renderPanel();
		await userEvent.click(
			await screen.findByRole("button", {
				name: `${reportCopy.fullReport} ${reportCopy.shortened}`,
			}),
		);
		expect(linkChip()).toBeInTheDocument();

		expect(await axe(container)).toHaveNoViolations();
		const live = container.querySelectorAll(
			"[aria-live], [role='status'], [role='alert'], [role='log'], output",
		);
		expect(live).toHaveLength(1);
		expect(live[0]).toHaveAttribute("aria-live", "polite");

		(document.activeElement as HTMLElement | null)?.blur();
		const reached: HTMLElement[] = [];
		for (let step = 0; step < 20; step++) {
			await userEvent.tab();
			const active = document.activeElement as HTMLElement | null;
			if (!active || active === document.body) {
				break;
			}
			reached.push(active);
		}
		expect(reached).toContain(
			screen.getByRole("button", {
				name: `${reportCopy.fullReport} ${reportCopy.shortened}`,
			}),
		);
		expect(reached).toContain(linkChip());
		expect(reached).toContain(
			screen.getByRole("button", { name: "S3: Rate card" }),
		);
		expect(reached).toContain(
			within(item("Open finding")).getByRole("button", {
				name: copy.actions.confirm,
			}),
		);
	});
});
