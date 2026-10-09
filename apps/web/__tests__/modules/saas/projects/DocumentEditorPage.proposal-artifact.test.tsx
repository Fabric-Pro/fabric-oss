/**
 * The document page of a Proposal in artifact mode (Fizzy #2801).
 *
 * With the `PROPOSAL_ARTIFACT` gate on, a member of the owning organization
 * sees a Proposal as three tabs — Main Document, Internal Analysis, Style —
 * and, while a run is queued or writing, a live Main instead of the editor.
 * Pinned here:
 *
 * - who gets the tabs: a member on a gated Proposal; not a Business Case, not
 *   with the gate off, and not a project guest, for whom no analysis request
 *   is ever made;
 * - the Main tab follows the server's status: live sections (or progress and
 *   the queued copy) while it runs, the editor once it completes — and the
 *   editor is the same instance throughout, so a regeneration it started
 *   still ends in its review with Reject; only someone who can edit has the
 *   editor attached to a run it did not start;
 * - switching tabs never unmounts the editor, and hidden panels are out of
 *   the tab order;
 * - a `document_change` nudge for this document refetches the document, and
 *   the analysis too unless a run is still writing; the end of a run
 *   refetches the analysis without one; a nudge for another document does
 *   nothing;
 * - the Analysis tab's indicator, the library prompt label, the Glossy link
 *   rule and the typography wrapper, including its computed sizes.
 *
 * `@tanstack/react-query` is real; the document and the analysis come from
 * mutable fixtures behind mocked oRPC clients. `DocumentEditor` is a stand-in
 * that keeps the state the real one keeps across a run — whether it started a
 * regeneration and what the body was then — so losing its instance shows up
 * as a lost review.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
	document: {} as Record<string, unknown>,
	analysis: null as unknown,
	glossyEdition: null as unknown,
	flags: { PROPOSAL_ARTIFACT: true, GLOSSY_EDITION: false } as Record<
		string,
		boolean
	>,
	isGuest: false,
	userRole: "editor",
	aiSidebarExpanded: false,
	presence: {
		onDocumentChange: undefined as undefined | ((event: unknown) => void),
	},
	editor: {
		mounts: 0,
		unmounts: 0,
		lastProps: {} as Record<string, unknown>,
	},
	api: {
		getDocument: vi.fn(),
		getAnalysis: vi.fn(),
		getGlossy: vi.fn(),
		generate: vi.fn(),
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
								userRole: fixtures.userRole,
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
							mutationFn: async (input: unknown) =>
								fixtures.api.generate(input),
							...config,
						}),
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
	useAiSidebarExpanded: () => fixtures.aiSidebarExpanded,
}));
vi.mock("@saas/shared/components/copilot/CopilotChatSessionProvider", () => ({
	CopilotChatSessionProvider: ({ children }: { children: ReactNode }) => (
		<>{children}</>
	),
}));
vi.mock("@saas/projects/hooks", () => ({
	useProjectPresence: (options: {
		onDocumentChange?: (event: unknown) => void;
	}) => {
		fixtures.presence.onDocumentChange = options.onDocumentChange;
		return { activeUsers: [], isConnected: false };
	},
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@saas/subscriptions/components/SubscribeToggle", () => ({
	SubscribeToggle: () => null,
}));
vi.mock("@saas/projects/components/DocumentAutoRefreshToggle", () => ({
	DocumentAutoRefreshToggle: () => null,
}));
vi.mock("@saas/projects/components/DocumentTitleInlineEdit", () => ({
	DocumentTitleInlineEdit: () => null,
}));
vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock(
	"@saas/projects/components/proposal-artifact/ProposalAnalysisPanel",
	() => ({
		ProposalAnalysisPanel: (props: { isGenerating: boolean }) => (
			<p>Analysis panel{props.isGenerating ? " (generating)" : ""}</p>
		),
	}),
);
vi.mock(
	"@saas/projects/components/proposal-artifact/ProposalStylePanel",
	() => ({
		ProposalStylePanel: (props: { canEdit: boolean }) => (
			<label>
				Style direction
				<input readOnly={!props.canEdit} />
			</label>
		),
	}),
);

/**
 * The editor stand-in. Like the real one it reads the document itself, and it
 * holds what a regeneration needs across the run in its own state: the body
 * it started from. When a different body arrives it opens a review whose
 * Reject only exists while that state survives.
 */
vi.mock("@saas/projects/components/DocumentEditor", async () => {
	const { orpc } = await import("@shared/lib/orpc-query-utils");
	function DocumentEditorStandIn(props: {
		projectId: string;
		documentId: string;
		promptSelectorReplacement?: ReactNode;
		suppressGenerationOverlay?: boolean;
		attachToServerRun?: boolean;
	}) {
		fixtures.editor.lastProps = props;
		const { data } = useQuery(
			orpc.projects.documents.get.queryOptions({
				input: {
					id: props.documentId,
					projectId: props.projectId,
					organizationId: "org-1",
				},
			}),
		);
		const content = (
			data as { document?: { content?: string } } | undefined
		)?.document?.content;
		const [baseline, setBaseline] = useState<string | null>(null);
		useEffect(() => {
			fixtures.editor.mounts += 1;
			return () => {
				fixtures.editor.unmounts += 1;
			};
		}, []);
		const reviewing = baseline !== null && content !== baseline;
		return (
			<div>
				{props.promptSelectorReplacement ?? (
					<select aria-label="Prompt">
						<option>Use default prompt</option>
					</select>
				)}
				<button
					type="button"
					onClick={() => setBaseline(content ?? "")}
				>
					Regenerate
				</button>
				<div data-testid="editor-scroll" style={{ overflow: "auto" }}>
					<p>{content}</p>
				</div>
				{reviewing && (
					<fieldset aria-label="Regeneration review">
						<button type="button">Accept</button>
						<button type="button">Reject</button>
					</fieldset>
				)}
			</div>
		);
	}
	return {
		DocumentEditor: DocumentEditorStandIn,
		getDocumentTypeLabel: (type: string) => type,
	};
});

import germanMessages from "@repo/i18n/translations/de.json";
import messages from "@repo/i18n/translations/en.json";
import { DocumentEditorPage } from "@saas/projects/components/DocumentEditorPage";
import { proposalAnalysisQueryKey } from "@saas/projects/components/proposal-artifact/use-proposal-analysis";
import { orpc } from "@shared/lib/orpc-query-utils";

const pageCopy = messages.projects.proposalArtifactPage;
const LIBRARY_PROMPT = messages.projects.proposalArtifactEntry.libraryPrompt;

const DOCUMENT_KEY = orpc.projects.documents.get.queryKey({
	input: { id: "doc-1", projectId: "proj-1", organizationId: "org-1" },
});

function proposal(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc-1",
		title: "Example proposal",
		type: "PROPOSAL",
		status: "COMPLETE",
		content: "## Scope\n\nThe saved body.",
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

function analysisRun(overrides: Record<string, unknown> = {}) {
	return {
		id: "analysis-1",
		status: "COMPLETE",
		isStale: false,
		timedOut: false,
		findings: [],
		...overrides,
	};
}

let client: QueryClient;

function renderPage() {
	return render(
		<QueryClientProvider client={client}>
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="example-org"
			/>
		</QueryClientProvider>,
	);
}

/**
 * Pushes a new server snapshot of the document into the shared cache, the
 * way a poll or a nudge's refetch lands, and lets the observers hear of it
 * (react-query notifies on a timer).
 */
async function serverReports(overrides: Record<string, unknown>) {
	fixtures.document = proposal(overrides);
	await act(async () => {
		client.setQueryData(DOCUMENT_KEY, { document: fixtures.document });
		await new Promise((done) => setTimeout(done, 0));
	});
}

/** Renders the page again from a clean cache, as a new visit would. */
function renderFreshPage() {
	client.clear();
	return renderPage();
}

async function pageReady() {
	await screen.findByRole("button", { name: "Regenerate", hidden: true });
}

function editorRegion(): HTMLElement {
	const region = screen
		.getByRole("button", { name: "Regenerate", hidden: true })
		.closest<HTMLElement>(".h-full");
	if (!region) {
		throw new Error("no editor region");
	}
	return region;
}

beforeEach(() => {
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			mutations: { retry: false },
		},
	});
	fixtures.document = proposal();
	fixtures.analysis = null;
	fixtures.glossyEdition = null;
	fixtures.flags = { PROPOSAL_ARTIFACT: true, GLOSSY_EDITION: false };
	fixtures.isGuest = false;
	fixtures.userRole = "editor";
	fixtures.aiSidebarExpanded = false;
	fixtures.presence.onDocumentChange = undefined;
	fixtures.editor = { mounts: 0, unmounts: 0, lastProps: {} };
	fixtures.api.getDocument.mockReset();
	fixtures.api.getDocument.mockImplementation(async () => ({
		document: fixtures.document,
	}));
	fixtures.api.getAnalysis.mockReset();
	fixtures.api.getAnalysis.mockImplementation(async () => fixtures.analysis);
	fixtures.api.getGlossy.mockReset();
	fixtures.api.getGlossy.mockImplementation(async () => ({
		edition: fixtures.glossyEdition,
	}));
	fixtures.api.generate.mockReset();
	fixtures.api.generate.mockResolvedValue({ outcome: "started" });
});

afterEach(() => {
	client.clear();
});

describe("DocumentEditorPage — who gets the Proposal tabs", () => {
	it("shows Main Document, Internal Analysis and Style to a member, Main selected", async () => {
		renderPage();
		await pageReady();

		const tablist = screen.getByRole("tablist", {
			name: pageCopy.tabs.label,
		});
		const tabs = within(tablist).getAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			pageCopy.tabs.main,
			pageCopy.tabs.analysis,
			pageCopy.tabs.style,
		]);
		expect(
			screen.getByRole("tab", { name: pageCopy.tabs.main }),
		).toHaveAttribute("aria-selected", "true");
		expect(fixtures.editor.lastProps.suppressGenerationOverlay).toBe(true);
		await waitFor(() =>
			expect(fixtures.api.getAnalysis).toHaveBeenCalledWith({
				projectId: "proj-1",
				documentId: "doc-1",
			}),
		);
	});

	it("keeps today's page for a Business Case", async () => {
		fixtures.document = proposal({ type: "BUSINESS_CASE" });
		renderPage();
		await pageReady();

		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
		expect(fixtures.editor.lastProps.suppressGenerationOverlay).toBe(false);
		expect(fixtures.editor.lastProps.attachToServerRun).toBe(false);
		expect(fixtures.api.getAnalysis).not.toHaveBeenCalled();
	});

	it("keeps today's page with the gate off", async () => {
		fixtures.flags.PROPOSAL_ARTIFACT = false;
		renderPage();
		await pageReady();

		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
		expect(fixtures.editor.lastProps.suppressGenerationOverlay).toBe(false);
		expect(fixtures.api.getAnalysis).not.toHaveBeenCalled();
	});

	it("keeps today's page for a project guest and never asks for the analysis", async () => {
		fixtures.isGuest = true;
		renderPage();
		await pageReady();
		// A nudge must not reach for it either.
		act(() => {
			fixtures.presence.onDocumentChange?.({
				projectId: "proj-1",
				documentId: "doc-1",
				action: "updated",
			});
		});

		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
		expect(fixtures.editor.lastProps.suppressGenerationOverlay).toBe(false);
		expect(fixtures.api.getAnalysis).not.toHaveBeenCalled();
		expect(
			screen.queryByText(/Analysis panel/, { ignore: "script" }),
		).not.toBeInTheDocument();
		// Neither the internal library prompt's name nor a selector whose
		// choice the run would ignore.
		expect(screen.queryByText(LIBRARY_PROMPT)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("combobox", { name: "Prompt" }),
		).not.toBeInTheDocument();
	});
});

describe("DocumentEditorPage — the Main tab follows the server's status", () => {
	it("shows the live sections while a run writes, with the editor hidden but mounted", async () => {
		fixtures.document = proposal({
			status: "GENERATING",
			generationStartedAt: new Date().toISOString(),
			// Mid-stream: the run reports 80 only once the agent has finished.
			generationProgress: 40,
			liveContent:
				"## Scope\n\nFirst finished section.\n\n## Timeline\n\nSecond.",
		});
		renderPage();
		await pageReady();

		const live = screen.getByTestId("proposal-live-sections");
		expect(
			await within(live).findByRole("heading", {
				level: 2,
				name: "Scope",
			}),
		).toBeInTheDocument();
		expect(within(live).getByText(pageCopy.live.writingNext)).toBeVisible();

		const regenerate = screen.getByRole("button", {
			name: "Regenerate",
			hidden: true,
		});
		expect(regenerate).not.toBeVisible();
		expect(editorRegion()).toHaveAttribute("hidden");
		// The page hosts the progress; the editor's overlay is switched off.
		expect(fixtures.editor.lastProps.suppressGenerationOverlay).toBe(true);
		// ...and the editor is attached to the run, so it takes the saved body
		// even when it did not start the run itself.
		expect(fixtures.editor.lastProps.attachToServerRun).toBe(true);
		expect(fixtures.editor.mounts).toBe(1);
	});

	it("does not attach a viewer's editor to the run: someone who cannot edit takes no run's body", async () => {
		fixtures.userRole = "viewer";
		fixtures.document = proposal({
			status: "GENERATING",
			generationStartedAt: new Date().toISOString(),
			liveContent: "## Scope\n\nFirst finished section.",
		});
		renderPage();
		await pageReady();

		expect(screen.getByTestId("proposal-live-sections")).toBeVisible();
		expect(fixtures.editor.lastProps.attachToServerRun).toBe(false);
	});

	it("shows the queued wait and its copy, not a blank pane, before anything is written", async () => {
		fixtures.document = proposal({
			status: "QUEUED",
			content: "",
			liveContent: "",
			generationProgress: 0,
		});
		renderPage();
		await pageReady();

		const live = screen.getByTestId("proposal-live-sections");
		const progress = within(live).getByRole("region", {
			name: "Document generation progress",
		});
		expect(
			within(progress).getByText("Waiting for project context"),
		).toBeVisible();
		expect(within(live).getByText(pageCopy.live.newDocument)).toBeVisible();
		expect(editorRegion()).toHaveAttribute("hidden");
	});

	it("ends a regeneration started in the editor in its review, with Reject, on the same editor", async () => {
		const user = userEvent.setup();
		renderPage();
		await pageReady();
		await user.click(screen.getByRole("button", { name: "Regenerate" }));

		await serverReports({
			status: "GENERATING",
			generationStartedAt: new Date().toISOString(),
			liveContent: "## Scope\n\nA new first section.",
		});
		expect(screen.getByTestId("proposal-live-sections")).toBeVisible();
		expect(editorRegion()).toHaveAttribute("hidden");

		await serverReports({
			status: "COMPLETE",
			content: "## Scope\n\nThe regenerated body.",
			liveContent: null,
		});

		expect(
			screen.queryByTestId("proposal-live-sections"),
		).not.toBeInTheDocument();
		expect(editorRegion()).not.toHaveAttribute("hidden");
		const review = screen.getByRole("group", {
			name: "Regeneration review",
		});
		expect(
			within(review).getByRole("button", { name: "Reject" }),
		).toBeVisible();
		expect(screen.getByText(/The regenerated body\./)).toBeVisible();
		expect(fixtures.editor).toMatchObject({ mounts: 1, unmounts: 0 });
	});

	it("retries a stalled run from the live pane", async () => {
		const user = userEvent.setup();
		const stalledAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		fixtures.document = proposal({
			status: "GENERATING",
			generationStartedAt: stalledAt,
			updatedAt: stalledAt,
			generationProgress: 35,
		});
		renderPage();
		await pageReady();

		await user.click(
			screen.getByRole("button", { name: /retry generation/i }),
		);

		await waitFor(() =>
			expect(fixtures.api.generate).toHaveBeenCalledWith({ id: "doc-1" }),
		);
	});
});

describe("DocumentEditorPage — tabs", () => {
	it("switches panels without unmounting the editor, and hides the inactive ones", async () => {
		const user = userEvent.setup();
		renderPage();
		await pageReady();

		await user.click(
			screen.getByRole("tab", { name: /Internal Analysis/ }),
		);
		const analysisPanel = screen.getByRole("tabpanel", {
			name: /Internal Analysis/,
		});
		expect(within(analysisPanel).getByText("Analysis panel")).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Regenerate", hidden: true }),
		).not.toBeVisible();

		await user.click(
			screen.getByRole("tab", { name: pageCopy.tabs.style }),
		);
		expect(screen.getByLabelText("Style direction")).toBeVisible();
		expect(screen.getByText("Analysis panel")).not.toBeVisible();

		await user.click(screen.getByRole("tab", { name: pageCopy.tabs.main }));
		expect(
			screen.getByRole("button", { name: "Regenerate" }),
		).toBeVisible();
		expect(screen.getByLabelText("Style direction")).not.toBeVisible();
		expect(fixtures.editor).toMatchObject({ mounts: 1, unmounts: 0 });
	});

	it("labels each panel by its tab and wires the tabs to them", async () => {
		renderPage();
		await pageReady();

		for (const name of [/Main Document/, /Internal Analysis/, /^Style$/]) {
			const tab = screen.getByRole("tab", { name });
			const panel = document.getElementById(
				tab.getAttribute("aria-controls") ?? "",
			);
			expect(panel).toHaveAttribute("role", "tabpanel");
			expect(panel).toHaveAttribute("aria-labelledby", tab.id);
		}
	});

	it("keeps hidden panels out of the tab order and moves between tabs with the arrow keys", async () => {
		const user = userEvent.setup();
		renderPage();
		await pageReady();

		const mainTab = screen.getByRole("tab", { name: pageCopy.tabs.main });
		act(() => mainTab.focus());
		await user.keyboard("{ArrowRight}");
		const analysisTab = screen.getByRole("tab", {
			name: /Internal Analysis/,
		});
		expect(analysisTab).toHaveFocus();
		expect(analysisTab).toHaveAttribute("aria-selected", "true");

		// From the tab list, Tab never lands inside a hidden panel: not the
		// editor's controls, not the Style form.
		await user.tab();
		expect(
			screen.getByRole("button", { name: "Regenerate", hidden: true }),
		).not.toHaveFocus();
		expect(
			screen.getByLabelText("Style direction", { selector: "input" }),
		).not.toHaveFocus();
	});

	it("hides the editor's own masthead controls and the chat's reserved width with the editor", async () => {
		const user = userEvent.setup();
		fixtures.aiSidebarExpanded = true;
		const { container } = renderPage();
		await pageReady();
		const root = container.firstElementChild as HTMLElement;
		expect(root).toHaveClass("ai-sidebar-shift");

		await user.click(
			screen.getByRole("tab", { name: pageCopy.tabs.style }),
		);

		expect(root).not.toHaveClass("ai-sidebar-shift");
		const back = screen.getByRole("button", { name: "Back to documents" });
		const actionBar = back.closest("div.border-b") as HTMLElement;
		const slots = Array.from(actionBar.children).slice(-2);
		for (const slot of slots) {
			expect(slot).toHaveAttribute("hidden");
		}
	});

	it("returns the editor to where the reader left it", async () => {
		const user = userEvent.setup();
		renderPage();
		await pageReady();
		const scroller = screen.getByTestId("editor-scroll");
		scroller.scrollTop = 480;
		scroller.dispatchEvent(new Event("scroll"));

		await user.click(
			screen.getByRole("tab", { name: pageCopy.tabs.style }),
		);
		// What a browser does to a box it stops displaying.
		scroller.scrollTop = 0;
		await user.click(screen.getByRole("tab", { name: pageCopy.tabs.main }));

		expect(scroller.scrollTop).toBe(480);
	});
});

describe("DocumentEditorPage — document nudges", () => {
	it("refetches the document and the analysis on a nudge for this document", async () => {
		renderPage();
		await pageReady();
		await waitFor(() =>
			expect(fixtures.api.getAnalysis).toHaveBeenCalled(),
		);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const documentReads = fixtures.api.getDocument.mock.calls.length;
		const analysisReads = fixtures.api.getAnalysis.mock.calls.length;

		act(() => {
			fixtures.presence.onDocumentChange?.({
				projectId: "proj-1",
				documentId: "doc-1",
				action: "updated",
			});
		});

		expect(invalidate).toHaveBeenCalledWith({ queryKey: DOCUMENT_KEY });
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: proposalAnalysisQueryKey("proj-1", "doc-1"),
		});
		await waitFor(() => {
			expect(fixtures.api.getDocument.mock.calls.length).toBeGreaterThan(
				documentReads,
			);
			expect(fixtures.api.getAnalysis.mock.calls.length).toBeGreaterThan(
				analysisReads,
			);
		});
	});

	it("leaves the analysis alone on a nudge while a run is still writing", async () => {
		// Each live section comes with a nudge; the analysis cannot change
		// until the run has saved, so only the document is refetched.
		fixtures.document = proposal({
			status: "GENERATING",
			generationStartedAt: new Date().toISOString(),
			liveContent: "## Scope\n\nFirst finished section.",
		});
		renderPage();
		await pageReady();
		await waitFor(() =>
			expect(fixtures.api.getAnalysis).toHaveBeenCalled(),
		);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const documentReads = fixtures.api.getDocument.mock.calls.length;
		const analysisReads = fixtures.api.getAnalysis.mock.calls.length;

		act(() => {
			fixtures.presence.onDocumentChange?.({
				projectId: "proj-1",
				documentId: "doc-1",
				action: "updated",
			});
		});

		expect(invalidate).toHaveBeenCalledWith({ queryKey: DOCUMENT_KEY });
		expect(invalidate).not.toHaveBeenCalledWith({
			queryKey: proposalAnalysisQueryKey("proj-1", "doc-1"),
		});
		await waitFor(() =>
			expect(fixtures.api.getDocument.mock.calls.length).toBeGreaterThan(
				documentReads,
			),
		);
		expect(fixtures.api.getAnalysis.mock.calls.length).toBe(analysisReads);
	});

	it("refetches the analysis once when a run ends, with no nudge to say so", async () => {
		renderPage();
		await pageReady();
		await waitFor(() =>
			expect(fixtures.api.getAnalysis).toHaveBeenCalled(),
		);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const analysisKey = proposalAnalysisQueryKey("proj-1", "doc-1");

		// A run starts: nothing about the analysis changes yet.
		await serverReports({
			status: "GENERATING",
			generationStartedAt: new Date().toISOString(),
			liveContent: "## Scope\n\nA.",
		});
		expect(invalidate).not.toHaveBeenCalledWith({ queryKey: analysisKey });
		const analysisReads = fixtures.api.getAnalysis.mock.calls.length;

		// It ends: its analysis is asked for, realtime or not.
		await serverReports({ status: "COMPLETE", content: "## Scope\n\nB." });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: analysisKey });
		await waitFor(() =>
			expect(fixtures.api.getAnalysis.mock.calls.length).toBeGreaterThan(
				analysisReads,
			),
		);

		// Only once: a later snapshot of the finished document asks nothing.
		invalidate.mockClear();
		await serverReports({ status: "COMPLETE", content: "## Scope\n\nC." });
		expect(invalidate).not.toHaveBeenCalledWith({ queryKey: analysisKey });
	});

	it("ignores a nudge for another document", async () => {
		renderPage();
		await pageReady();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		act(() => {
			fixtures.presence.onDocumentChange?.({
				projectId: "proj-1",
				documentId: "doc-2",
				action: "updated",
			});
		});

		expect(invalidate).not.toHaveBeenCalled();
	});

	it("hands the realtime connection one handler for the page's lifetime", async () => {
		renderPage();
		await pageReady();
		const first = fixtures.presence.onDocumentChange;

		await serverReports({
			status: "GENERATING",
			liveContent: "## Scope\n\nA.",
		});
		await serverReports({ status: "COMPLETE", content: "## Scope\n\nB." });

		expect(fixtures.presence.onDocumentChange).toBe(first);
	});
});

describe("DocumentEditorPage — Internal Analysis tab indicator", () => {
	async function analysisTab() {
		renderPage();
		await pageReady();
		return screen.getByRole("tab", { name: /Internal Analysis/ });
	}

	it("says a queued run is waiting", async () => {
		fixtures.analysis = analysisRun({ status: "PENDING" });
		const tab = await analysisTab();
		await waitFor(() =>
			expect(tab).toHaveTextContent(pageCopy.analysisIndicator.pending),
		);
	});

	it("says a run is running", async () => {
		fixtures.analysis = analysisRun({ status: "RUNNING" });
		const tab = await analysisTab();
		await waitFor(() =>
			expect(tab).toHaveTextContent(pageCopy.analysisIndicator.running),
		);
	});

	it("counts the Blocking findings of a complete run", async () => {
		fixtures.analysis = analysisRun({
			findings: [
				{ id: "f1", severity: "BLOCKING" },
				{ id: "f2", severity: "BLOCKING" },
				{ id: "f3", severity: "IMPORTANT" },
			],
		});
		const tab = await analysisTab();
		await waitFor(() => expect(tab).toHaveTextContent("2 blocking"));
	});

	it("shows nothing beside the label for a complete run without Blocking findings", async () => {
		fixtures.analysis = analysisRun({
			findings: [{ id: "f1", severity: "INFORMATIONAL" }],
		});
		const tab = await analysisTab();
		await waitFor(() =>
			expect(fixtures.api.getAnalysis).toHaveBeenCalled(),
		);
		expect(tab).toHaveTextContent(/^Internal Analysis$/);
	});

	it("marks a failed run in words", async () => {
		fixtures.analysis = analysisRun({ status: "FAILED" });
		const tab = await analysisTab();
		await waitFor(() =>
			expect(tab).toHaveTextContent(pageCopy.analysisIndicator.failed),
		);
	});
});

describe("DocumentEditorPage — prompt label and Glossy link", () => {
	it("replaces the prompt selector with the library label on a gated Proposal", async () => {
		renderPage();
		await pageReady();

		expect(screen.getByText(LIBRARY_PROMPT)).toBeVisible();
		expect(
			screen.queryByRole("combobox", { name: "Prompt" }),
		).not.toBeInTheDocument();
	});

	it("keeps the prompt selector on a Business Case and with the gate off", async () => {
		fixtures.document = proposal({ type: "BUSINESS_CASE" });
		const view = renderPage();
		await pageReady();
		expect(screen.getByRole("combobox", { name: "Prompt" })).toBeVisible();
		expect(screen.queryByText(LIBRARY_PROMPT)).not.toBeInTheDocument();
		view.unmount();

		fixtures.document = proposal();
		fixtures.flags.PROPOSAL_ARTIFACT = false;
		renderFreshPage();
		await pageReady();
		expect(screen.getByRole("combobox", { name: "Prompt" })).toBeVisible();
		expect(screen.queryByText(LIBRARY_PROMPT)).not.toBeInTheDocument();
	});

	it("hides the Glossy link of a gated Proposal without a published edition", async () => {
		fixtures.flags.GLOSSY_EDITION = true;
		fixtures.glossyEdition = null;
		renderPage();
		await pageReady();
		await waitFor(() => expect(fixtures.api.getGlossy).toHaveBeenCalled());

		expect(
			screen.queryByRole("link", { name: "Glossy version" }),
		).not.toBeInTheDocument();
	});

	it("keeps the Glossy link while a published legacy edition exists", async () => {
		fixtures.flags.GLOSSY_EDITION = true;
		fixtures.glossyEdition = { content: { sections: [] } };
		renderPage();
		await pageReady();

		expect(
			await screen.findByRole("link", { name: "Glossy version" }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/proj-1/documents/doc-1/glossy",
		);
	});
});

describe("DocumentEditorPage — translations", () => {
	function leaves(node: unknown, prefix = ""): Record<string, unknown> {
		if (typeof node !== "object" || node === null) {
			return { [prefix]: node };
		}
		return Object.assign(
			{},
			...Object.entries(node).map(([key, value]) =>
				leaves(value, prefix ? `${prefix}.${key}` : key),
			),
		);
	}

	it("has every page string in English and German", () => {
		const en = leaves(messages.projects.proposalArtifactPage);
		const de = leaves(germanMessages.projects.proposalArtifactPage);

		expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
		for (const [key, value] of Object.entries(de)) {
			expect(value, `de ${key}`).toEqual(expect.stringMatching(/\S/));
		}
	});
});

describe("DocumentEditorPage — artifact typography", () => {
	it("wraps the editor in the typography class only in artifact mode", async () => {
		const view = renderPage();
		await pageReady();
		expect(editorRegion()).toHaveClass("proposal-artifact");
		view.unmount();

		fixtures.document = proposal({ type: "BUSINESS_CASE" });
		renderFreshPage();
		await pageReady();
		expect(editorRegion()).not.toHaveClass("proposal-artifact");
	});

	describe("computed sizes", () => {
		const css = readFileSync(
			resolve(
				__dirname,
				"../../../../modules/saas/projects/components/DocumentEditor.css",
			),
			"utf8",
		);
		let style: HTMLStyleElement;

		beforeEach(() => {
			style = document.createElement("style");
			style.textContent = css;
			document.head.appendChild(style);
		});
		afterEach(() => {
			style.remove();
		});

		function mount(wrapperClass: string) {
			const { container } = render(
				<div className={wrapperClass}>
					<div className="p-10 tiptap">
						<h1>Title</h1>
						<h2>Section</h2>
						<h3>Subsection</h3>
						<p>Body</p>
					</div>
				</div>,
			);
			const tiptap = container.querySelector(".tiptap") as HTMLElement;
			return {
				tiptap: getComputedStyle(tiptap),
				h1: getComputedStyle(tiptap.querySelector("h1") as HTMLElement),
				h2: getComputedStyle(tiptap.querySelector("h2") as HTMLElement),
				h3: getComputedStyle(tiptap.querySelector("h3") as HTMLElement),
			};
		}

		it("sets the larger body, the heading scale and the 72ch column", () => {
			const styles = mount("proposal-artifact");

			expect(styles.tiptap.fontSize).toBe("1.0625rem");
			expect(styles.tiptap.lineHeight).toBe("1.75");
			expect(styles.tiptap.maxWidth).toBe("72ch");
			expect(styles.tiptap.boxSizing).toBe("content-box");
			expect(styles.h1.fontSize).toBe("1.875rem");
			expect(styles.h2.fontSize).toBe("1.5rem");
			expect(styles.h3.fontSize).toBe("1.25rem");
			expect(styles.h2.lineHeight).toBe("1.3");
		});

		it("leaves every other editor on the shared rules", () => {
			const styles = mount("");

			expect(styles.tiptap.fontSize).toBe("");
			expect(styles.tiptap.maxWidth).toBe("");
			expect(styles.h1.fontSize).toBe("1.4rem");
			expect(styles.h2.fontSize).toBe("1.2rem");
		});

		it("returns to the editor's body size and the full width below the md breakpoint", () => {
			// jsdom does not evaluate media queries, so the rule is read from
			// the stylesheet itself.
			const sheet = style.sheet as CSSStyleSheet;
			const narrow = Array.from(sheet.cssRules).find(
				(rule): rule is CSSMediaRule =>
					rule instanceof CSSMediaRule &&
					rule.conditionText.includes("48rem") &&
					rule.cssText.includes(".proposal-artifact"),
			);
			expect(narrow?.conditionText).toMatch(/width\s*<\s*48rem/);
			const body = Array.from(narrow?.cssRules ?? []).find(
				(rule): rule is CSSStyleRule =>
					rule instanceof CSSStyleRule &&
					rule.selectorText === ".proposal-artifact .tiptap",
			);
			expect(body?.style.getPropertyValue("font-size")).toBe("1rem");
			expect(body?.style.getPropertyValue("max-width")).toBe("none");
		});
	});
});
