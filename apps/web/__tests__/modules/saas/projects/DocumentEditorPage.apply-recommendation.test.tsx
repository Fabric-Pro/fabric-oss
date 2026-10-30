/**
 * Apply recommendation on a client-document Proposal's page (Fizzy #2946).
 *
 * Pinned here:
 *
 * - the hand-off between the tabs: Apply on the Analysis tab switches to Main
 *   and hands the editor the request (its id, the shown run and the finding);
 *   the panel hears which finding's revision is under way;
 * - the return: when the editor settles that request the page goes back to
 *   Analysis and to the finding; an accept refetches the analysis, a reject
 *   or a refusal says why and leaves the analysis as it was; an outcome for
 *   any other request is ignored;
 * - a member who left Main while the revision drafted is brought back to it
 *   once its review is shown, and one who is elsewhere when it settles stays
 *   on that tab;
 * - whether a finding can be applied stays the server's answer, so after one
 *   finding is applied another the server still lets apply keeps Apply and
 *   starts a new request;
 * - the chat's runtime URL names the document beside the organization, so
 *   the route can resolve what the chat may do on it, and a story names none;
 * - the Living Docs auto-refresh toggle is not offered on a client-document
 *   Proposal, to members or guests, and stays where the gate is off or the
 *   document is not a Proposal.
 *
 * `@tanstack/react-query` and `next-intl` (the real en.json) are real. The
 * editor, the analysis panel, the chat provider and the toggle are stand-ins
 * that show what the page hands them; the real panel's Apply is pinned in
 * `ProposalAnalysisPanel.apply.test.tsx`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RevisionRequest = { id: string; runId: string; findingId: string };
type RevisionOutcome = {
	id: string;
	result: "accepted" | "rejected" | "refused" | "failed";
	code?: string;
};

const fixtures = vi.hoisted(() => ({
	document: {} as Record<string, unknown>,
	analysis: null as unknown,
	flags: { PROPOSAL_ARTIFACT: true } as Record<string, boolean>,
	isGuest: false,
	editor: {
		lastProps: {} as {
			sectionRevisionRequest?: RevisionRequest | null;
			onSectionRevisionSettled?: (outcome: RevisionOutcome) => void;
			onSectionRevisionShown?: (id: string) => void;
		},
	},
	panel: {
		lastProps: {} as { pendingRevisionFindingId?: string | null },
	},
	runtimeUrl: null as string | null,
	api: {
		getDocument: vi.fn(),
		getAnalysis: vi.fn(),
		getThemeTokens: vi.fn(),
		getGlossy: vi.fn(),
	},
}));

vi.mock("sonner", async (importOriginal) => ({
	...(await importOriginal<typeof import("sonner")>()),
	toast: {
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
		dismiss: vi.fn(),
	},
}));

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

vi.mock("@shared/lib/orpc-query-utils", () => {
	const documentKey = (opts: { input: unknown }) => [
		"projects.documents.get",
		opts.input,
	];
	return {
		orpc: {
			projects: {
				get: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["projects.get", opts.input],
						queryFn: async () => ({
							project: {
								id: "proj-1",
								name: "Example project",
								organizationId: "org-1",
								userRole: "editor",
								canUpdateProject: true,
							},
						}),
					}),
				},
				documents: {
					get: {
						queryKey: documentKey,
						queryOptions: (opts: { input: unknown }) => ({
							queryKey: documentKey(opts),
							queryFn: async () => fixtures.api.getDocument(),
						}),
					},
					generate: {
						mutationOptions: (config: Record<string, unknown>) => ({
							mutationFn: async () => ({ outcome: "started" }),
							...config,
						}),
					},
					update: {
						mutationKey: () => [
							["projects", "documents", "update"],
							{ type: "mutation" },
						],
					},
				},
			},
		},
	};
});

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				getAnalysis: (input: unknown) =>
					fixtures.api.getAnalysis(input),
				getThemeTokens: (input: unknown) =>
					fixtures.api.getThemeTokens(input),
			},
			glossy: {
				get: (input: unknown) => fixtures.api.getGlossy(input),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/example-org",
		isLoading: false,
	}),
}));
vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => fixtures.isGuest,
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => fixtures.flags[key] ?? false,
}));
vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ setIsFullscreen: vi.fn() }),
}));
vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => vi.fn(),
}));
vi.mock("@saas/shared/components/copilot/ai-sidebar-layout", () => ({
	AI_SIDEBAR_CONTENT_SHIFT_CLASS: "ai-sidebar-shift",
	useAiSidebarExpanded: () => false,
}));
vi.mock("@saas/shared/components/copilot/CopilotChatSessionProvider", () => ({
	CopilotChatSessionProvider: ({ children }: { children: ReactNode }) => (
		<>{children}</>
	),
}));
vi.mock("@saas/projects/hooks", () => ({
	useProjectPresence: () => ({ activeUsers: [], isConnected: false }),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@saas/subscriptions/components/SubscribeToggle", () => ({
	SubscribeToggle: () => null,
}));
vi.mock("@saas/projects/components/DocumentAutoRefreshToggle", () => ({
	DocumentAutoRefreshToggle: () => (
		<button type="button">Auto-refresh toggle</button>
	),
}));
vi.mock("@saas/projects/components/DocumentTitleInlineEdit", () => ({
	DocumentTitleInlineEdit: () => null,
}));
vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({
		children,
		runtimeUrl,
	}: {
		children: ReactNode;
		runtimeUrl: string;
	}) => {
		fixtures.runtimeUrl = runtimeUrl;
		return <>{children}</>;
	},
}));
vi.mock(
	"@saas/projects/components/proposal-artifact/ProposalStylePanel",
	() => ({ ProposalStylePanel: () => null }),
);

/**
 * The panel stand-in reads the analysis through the page's own query and
 * offers Apply where the server says a finding can be applied, as the real
 * panel does, with each finding where the page looks for it on return.
 */
vi.mock(
	"@saas/projects/components/proposal-artifact/ProposalAnalysisPanel",
	async () => {
		const { useProposalAnalysis } = await import(
			"@saas/projects/components/proposal-artifact/use-proposal-analysis"
		);
		function ProposalAnalysisPanelStandIn(props: {
			projectId: string;
			documentId: string;
			onApplyRecommendation?: (finding: {
				id: string;
				runId: string;
				stableKey: string;
			}) => void;
			pendingRevisionFindingId?: string | null;
		}) {
			fixtures.panel.lastProps = props;
			const { data } = useProposalAnalysis({
				projectId: props.projectId,
				documentId: props.documentId,
				enabled: true,
			});
			return (
				<ul aria-label="Findings">
					{(data?.findings ?? []).map((finding) => (
						<li
							key={finding.id}
							tabIndex={-1}
							data-finding-id={finding.id}
						>
							<span>{finding.title}</span>
							<span>{finding.state}</span>
							{finding.canApply ? (
								<button
									type="button"
									disabled={!!props.pendingRevisionFindingId}
									onClick={() =>
										props.onApplyRecommendation?.({
											id: finding.id,
											runId: data?.run?.id ?? "",
											stableKey: finding.stableKey ?? "",
										})
									}
								>
									Apply {finding.title}
								</button>
							) : null}
						</li>
					))}
				</ul>
			);
		}
		return { ProposalAnalysisPanel: ProposalAnalysisPanelStandIn };
	},
);

/** The editor stand-in: shows the request it holds and settles it. */
vi.mock("@saas/projects/components/DocumentEditor", () => {
	function DocumentEditorStandIn(props: {
		sectionRevisionRequest?: RevisionRequest | null;
		onSectionRevisionSettled?: (outcome: RevisionOutcome) => void;
		onSectionRevisionShown?: (id: string) => void;
	}) {
		fixtures.editor.lastProps = props;
		return (
			<div data-testid="editor-stand-in">
				<button type="button">Regenerate</button>
			</div>
		);
	}
	return {
		DocumentEditor: DocumentEditorStandIn,
		getDocumentTypeLabel: (type: string) => type,
	};
});

import messages from "@repo/i18n/translations/en.json";
import { SessionContext } from "@saas/auth/lib/session-context";
import { DocumentEditorPage } from "@saas/projects/components/DocumentEditorPage";

const analysisCopy = messages.projects.proposalArtifact.analysis;
const reasons = messages.projects.proposalArtifact.revision.reasons;
const tabs = messages.projects.proposalArtifactPage.tabs;

function proposal(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc-1",
		title: "Example proposal",
		type: "PROPOSAL",
		status: "COMPLETE",
		content: "## Scope\n\nThe saved body.\n\n## Pricing\n\nThe terms.",
		liveContent: null,
		liveRunId: null,
		version: 2,
		generationProgress: 100,
		generationError: null,
		generationStartedAt: null,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function finding(
	id: string,
	title: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		position: 0,
		severity: "IMPORTANT",
		type: "SCOPE",
		title,
		detail: "Detail.",
		recommendation: "Do the thing.",
		sectionHeading: title,
		stableKey: `key-${id}`,
		keyed: true,
		foldedTitles: [],
		state: "UNADDRESSED",
		reason: null,
		response: null,
		evidence: [],
		canApply: true,
		...overrides,
	};
}

function analysis(findings: unknown[]) {
	return {
		run: { id: "analysis-1", kind: "GENERATION", status: "COMPLETE" },
		isStale: false,
		newerRun: null,
		findings,
		noLongerRaised: [],
		report: null,
		viewer: { canRespond: true },
	};
}

const twoFindings = () =>
	analysis([
		finding("f-scope", "Scope gap"),
		finding("f-pricing", "Pricing gap"),
	]);

let client: QueryClient;
let scrolledTo: Element[];

function renderPage(
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY" = "PROJECT_DOCUMENT",
) {
	return render(
		<SessionContext.Provider
			value={{
				session: null,
				user: { id: "user-1" } as never,
				loaded: true,
				reloadSession: async () => {},
			}}
		>
			<QueryClientProvider client={client}>
				<DocumentEditorPage
					projectId="proj-1"
					documentId="doc-1"
					organizationSlug="example-org"
					documentRefKind={documentRefKind}
				/>
			</QueryClientProvider>
		</SessionContext.Provider>,
	);
}

async function pageReady() {
	await screen.findByRole("button", { name: "Regenerate", hidden: true });
}

function tab(name: string) {
	return screen.getByRole("tab", { name: new RegExp(name) });
}

/** Opens the Analysis tab and applies the named finding's recommendation. */
async function applyFrom(title: string) {
	const user = userEvent.setup();
	await user.click(tab(tabs.analysis));
	await user.click(
		await screen.findByRole("button", { name: `Apply ${title}` }),
	);
}

function settle(outcome: Omit<RevisionOutcome, "id"> & { id?: string }) {
	const request = fixtures.editor.lastProps.sectionRevisionRequest;
	act(() => {
		fixtures.editor.lastProps.onSectionRevisionSettled?.({
			id: request?.id ?? "",
			...outcome,
		});
	});
}

function findingItem(title: string): HTMLElement {
	return screen
		.getByText(title, { ignore: "script" })
		.closest("li") as HTMLElement;
}

beforeEach(() => {
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			mutations: { retry: false },
		},
	});
	fixtures.document = proposal();
	fixtures.analysis = twoFindings();
	fixtures.flags = { PROPOSAL_ARTIFACT: true };
	fixtures.isGuest = false;
	fixtures.editor = { lastProps: {} };
	fixtures.panel = { lastProps: {} };
	fixtures.runtimeUrl = null;
	fixtures.api.getDocument.mockReset();
	fixtures.api.getDocument.mockImplementation(async () => ({
		document: fixtures.document,
	}));
	fixtures.api.getAnalysis.mockReset();
	fixtures.api.getAnalysis.mockImplementation(async () => fixtures.analysis);
	fixtures.api.getThemeTokens.mockReset();
	fixtures.api.getThemeTokens.mockResolvedValue({ tokens: null });
	fixtures.api.getGlossy.mockReset();
	fixtures.api.getGlossy.mockResolvedValue({ edition: null });
	scrolledTo = [];
	Element.prototype.scrollIntoView = function scrollIntoView() {
		scrolledTo.push(this);
	};
});

afterEach(() => {
	cleanup();
	client.clear();
	Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("DocumentEditorPage — Apply recommendation", () => {
	it("switches to Main and hands the editor the request, and tells the panel which finding is under way", async () => {
		renderPage();
		await pageReady();
		expect(fixtures.editor.lastProps.sectionRevisionRequest).toBeNull();

		await applyFrom("Scope gap");

		expect(tab(tabs.main)).toHaveAttribute("aria-selected", "true");
		const request = fixtures.editor.lastProps.sectionRevisionRequest;
		expect(request).toEqual({
			id: expect.any(String),
			runId: "analysis-1",
			findingId: "f-scope",
		});
		expect(fixtures.panel.lastProps.pendingRevisionFindingId).toBe(
			"f-scope",
		);
	});

	it("returns to the finding on Analysis after an accept and refetches the analysis", async () => {
		renderPage();
		await pageReady();
		await applyFrom("Scope gap");
		const reads = fixtures.api.getAnalysis.mock.calls.length;
		fixtures.analysis = analysis([
			finding("f-scope", "Scope gap", {
				state: "RESOLVED",
				canApply: false,
			}),
			finding("f-pricing", "Pricing gap"),
		]);

		settle({ result: "accepted" });

		expect(tab(tabs.analysis)).toHaveAttribute("aria-selected", "true");
		expect(fixtures.editor.lastProps.sectionRevisionRequest).toBeNull();
		expect(fixtures.panel.lastProps.pendingRevisionFindingId).toBeNull();
		await waitFor(() =>
			expect(fixtures.api.getAnalysis.mock.calls.length).toBeGreaterThan(
				reads,
			),
		);
		const scope = findingItem("Scope gap");
		expect(await within(scope).findByText("RESOLVED")).toBeInTheDocument();
		expect(scrolledTo).toContain(scope);
		expect(scope).toHaveFocus();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("keeps another finding the server still lets apply applicable after an accept, with a new request", async () => {
		renderPage();
		await pageReady();
		await applyFrom("Scope gap");
		const first = fixtures.editor.lastProps.sectionRevisionRequest;
		fixtures.analysis = analysis([
			finding("f-scope", "Scope gap", {
				state: "RESOLVED",
				canApply: false,
			}),
			finding("f-pricing", "Pricing gap"),
		]);
		settle({ result: "accepted" });
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "Apply Scope gap" }),
			).not.toBeInTheDocument(),
		);

		await userEvent.click(
			screen.getByRole("button", { name: "Apply Pricing gap" }),
		);

		const second = fixtures.editor.lastProps.sectionRevisionRequest;
		expect(second).toMatchObject({ findingId: "f-pricing" });
		expect(second?.id).not.toBe(first?.id);
		expect(tab(tabs.main)).toHaveAttribute("aria-selected", "true");
	});

	it("says a rejected revision changed nothing and reads the analysis no more", async () => {
		renderPage();
		await pageReady();
		await applyFrom("Scope gap");
		const reads = fixtures.api.getAnalysis.mock.calls.length;

		settle({ result: "rejected" });

		expect(tab(tabs.analysis)).toHaveAttribute("aria-selected", "true");
		expect(screen.getByRole("status")).toHaveTextContent(
			analysisCopy.revisionRejected,
		);
		expect(fixtures.panel.lastProps.pendingRevisionFindingId).toBeNull();
		expect(fixtures.api.getAnalysis.mock.calls.length).toBe(reads);
		expect(
			within(findingItem("Scope gap")).getByText("UNADDRESSED"),
		).toBeInTheDocument();
		expect(scrolledTo).toContain(findingItem("Scope gap"));
	});

	it.each([
		["refused", "RESPONSE_ECHOED", reasons.RESPONSE_ECHOED],
		["failed", "SECTION_NOT_FOUND", reasons.SECTION_NOT_FOUND],
		["refused", "SOMETHING_NEW", reasons.unknown],
		["failed", undefined, reasons.unknown],
	] as const)(
		"says why a %s revision (%s) was not applied",
		async (result, code, reason) => {
			renderPage();
			await pageReady();
			await applyFrom("Scope gap");

			settle({ result, code });

			expect(screen.getByRole("status")).toHaveTextContent(
				analysisCopy.revisionRefused.replace("{reason}", reason),
			);
		},
	);

	it("clears the previous message when a new revision starts", async () => {
		renderPage();
		await pageReady();
		await applyFrom("Scope gap");
		settle({ result: "rejected" });
		expect(screen.getByRole("status")).toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("button", { name: "Apply Scope gap" }),
		);

		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("brings a member who left Main while it drafted back to Main once its review is shown", async () => {
		renderPage();
		await pageReady();
		await applyFrom("Scope gap");
		const request = fixtures.editor.lastProps.sectionRevisionRequest;
		await userEvent.click(tab(tabs.analysis));
		expect(tab(tabs.analysis)).toHaveAttribute("aria-selected", "true");

		act(() => {
			fixtures.editor.lastProps.onSectionRevisionShown?.(
				"another-request",
			);
		});
		expect(tab(tabs.analysis)).toHaveAttribute("aria-selected", "true");

		act(() => {
			fixtures.editor.lastProps.onSectionRevisionShown?.(
				request?.id ?? "",
			);
		});
		expect(tab(tabs.main)).toHaveAttribute("aria-selected", "true");
	});

	it("leaves a member who moved to another tab there when it settles, and says why beside the finding", async () => {
		renderPage();
		await pageReady();
		await applyFrom("Scope gap");
		await userEvent.click(tab(tabs.style));

		settle({ result: "refused", code: "STALE" });

		expect(tab(tabs.style)).toHaveAttribute("aria-selected", "true");
		expect(fixtures.editor.lastProps.sectionRevisionRequest).toBeNull();
		expect(fixtures.panel.lastProps.pendingRevisionFindingId).toBeNull();
		expect(scrolledTo).toEqual([]);
		expect(findingItem("Scope gap")).not.toHaveFocus();

		await userEvent.click(tab(tabs.analysis));
		expect(screen.getByRole("status")).toHaveTextContent(
			analysisCopy.revisionRefused.replace("{reason}", reasons.STALE),
		);
		// Opening Analysis later does not jump to the finding either.
		expect(scrolledTo).toEqual([]);
	});

	it("ignores an outcome for any other request", async () => {
		renderPage();
		await pageReady();
		await applyFrom("Scope gap");

		settle({ id: "another-request", result: "accepted" });

		expect(tab(tabs.main)).toHaveAttribute("aria-selected", "true");
		expect(fixtures.editor.lastProps.sectionRevisionRequest).toMatchObject({
			findingId: "f-scope",
		});
		expect(fixtures.panel.lastProps.pendingRevisionFindingId).toBe(
			"f-scope",
		);
	});
});

describe("DocumentEditorPage — the chat's runtime URL", () => {
	it("names the document beside the organization", async () => {
		renderPage();
		await pageReady();

		const url = new URL(fixtures.runtimeUrl ?? "", "https://example.com");
		expect(url.pathname).toBe("/api/copilotkit");
		expect(url.searchParams.get("organizationId")).toBe("org-1");
		expect(url.searchParams.get("documentId")).toBe("doc-1");
	});

	it("names no document for a story, whose id is not a project document", async () => {
		renderPage("USER_STORY");
		await pageReady();

		const url = new URL(fixtures.runtimeUrl ?? "", "https://example.com");
		expect(url.searchParams.get("organizationId")).toBe("org-1");
		expect(url.searchParams.has("documentId")).toBe(false);
	});
});

describe("DocumentEditorPage — Living Docs auto-refresh", () => {
	it.each([
		["a member", false],
		["a project guest", true],
	])(
		"is not offered to %s on a client-document Proposal",
		async (_who, isGuest) => {
			fixtures.isGuest = isGuest;
			renderPage();
			await pageReady();

			expect(
				screen.queryByRole("button", { name: "Auto-refresh toggle" }),
			).not.toBeInTheDocument();
		},
	);

	it.each([
		[
			"a Proposal with the gate off",
			() => {
				fixtures.flags = { PROPOSAL_ARTIFACT: false };
			},
		],
		[
			"a Business Case",
			() => {
				fixtures.document = proposal({ type: "BUSINESS_CASE" });
			},
		],
	])("stays offered on %s", async (_what, arrange) => {
		arrange();
		renderPage();
		await pageReady();

		expect(
			screen.getByRole("button", { name: "Auto-refresh toggle" }),
		).toBeInTheDocument();
	});
});
