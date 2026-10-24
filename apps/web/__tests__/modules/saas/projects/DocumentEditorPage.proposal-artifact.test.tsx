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
 * - the live pane's Retry says what the server did (Fizzy #2946): joined the
 *   run already going, could not confirm its state, or refused with a code,
 *   told in the reader's words with the link that resolves it;
 * - switching tabs never unmounts the editor, and hidden panels are out of
 *   the tab order; the Style tab follows the server's `canUpdateProject`,
 *   not the project role the title follows;
 * - a `document_change` nudge for this document refetches the document, and
 *   the analysis too unless a run is still writing; the end of a run
 *   refetches the analysis without one; a nudge for another document does
 *   nothing; the echo of this tab's own save refetches no document, and on a
 *   collaborative page other members' nudges are gathered into one refetch
 *   a moment later (Fizzy #2946); a run started elsewhere on a document the
 *   tab shows as complete reaches it through that refetch, so the page
 *   switches to the run from the server's status;
 * - the Analysis tab's indicator, the library prompt label and the Glossy link
 *   rule;
 * - the shared Proposal theme (Fizzy #2946): worn by a member's and a project
 *   guest's Main alike, inside the editor's content and the live pane's
 *   document, never on the region that also holds the chat; neutral while the
 *   tokens are pending, the document's own once they arrive, and off for a
 *   Business Case (no request) or when the server refuses.
 *
 * `@tanstack/react-query` is real; the document, the analysis and the theme
 * tokens come from mutable fixtures behind mocked oRPC clients.
 * `DocumentEditor` is a stand-in that keeps the state the real one keeps
 * across a run — whether it started a regeneration and what the body was
 * then — so losing its instance shows up as a lost review. It puts the theme
 * root where the real one does, on the box around its content; that the box
 * holds neither the diff preview panes nor the chat is pinned against the
 * real editor in `DocumentEditor.proposal-artifact.test.tsx`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	MutationObserver,
	onlineManager,
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
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
	userRole: "editor" as string | null,
	/** The server's project write rule; unset unless a test says. */
	canUpdateProject: undefined as boolean | undefined,
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
		getThemeTokens: vi.fn(),
		generate: vi.fn(),
	},
	toast: {
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
		dismiss: vi.fn(),
	},
	router: { push: vi.fn() },
}));

vi.mock("sonner", async (importOriginal) => ({
	...(await importOriginal<typeof import("sonner")>()),
	toast: fixtures.toast,
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
								canUpdateProject: fixtures.canUpdateProject,
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
	useRouter: () => fixtures.router,
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
			<p data-props={Object.keys(props).sort().join(",")}>
				Analysis panel{props.isGenerating ? " (generating)" : ""}
			</p>
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
		contentThemeProps?: ProposalThemeRootProps;
		statTiles?: boolean;
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
		const { content, status } =
			(
				data as
					| { document?: { content?: string; status?: string } }
					| undefined
			)?.document ?? {};
		const [baseline, setBaseline] = useState<string | null>(null);
		useEffect(() => {
			fixtures.editor.mounts += 1;
			return () => {
				fixtures.editor.unmounts += 1;
			};
		}, []);
		const reviewing = baseline !== null && content !== baseline;
		return (
			// The status the editor read, which its own run state follows.
			<div data-testid="editor-stand-in" data-document-status={status}>
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
					<div {...props.contentThemeProps}>
						<p>{content}</p>
					</div>
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
import {
	buildProposalThemeTokens,
	NEUTRAL_THEME,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { SessionContext } from "@saas/auth/lib/session-context";
import { DocumentEditorPage } from "@saas/projects/components/DocumentEditorPage";
import { proposalAnalysisQueryKey } from "@saas/projects/components/proposal-artifact/use-proposal-analysis";
import type { ProposalThemeRootProps } from "@saas/projects/components/proposal-artifact/use-proposal-theme";
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

/** Theme tokens as the server sends them; no logos, so no signed reads. */
function themeTokens(primaryColor: string | null = null) {
	return {
		tokens: buildProposalThemeTokens({
			organization: { name: "Example Org", logoKey: null },
			style: primaryColor ? { primaryColor, accentColors: [] } : null,
			brandKit: null,
			recipient: null,
		}),
	};
}

/** The analysis read: a complete shown run unless overridden. */
function analysis(overrides: Record<string, unknown> = {}) {
	return {
		run: { id: "analysis-1", kind: "GENERATION", status: "COMPLETE" },
		isStale: false,
		newerRun: null,
		findings: [],
		noLongerRaised: [],
		...overrides,
	};
}

/** A run newer than the shown one, not complete. */
function newerRun(status: string, overrides: Record<string, unknown> = {}) {
	return {
		id: "analysis-2",
		kind: "RERUN",
		status,
		errorCode: null,
		timedOut: false,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

let client: QueryClient;

/** The signed-in member the page renders for. */
const SESSION_USER_ID = "user-1";

function renderPage() {
	return render(
		<SessionContext.Provider
			value={{
				session: null,
				user: { id: SESSION_USER_ID } as never,
				loaded: true,
				reloadSession: async () => {},
			}}
		>
			<QueryClientProvider client={client}>
				<DocumentEditorPage
					projectId="proj-1"
					documentId="doc-1"
					organizationSlug="example-org"
				/>
			</QueryClientProvider>
		</SessionContext.Provider>,
	);
}

const UPDATE_KEY = orpc.projects.documents.update.mutationKey();

/**
 * A save of the document from this tab, in the cache where the editor's own
 * `documents.update` mutation would be: still in flight, or answered.
 */
async function saveFromThisTab(
	settles: "pending" | "success" | "error" | "paused",
) {
	const save = new MutationObserver<
		unknown,
		Error,
		{ id: string; content: string }
	>(client, {
		mutationKey: UPDATE_KEY,
		mutationFn: () =>
			settles === "success"
				? Promise.resolve({})
				: settles === "error"
					? Promise.reject(new Error("refused"))
					: new Promise<never>(() => {}),
	});
	// Offline, a save waits paused rather than going out.
	if (settles === "paused") {
		onlineManager.setOnline(false);
	}
	const done = save
		.mutate({ id: "doc-1", content: "## Scope\n\nMine." })
		.catch(() => undefined);
	if (settles === "success" || settles === "error") {
		await act(async () => {
			await done;
		});
	} else {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

/** A `document_change` nudge for this document from `userId`. */
function nudge(userId?: string) {
	act(() => {
		fixtures.presence.onDocumentChange?.({
			projectId: "proj-1",
			documentId: "doc-1",
			action: "updated",
			userId,
			userName: "Example member",
		});
	});
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
	fixtures.analysis = analysis({ run: null });
	fixtures.glossyEdition = null;
	fixtures.flags = { PROPOSAL_ARTIFACT: true, GLOSSY_EDITION: false };
	fixtures.isGuest = false;
	fixtures.userRole = "editor";
	fixtures.canUpdateProject = undefined;
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
	fixtures.api.getThemeTokens.mockReset();
	fixtures.api.getThemeTokens.mockImplementation(async () => themeTokens());
	fixtures.api.generate.mockReset();
	fixtures.api.generate.mockResolvedValue({ outcome: "started" });
	for (const notify of Object.values(fixtures.toast)) {
		notify.mockReset();
	}
	fixtures.router.push.mockReset();
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

	it("hands the analysis panel no edit rights: whether a member may respond is the server's answer", async () => {
		const editor = renderPage();
		await pageReady();
		const passed = screen
			.getByText("Analysis panel", { ignore: "script" })
			.getAttribute("data-props");
		expect(passed?.split(",")).not.toContain("canEdit");
		editor.unmount();

		// The page's legacy role is null for an organization member reaching
		// the project through their organization role; it must not hide the
		// actions the server would allow.
		fixtures.userRole = null;
		renderFreshPage();
		await pageReady();
		expect(
			screen.getByText("Analysis panel", { ignore: "script" }),
		).toHaveAttribute("data-props", passed ?? "");
	});

	it("keeps today's page for a Business Case", async () => {
		fixtures.document = proposal({ type: "BUSINESS_CASE" });
		renderPage();
		await pageReady();

		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
		expect(fixtures.editor.lastProps.suppressGenerationOverlay).toBe(false);
		expect(fixtures.editor.lastProps.attachToServerRun).toBe(false);
		expect(fixtures.api.getAnalysis).not.toHaveBeenCalled();
		// A Business Case keeps a stat-tiles fence as a code block.
		expect(fixtures.editor.lastProps.statTiles).toBe(false);
	});

	it("lets the editor draw stat tiles for a client-document Proposal, members and guests alike", async () => {
		renderPage();
		await pageReady();
		expect(fixtures.editor.lastProps.statTiles).toBe(true);
	});

	it("offers the download menu on a client-document Proposal's page, to members and guests alike", async () => {
		renderPage();
		await pageReady();
		expect(
			screen.getByRole("button", { name: "Download" }),
		).toBeInTheDocument();

		cleanup();
		fixtures.isGuest = true;
		renderPage();
		await pageReady();
		expect(
			screen.getByRole("button", { name: "Download" }),
		).toBeInTheDocument();
	});

	it.each([
		[
			"a Business Case",
			() => {
				fixtures.document = proposal({ type: "BUSINESS_CASE" });
			},
		],
		[
			"a Proposal with the gate off",
			() => {
				fixtures.flags.PROPOSAL_ARTIFACT = false;
			},
		],
	])(
		"keeps the download menu off the page of %s",
		async (_label, arrange) => {
			arrange();
			renderPage();
			await pageReady();
			expect(
				screen.queryByRole("button", { name: "Download" }),
			).not.toBeInTheDocument();
		},
	);

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

describe("DocumentEditorPage — the live pane's Retry says what the server did", () => {
	const regenerateToast = messages.projects.documents.regenerateToast;
	const generationFeedback =
		messages.projects.proposalArtifact.generationFeedback;

	/** A run whose last write is ten minutes old, so the pane offers Retry. */
	async function retryStalledRun() {
		const user = userEvent.setup();
		const stalledAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		fixtures.document = proposal({
			status: "GENERATING",
			generationStartedAt: stalledAt,
			updatedAt: stalledAt,
			generationProgress: 50,
			liveContent: "## Scope\n\nFirst finished section.",
		});
		renderPage();
		await pageReady();
		const readsBefore = fixtures.api.getDocument.mock.calls.length;
		await user.click(
			screen.getByRole("button", { name: /retry generation/i }),
		);
		await waitFor(() =>
			expect(fixtures.api.generate).toHaveBeenCalledWith({ id: "doc-1" }),
		);
		return { readsBefore };
	}

	it("says the run is already running when the Retry joined it, and refetches the document", async () => {
		fixtures.api.generate.mockResolvedValue({
			outcome: "alreadyInProgress",
			workflowId: "workflow-live",
			runId: null,
		});

		const { readsBefore } = await retryStalledRun();

		await waitFor(() =>
			expect(fixtures.toast.info).toHaveBeenCalledWith(
				regenerateToast.alreadyRunning,
			),
		);
		await waitFor(() =>
			expect(fixtures.api.getDocument.mock.calls.length).toBeGreaterThan(
				readsBefore,
			),
		);
		expect(fixtures.toast.error).not.toHaveBeenCalled();
	});

	it("says the run's state could not be confirmed when the server could not tell", async () => {
		fixtures.api.generate.mockResolvedValue({
			outcome: "liveRunUnknown",
			workflowId: "workflow-live",
			runId: null,
		});

		await retryStalledRun();

		await waitFor(() =>
			expect(fixtures.toast.warning).toHaveBeenCalledWith(
				regenerateToast.liveRunUnknown,
			),
		);
		expect(fixtures.toast.info).not.toHaveBeenCalled();
	});

	it("treats its own ambiguous start as started: no word, and the document is refetched", async () => {
		// The server already queued the row for this request; only a live run
		// it could not confirm asks for another try.
		fixtures.api.generate.mockResolvedValue({
			outcome: "statusUnknown",
			workflowId: "workflow-new",
			runId: null,
		});

		const { readsBefore } = await retryStalledRun();

		await waitFor(() =>
			expect(fixtures.api.getDocument.mock.calls.length).toBeGreaterThan(
				readsBefore,
			),
		);
		expect(fixtures.toast.warning).not.toHaveBeenCalled();
		expect(fixtures.toast.info).not.toHaveBeenCalled();
		expect(fixtures.toast.error).not.toHaveBeenCalled();
	});

	it("adds no word to a new run, as before, and refetches the document", async () => {
		const { readsBefore } = await retryStalledRun();

		await waitFor(() =>
			expect(fixtures.api.getDocument.mock.calls.length).toBeGreaterThan(
				readsBefore,
			),
		);
		expect(fixtures.toast.info).not.toHaveBeenCalled();
		expect(fixtures.toast.warning).not.toHaveBeenCalled();
		expect(fixtures.toast.error).not.toHaveBeenCalled();
	});

	it("tells a coded refusal in the reader's words, with the link that resolves it", async () => {
		fixtures.api.generate.mockRejectedValue({
			code: "PRECONDITION_FAILED",
			message: "Server wording that must not reach the toast",
			data: { code: "PROPOSAL_PROMPT_NOT_BOUND" },
		});

		await retryStalledRun();

		await waitFor(() => expect(fixtures.toast.error).toHaveBeenCalled());
		const [message, options] = fixtures.toast.error.mock.calls[0] as [
			string,
			{ action: { label: string; onClick: () => void } },
		];
		expect(message).toBe(generationFeedback.promptNotBound);
		expect(options.action.label).toBe(generationFeedback.openCatalog);
		options.action.onClick();
		expect(fixtures.router.push).toHaveBeenCalledWith(
			expect.stringMatching(
				/^\/app\/example-org\/prompts\/catalog\?action=/,
			),
		);
	});

	it("keeps today's message for any other failure", async () => {
		fixtures.api.generate.mockRejectedValue(new Error("Network down"));

		await retryStalledRun();

		await waitFor(() =>
			expect(fixtures.toast.error).toHaveBeenCalledWith(
				pageCopy.live.retryFailed.replace("{message}", "Network down"),
			),
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

	it.each([
		[true, "editable"],
		[false, "read-only"],
	] as const)(
		"follows the server's canUpdateProject (%s) on the Style tab, not the project role: %s for a project admin",
		async (canUpdateProject, expected) => {
			const user = userEvent.setup();
			// A project admin is neither owner nor editor, so the title and
			// the Retry of a stalled run stay read-only for them.
			fixtures.userRole = "project_admin";
			fixtures.canUpdateProject = canUpdateProject;
			renderPage();
			await pageReady();

			await user.click(
				screen.getByRole("tab", { name: pageCopy.tabs.style }),
			);
			const direction = screen.getByLabelText("Style direction", {
				selector: "input",
			});
			if (expected === "editable") {
				expect(direction).not.toHaveAttribute("readonly");
			} else {
				expect(direction).toHaveAttribute("readonly");
			}
		},
	);

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

	it("skips the document refetch for this tab's own save, and still refetches the analysis", async () => {
		renderPage();
		await pageReady();
		await waitFor(() =>
			expect(fixtures.api.getAnalysis).toHaveBeenCalled(),
		);
		await saveFromThisTab("pending");
		const invalidate = vi.spyOn(client, "invalidateQueries");

		nudge(SESSION_USER_ID);

		// The save's answer carries the saved document; the analysis may now
		// read as behind the Main, so it is asked for as before.
		expect(invalidate).not.toHaveBeenCalledWith({ queryKey: DOCUMENT_KEY });
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: proposalAnalysisQueryKey("proj-1", "doc-1"),
		});
	});

	// No poll runs on a finished Proposal, so a run someone else starts is
	// told by the nudge its queue mark or its start sends (Fizzy #2946):
	// the refetch it causes is what moves the page to the run.
	it.each([
		[
			"GENERATING",
			{
				generationStartedAt: new Date().toISOString(),
				generationProgress: 40,
				liveContent: "## Scope\n\nFirst finished section.",
			},
		],
		["QUEUED", { generationProgress: 0, liveContent: "" }],
	] as const)(
		"moves a page showing a finished document to the run a nudge reveals (%s)",
		async (status, run) => {
			renderPage();
			await pageReady();
			expect(
				screen.queryByTestId("proposal-live-sections"),
			).not.toBeInTheDocument();
			expect(editorRegion()).not.toHaveAttribute("hidden");

			// The server's row moved; nothing on the page has noticed yet.
			fixtures.document = proposal({ status, ...run });
			nudge("fabric-generation-run");

			const live = await screen.findByTestId("proposal-live-sections");
			expect(live).toBeVisible();
			expect(editorRegion()).toHaveAttribute("hidden");
			// The editor follows the run it did not start, from the same read.
			expect(fixtures.editor.lastProps.attachToServerRun).toBe(true);
			expect(screen.getByTestId("editor-stand-in")).toHaveAttribute(
				"data-document-status",
				status,
			);
			expect(fixtures.editor).toMatchObject({ mounts: 1, unmounts: 0 });
		},
	);

	it("moves to the run on the queue mark's nudge, which names the member who started it from another tab", async () => {
		renderPage();
		await pageReady();

		fixtures.document = proposal({
			status: "QUEUED",
			generationProgress: 0,
			liveContent: "",
		});
		// No save of this tab explains it, so it is not taken for an echo.
		nudge(SESSION_USER_ID);

		expect(
			await screen.findByTestId("proposal-live-sections"),
		).toBeVisible();
		expect(editorRegion()).toHaveAttribute("hidden");
	});

	describe("outside artifact mode, on a collaborative document (Fizzy #2946)", () => {
		beforeEach(() => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "true");
			fixtures.flags = {
				PROPOSAL_ARTIFACT: false,
				GLOSSY_EDITION: false,
				DOCUMENT_ROOM_CONVERGENCE: true,
			};
		});
		afterEach(() => {
			onlineManager.setOnline(true);
			vi.useRealTimers();
			vi.unstubAllEnvs();
		});

		/** Renders the page, then takes over the clock for the nudges. */
		async function renderCollaborativePage() {
			renderPage();
			await pageReady();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			return vi.spyOn(client, "invalidateQueries");
		}

		function documentRefetches(invalidate: {
			mock: { calls: unknown[][] };
		}): number {
			return invalidate.mock.calls.filter(
				([filters]) =>
					JSON.stringify(
						(filters as { queryKey?: unknown }).queryKey,
					) === JSON.stringify(DOCUMENT_KEY),
			).length;
		}

		it("refetches the document a moment after another member's nudge, so an open room sees a server write", async () => {
			const invalidate = await renderCollaborativePage();

			nudge("user-2");

			expect(documentRefetches(invalidate)).toBe(0);
			act(() => {
				vi.advanceTimersByTime(999);
			});
			expect(documentRefetches(invalidate)).toBe(0);
			act(() => {
				vi.advanceTimersByTime(1);
			});
			expect(documentRefetches(invalidate)).toBe(1);
			expect(invalidate).not.toHaveBeenCalledWith({
				queryKey: proposalAnalysisQueryKey("proj-1", "doc-1"),
			});
		});

		it("gathers a burst of other members' saves into one refetch", async () => {
			const invalidate = await renderCollaborativePage();

			nudge("user-2");
			act(() => {
				vi.advanceTimersByTime(400);
			});
			nudge("user-3");
			nudge("user-2");
			act(() => {
				vi.advanceTimersByTime(600);
			});
			expect(documentRefetches(invalidate)).toBe(1);

			// A steady stream still refetches once per window.
			nudge("user-3");
			act(() => {
				vi.advanceTimersByTime(1_000);
			});
			expect(documentRefetches(invalidate)).toBe(2);
		});

		it("does not refetch on the echo of this tab's own save, in flight or just answered", async () => {
			const invalidate = await renderCollaborativePage();

			await saveFromThisTab("pending");
			nudge(SESSION_USER_ID);
			await saveFromThisTab("success");
			nudge(SESSION_USER_ID);
			act(() => {
				vi.advanceTimersByTime(5_000);
			});

			expect(documentRefetches(invalidate)).toBe(0);
		});

		it("refetches at once on a nudge of this member's that no save of this tab explains", async () => {
			// A restored version, their MCP client or API key, another tab.
			const invalidate = await renderCollaborativePage();

			nudge(SESSION_USER_ID);
			expect(documentRefetches(invalidate)).toBe(1);

			// One save explains one nudge: a second one during it is a write
			// from somewhere else.
			await saveFromThisTab("pending");
			nudge(SESSION_USER_ID);
			expect(documentRefetches(invalidate)).toBe(1);
			nudge(SESSION_USER_ID);
			expect(documentRefetches(invalidate)).toBe(2);
		});

		it("refetches at once when this tab's only save failed: a refused save sends no nudge", async () => {
			const invalidate = await renderCollaborativePage();

			await saveFromThisTab("error");
			nudge(SESSION_USER_ID);

			expect(documentRefetches(invalidate)).toBe(1);
		});

		it("refetches at once when this tab's only save is paused offline: it has not reached the server", async () => {
			const invalidate = await renderCollaborativePage();

			await saveFromThisTab("paused");
			nudge(SESSION_USER_ID);

			expect(documentRefetches(invalidate)).toBe(1);
		});

		it("refetches at once when this tab's only save was answered more than ten seconds ago", async () => {
			const invalidate = await renderCollaborativePage();
			await saveFromThisTab("success");
			const later = Date.now() + 10_001;
			const clock = vi.spyOn(Date, "now").mockReturnValue(later);
			try {
				nudge(SESSION_USER_ID);
			} finally {
				clock.mockRestore();
			}

			expect(documentRefetches(invalidate)).toBe(1);
		});

		it("hands the editor the run a nudge reveals on a document it read as finished", async () => {
			// No live pane outside artifact mode: the editor's own run state
			// follows the status it reads, which the gathered refetch brings.
			// Real timers, so the refetch's answer is delivered as it would be.
			renderPage();
			await pageReady();
			const editor = screen.getByTestId("editor-stand-in");
			expect(editor).toHaveAttribute("data-document-status", "COMPLETE");

			fixtures.document = proposal({
				status: "GENERATING",
				generationStartedAt: new Date().toISOString(),
				liveContent: "## Scope\n\nFirst finished section.",
			});
			nudge("fabric-generation-run");

			await waitFor(
				() =>
					expect(
						screen.getByTestId("editor-stand-in"),
					).toHaveAttribute("data-document-status", "GENERATING"),
				{ timeout: 3_000 },
			);
			expect(
				screen.queryByTestId("proposal-live-sections"),
			).not.toBeInTheDocument();
		});

		it("drops a gathered refetch still waiting when the page goes away", async () => {
			renderPage();
			await pageReady();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const invalidate = vi.spyOn(client, "invalidateQueries");

			nudge("user-2");
			cleanup();
			act(() => {
				vi.advanceTimersByTime(2_000);
			});

			expect(documentRefetches(invalidate)).toBe(0);
		});

		it("does not take another member's nudge for this tab's save", async () => {
			const invalidate = await renderCollaborativePage();

			await saveFromThisTab("pending");
			nudge("user-2");
			act(() => {
				vi.advanceTimersByTime(1_000);
			});

			expect(documentRefetches(invalidate)).toBe(1);
		});

		it("leaves the document to its own polling with the room flag off, as before", async () => {
			fixtures.flags.DOCUMENT_ROOM_CONVERGENCE = false;
			renderPage();
			await pageReady();
			const invalidate = vi.spyOn(client, "invalidateQueries");

			act(() => {
				fixtures.presence.onDocumentChange?.({
					projectId: "proj-1",
					documentId: "doc-1",
					action: "updated",
				});
			});

			expect(invalidate).not.toHaveBeenCalled();
		});
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

/**
 * A run steps the version after its COMPLETE save and sends no nudge for it,
 * and the editor stops polling at COMPLETE, so the page asks again for a
 * while for the header's number (Fizzy #2946).
 */
describe("DocumentEditorPage — the version step after a run", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Renders the page on this answer, then takes over the clock. */
	async function renderOn(overrides: Record<string, unknown>) {
		fixtures.document = proposal(overrides);
		renderPage();
		await pageReady();
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
			],
		});
	}

	/** `serverReports` on the faked clock. */
	async function serverAnswers(overrides: Record<string, unknown>) {
		fixtures.document = proposal(overrides);
		await act(async () => {
			client.setQueryData(DOCUMENT_KEY, { document: fixtures.document });
			await vi.advanceTimersByTimeAsync(0);
		});
	}

	async function wait(ms: number) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	}

	const reads = () => fixtures.api.getDocument.mock.calls.length;

	it("asks again 3s after the run ends, then wider apart, and stops once the stepped version arrives", async () => {
		await renderOn({
			status: "GENERATING",
			generationStartedAt: new Date().toISOString(),
		});
		await serverAnswers({ status: "COMPLETE", version: 2 });
		const before = reads();

		await wait(3000);
		expect(reads()).toBe(before + 1);
		fixtures.document = proposal({ status: "COMPLETE", version: 3 });
		await wait(6000);
		expect(reads()).toBe(before + 2);
		expect(
			(
				client.getQueryData(DOCUMENT_KEY) as {
					document: { version: number };
				}
			).document.version,
		).toBe(3);

		await wait(30_000);
		expect(reads()).toBe(before + 2);
	});

	// The step waits for the run's decision pre-check, up to two minutes.
	it("gives up 150s after the run ended when no version step comes", async () => {
		await renderOn({
			status: "GENERATING",
			generationStartedAt: new Date().toISOString(),
		});
		await serverAnswers({ status: "COMPLETE", version: 2 });
		const before = reads();

		await wait(140_000);
		expect(reads()).toBe(before + 7);
		await wait(30_000);
		expect(reads()).toBe(before + 8);
		await wait(120_000);
		expect(reads()).toBe(before + 8);
	});

	it("does not poll a document that was COMPLETE from the start", async () => {
		await renderOn({ status: "COMPLETE", version: 2 });
		const before = reads();

		await wait(60_000);
		expect(reads()).toBe(before);
	});
});

describe("DocumentEditorPage — Internal Analysis tab indicator", () => {
	async function analysisTab() {
		renderPage();
		await pageReady();
		return screen.getByRole("tab", { name: /Internal Analysis/ });
	}

	it("says a queued newer run is waiting", async () => {
		fixtures.analysis = analysis({ newerRun: newerRun("PENDING") });
		const tab = await analysisTab();
		await waitFor(() =>
			expect(tab).toHaveTextContent(pageCopy.analysisIndicator.pending),
		);
	});

	it("says a newer run is running, also before any run completed", async () => {
		fixtures.analysis = analysis({
			run: null,
			newerRun: newerRun("RUNNING"),
		});
		const tab = await analysisTab();
		await waitFor(() =>
			expect(tab).toHaveTextContent(pageCopy.analysisIndicator.running),
		);
	});

	it("counts the Blocking findings still waiting for a decision", async () => {
		fixtures.analysis = analysis({
			findings: [
				{ id: "f1", severity: "BLOCKING", state: "UNADDRESSED" },
				{ id: "f2", severity: "BLOCKING", state: "NEEDS_REVIEW" },
				{ id: "f3", severity: "BLOCKING", state: "CONFIRMED" },
				{ id: "f4", severity: "BLOCKING", state: "RESPONDED" },
				{ id: "f5", severity: "IMPORTANT", state: "UNADDRESSED" },
			],
		});
		const tab = await analysisTab();
		await waitFor(() => expect(tab).toHaveTextContent("2 blocking"));
	});

	it("shows nothing beside the label once every Blocking finding is answered", async () => {
		fixtures.analysis = analysis({
			findings: [
				{ id: "f1", severity: "BLOCKING", state: "CONFIRMED" },
				{ id: "f2", severity: "INFORMATIONAL", state: "UNADDRESSED" },
			],
		});
		const tab = await analysisTab();
		await waitFor(() =>
			expect(fixtures.api.getAnalysis).toHaveBeenCalled(),
		);
		expect(tab).toHaveTextContent(/^Internal Analysis$/);
	});

	it("marks a failed newer run in words", async () => {
		fixtures.analysis = analysis({
			newerRun: newerRun("FAILED", { errorCode: "MODEL_ERROR" }),
		});
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

describe("DocumentEditorPage — Proposal theme", () => {
	/** A synthetic Style primary that reads as text on white paper. */
	const STYLE_PRIMARY = "#1d4ed8";
	const THEME_ROOT = '.proposal-theme[data-proposal-theme="live"]';

	function themeRoot(): HTMLElement | null {
		return document.querySelector<HTMLElement>(THEME_ROOT);
	}

	async function findThemeRoot(): Promise<HTMLElement> {
		let root: HTMLElement | null = null;
		await waitFor(() => {
			root = themeRoot();
			expect(root).not.toBeNull();
		});
		return root as unknown as HTMLElement;
	}

	function themeStylesheets() {
		return document.head.querySelectorAll(
			'style[data-href="proposal-theme-live"]',
		);
	}

	/** The theme root, and no ancestor of it, is a theme root. */
	function expectSingleRoot(root: HTMLElement) {
		expect(root.parentElement?.closest(".proposal-theme")).toBeNull();
		expect(root.parentElement?.closest("[data-proposal-theme]")).toBeNull();
	}

	it("themes a member's Main inside the editor's content, never on the region that holds the chat", async () => {
		renderPage();
		await pageReady();

		const root = await findThemeRoot();
		expect(root.style.getPropertyValue("--pa-surface")).toBe(
			NEUTRAL_THEME.surface,
		);
		expect(root.style.getPropertyValue("--pa-ink")).toBe(NEUTRAL_THEME.ink);
		expect(root).toContainElement(screen.getByText(/The saved body\./));
		// The region wraps CopilotKit, whose chat the theme's element rules
		// would restyle; the root sits inside the editor instead.
		const region = editorRegion();
		expect(region).toContainElement(root);
		expect(region).not.toHaveClass("proposal-theme");
		expect(region).not.toHaveAttribute("data-proposal-theme");
		expect(root).not.toContainElement(
			screen.getByRole("button", { name: "Regenerate" }),
		);
		expectSingleRoot(root);
		// The paper is painted from the `--pa-*` properties only: a colour
		// utility on the root would read the app tokens it remaps, in either
		// colour mode.
		expect(root.className).not.toMatch(/(^|\s)(bg|text)-/);
		expect(themeStylesheets()).toHaveLength(1);
		expect(fixtures.api.getThemeTokens).toHaveBeenCalledWith({
			projectId: "proj-1",
			documentId: "doc-1",
		});
	});

	it("themes a project guest's Main too, still without the tabs", async () => {
		fixtures.isGuest = true;
		renderPage();
		await pageReady();

		const root = await findThemeRoot();
		expect(root.style.getPropertyValue("--pa-surface")).toBe(
			NEUTRAL_THEME.surface,
		);
		expect(root.style.getPropertyValue("--pa-ink")).toBe(NEUTRAL_THEME.ink);
		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
		expect(fixtures.api.getAnalysis).not.toHaveBeenCalled();
		expect(fixtures.api.getThemeTokens).toHaveBeenCalledWith({
			projectId: "proj-1",
			documentId: "doc-1",
		});
	});

	it("leaves a Business Case unthemed and never asks for its tokens", async () => {
		fixtures.document = proposal({ type: "BUSINESS_CASE" });
		renderPage();
		await pageReady();

		expect(themeRoot()).toBeNull();
		expect(fixtures.editor.lastProps.contentThemeProps).toBeUndefined();
		expect(fixtures.api.getThemeTokens).not.toHaveBeenCalled();
	});

	it("leaves the page unthemed with the gate off and never asks for the tokens", async () => {
		fixtures.flags.PROPOSAL_ARTIFACT = false;
		renderPage();
		await pageReady();

		expect(themeRoot()).toBeNull();
		expect(fixtures.api.getThemeTokens).not.toHaveBeenCalled();
	});

	it("turns the theme off when the server refuses the document", async () => {
		fixtures.api.getThemeTokens.mockRejectedValue(
			Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
		);
		renderPage();
		await pageReady();

		await waitFor(() => expect(themeRoot()).toBeNull());
		expect(fixtures.editor.lastProps.contentThemeProps).toBeUndefined();
		// The rest of the member's page is unchanged.
		expect(screen.getByRole("tablist")).toBeInTheDocument();
	});

	it("wears the neutral paint while the tokens are pending, then the document's own", async () => {
		let answer: (value: unknown) => void = () => {};
		fixtures.api.getThemeTokens.mockImplementation(
			() =>
				new Promise((resolveTokens) => {
					answer = resolveTokens;
				}),
		);
		renderPage();
		await pageReady();

		const pending = await findThemeRoot();
		expect(pending.style.getPropertyValue("--pa-primary")).toBe(
			NEUTRAL_THEME.primary,
		);
		expect(pending.style.getPropertyValue("--pa-surface")).toBe(
			NEUTRAL_THEME.surface,
		);

		await act(async () => {
			answer(themeTokens(STYLE_PRIMARY));
		});

		await waitFor(() =>
			expect(themeRoot()?.style.getPropertyValue("--pa-primary")).toBe(
				STYLE_PRIMARY,
			),
		);
		expect(themeRoot()?.style.getPropertyValue("--pa-heading")).toBe(
			STYLE_PRIMARY,
		);
	});

	it("themes the live pane's document while a run writes, with the pane as the desk", async () => {
		fixtures.document = proposal({
			status: "GENERATING",
			generationStartedAt: new Date().toISOString(),
			generationProgress: 40,
			liveContent: "## Scope\n\nFirst finished section.",
		});
		renderPage();
		await pageReady();

		const live = screen.getByTestId("proposal-live-sections");
		const heading = await within(live).findByRole("heading", {
			level: 2,
			name: "Scope",
		});
		const root = heading.closest<HTMLElement>(THEME_ROOT);
		expect(root).not.toBeNull();
		expect(live).toContainElement(root);
		expect(live).not.toHaveClass("proposal-theme");
		expect(root?.style.getPropertyValue("--pa-surface")).toBe(
			NEUTRAL_THEME.surface,
		);
		expect(root).not.toContainElement(
			within(live).getByText(pageCopy.live.writingNext),
		);
		expectSingleRoot(root as HTMLElement);
		// The pane and the hidden editor both render a root; one stylesheet.
		expect(themeStylesheets()).toHaveLength(1);
	});

	describe("the editor stylesheet", () => {
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

		it("scopes nothing to a Proposal: the theme replaced its own typography rules", () => {
			expect(css).not.toMatch(/\.proposal-(artifact|theme)\b/);
		});

		it("leaves every other editor on the shared rules", () => {
			const { container } = render(
				<div className="p-10 tiptap">
					<h1>Title</h1>
					<h2>Section</h2>
					<p>Body</p>
				</div>,
			);
			const tiptap = container.querySelector(".tiptap") as HTMLElement;

			expect(getComputedStyle(tiptap).fontSize).toBe("");
			expect(getComputedStyle(tiptap).maxWidth).toBe("");
			expect(
				getComputedStyle(tiptap.querySelector("h1") as HTMLElement)
					.fontSize,
			).toBe("1.4rem");
			expect(
				getComputedStyle(tiptap.querySelector("h2") as HTMLElement)
					.fontSize,
			).toBe("1.2rem");
		});
	});
});
