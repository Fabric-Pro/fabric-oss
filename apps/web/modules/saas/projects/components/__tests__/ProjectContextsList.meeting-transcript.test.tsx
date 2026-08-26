/**
 * Meeting-transcript surface tests for ProjectContextsList
 * (spec 2026-06-23-meeting-transcript-viewer §5.5, §12.3).
 *
 * The Context tab's Meeting Transcripts group is the entry point to the new
 * read-only reader. This file pins:
 *   1. The transcript row's "View" action links to the correct content-viewer
 *      href for `context.id` — personal vs org variants (AC2 entry point).
 *   2. The empty state renders when there are no transcripts and its CTA
 *      deep-links to `?tab=settings` — personal vs org variants (AC4).
 *   3. A list-load error renders inline within the contexts list (the meetings
 *      group shares this single query) without crashing the tab (AC5).
 *
 * Mirrors the sibling `ProjectContextsList.link-card.test.tsx` mocking style.
 * The View action lives inside a doubly-collapsible group (meetings group →
 * per-meeting sub-group → row dropdown), so the happy-path test expands both
 * levels and opens the row menu before asserting the link.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.releasePointerCapture === "undefined") {
		Element.prototype.releasePointerCapture = () => undefined;
	}
	if (typeof Element.prototype.setPointerCapture === "undefined") {
		Element.prototype.setPointerCapture = () => undefined;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────

const {
	contextsListMock,
	deleteMock,
	downloadUrlMock,
	trackEventMock,
	heroCtx,
	orgCtx,
} = vi.hoisted(() => ({
	contextsListMock: vi.fn(),
	deleteMock: vi.fn(),
	downloadUrlMock: vi.fn(),
	trackEventMock: vi.fn(),
	// Mutable holder so individual tests can flip between personal/org tenant
	// without re-mocking the module.
	// The hero renders the readiness counters in its `aside`. It stays stubbed
	// out for every other test in this file (it swamps text queries); the
	// counter tests switch it on for themselves.
	heroCtx: { renderAside: false },
	orgCtx: {
		current: {
			organizationId: null as string | null,
			organizationSlug: null as string | null,
			basePath: "/app",
		},
	},
}));

// Context Source Type Labeling (#1888) is flag-gated; pinned OFF here so
// the menus keep exactly the legacy items these tests assert.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { contexts: {} } },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryOptions: ({
						input,
						refetchInterval,
					}: {
						input: unknown;
						refetchInterval?: unknown;
					}) => ({
						queryKey: ["projects.contexts.list", input] as const,
						queryFn: () => contextsListMock(input),
						refetchInterval,
					}),
					queryKey: ({ input }: { input: unknown }) => [
						"projects.contexts.list",
						input,
					],
				},
				delete: {
					call: (i: unknown) => deleteMock(i),
				},
				createDownloadUrl: {
					call: (i: unknown) => downloadUrlMock(i),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgCtx.current,
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

// `next-intl`'s default global mock returns a plain function from
// `useTranslations`. The transcript-row delete tooltip needs `.raw(...)`.
vi.mock("next-intl", () => {
	function makeT() {
		const t = (key: string) => key;
		(t as unknown as { raw: (k: string) => unknown }).raw = (
			k: string,
		) => ({
			label: `${k}.label`,
			warning: `${k}.warning`,
		});
		return t;
	}
	return {
		useTranslations: () => makeT(),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...rest
	}: {
		children: React.ReactNode;
		href: string;
	} & Record<string, unknown>) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

vi.mock("../ContextUploaderDialog", () => ({
	ContextUploaderDialog: () => null,
}));
vi.mock("../DownloadAllContextsButton", () => ({
	DownloadAllContextsButton: () => null,
}));
vi.mock("../ProjectSectionHero", () => ({
	ProjectSectionHero: ({ aside }: { aside?: React.ReactNode }) =>
		heroCtx.renderAside ? aside : null,
}));

import { ProjectContextsList } from "../ProjectContextsList";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function makeTranscriptContext(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx_t1",
		type: "MEETING_TRANSCRIPT",
		extractionStatus: "COMPLETED",
		extractionError: null,
		createdAt: new Date("2026-06-10T16:30:00Z"),
		embeddedAt: new Date("2026-06-10T16:35:00Z"),
		metadata: {
			meetingId: "meeting-abc",
			meetingSubject: "Sprint planning",
			meetingDate: "2026-06-10T15:00:00Z",
			speakerNames: ["Alice", "Bob"],
			wasSummarized: false,
		},
		...overrides,
	};
}

/**
 * A non-transcript (LINK) context. The source renders the dedicated
 * `meeting-transcripts-empty` block ONLY inside the populated-list branch
 * (`contexts.length > 0`) when `transcriptGroups.length === 0` — i.e. the
 * project HAS contexts but none are meeting transcripts. With zero contexts of
 * any kind the component shows the generic "No context yet" empty state
 * instead, so the meetings-specific empty state requires at least one
 * non-transcript context present. (Shape mirrors
 * `ProjectContextsList.link-card.test.tsx`.)
 */
function makeLinkContext(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx_link_1",
		type: "LINK",
		sourceUrl: "https://example.com/docs",
		sourceTitle: "Example Docs",
		extractionStatus: "COMPLETED",
		extractionError: null,
		urlScope: "PATH_PREFIX",
		urlMaxPages: 100,
		urlRefreshMode: "ONCE",
		urlLastSyncedAt: new Date("2026-05-13T10:00:00Z"),
		createdAt: new Date("2026-05-12T10:00:00Z"),
		embeddedAt: null,
		metadata: { sourceTitle: "Example Docs" },
		...overrides,
	};
}

/** Expand the meetings top group, then the per-meeting sub-group, to reveal rows. */
async function expandToTranscriptRows(
	user: ReturnType<typeof userEvent.setup>,
) {
	await user.click(await screen.findByText("Meeting Transcripts"));
	// The per-meeting sub-group header carries the meeting subject.
	await user.click(await screen.findByText("Sprint planning"));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectContextsList — Meeting Transcript View action", () => {
	beforeEach(() => {
		heroCtx.renderAside = false;
		contextsListMock.mockReset();
		deleteMock.mockReset();
		downloadUrlMock.mockReset();
		trackEventMock.mockReset();
		orgCtx.current = {
			organizationId: null,
			organizationSlug: null,
			basePath: "/app",
		};
	});

	it("renders a 'View' action linking to the PERSONAL content-viewer href with context.id", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeTranscriptContext()],
			total: 1,
			hasMore: false,
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandToTranscriptRows(user);
		// Open the transcript row's actions menu.
		await user.click(await screen.findByLabelText("More options"));

		const view = await screen.findByTestId("transcript-view-ctx_t1");
		expect(view).toHaveTextContent("View");
		expect(view).toHaveAttribute(
			"href",
			"/app/projects/proj_1/contexts/ctx_t1",
		);
	});

	it("renders the 'View' action linking to the ORG content-viewer href with the org slug", async () => {
		orgCtx.current = {
			organizationId: "org_1",
			organizationSlug: "acme",
			basePath: "/app/acme",
		};
		contextsListMock.mockResolvedValue({
			contexts: [makeTranscriptContext()],
			total: 1,
			hasMore: false,
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandToTranscriptRows(user);
		await user.click(await screen.findByLabelText("More options"));

		const view = await screen.findByTestId("transcript-view-ctx_t1");
		expect(view).toHaveAttribute(
			"href",
			"/app/acme/projects/proj_1/contexts/ctx_t1",
		);
	});

	it("uses context.id (= ProjectContext.id = ProjectMeetingTranscript.contextId) as the route key", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeTranscriptContext({ id: "ctx_unique_99" })],
			total: 1,
			hasMore: false,
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandToTranscriptRows(user);
		await user.click(await screen.findByLabelText("More options"));

		expect(
			await screen.findByTestId("transcript-view-ctx_unique_99"),
		).toHaveAttribute(
			"href",
			"/app/projects/proj_1/contexts/ctx_unique_99",
		);
	});
});

describe("ProjectContextsList — Meeting Transcript empty state (AC4, spec §12.3)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		orgCtx.current = {
			organizationId: null,
			organizationSlug: null,
			basePath: "/app",
		};
	});

	it("renders the empty state with a CTA deep-linking to ?tab=settings (personal)", async () => {
		// At least one non-transcript context so the populated-list branch
		// renders the meetings-specific empty state (no transcript groups).
		contextsListMock.mockResolvedValue({
			contexts: [makeLinkContext()],
			total: 1,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		const empty = await screen.findByTestId("meeting-transcripts-empty");
		expect(empty).toHaveTextContent("No meeting transcripts yet");

		const cta = within(empty).getByTestId("meeting-transcripts-empty-cta");
		expect(cta).toHaveAttribute(
			"href",
			"/app/projects/proj_1?tab=settings",
		);
	});

	it("renders the empty-state CTA with the org-scoped ?tab=settings href (org)", async () => {
		orgCtx.current = {
			organizationId: "org_1",
			organizationSlug: "acme",
			basePath: "/app/acme",
		};
		contextsListMock.mockResolvedValue({
			contexts: [makeLinkContext()],
			total: 1,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		const cta = await screen.findByTestId("meeting-transcripts-empty-cta");
		expect(cta).toHaveAttribute(
			"href",
			"/app/acme/projects/proj_1?tab=settings",
		);
	});

	it("does NOT render the empty state when at least one transcript exists", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeTranscriptContext()],
			total: 1,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		// Wait for data to settle: the meetings group header appears.
		await screen.findByText("Meeting Transcripts");
		expect(
			screen.queryByTestId("meeting-transcripts-empty"),
		).not.toBeInTheDocument();
	});
});

describe("ProjectContextsList — inline list-load error (AC5, spec §12.3)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		orgCtx.current = {
			organizationId: null,
			organizationSlug: null,
			basePath: "/app",
		};
	});

	it("renders the inline error card (role=alert) instead of crashing when the list query fails", async () => {
		contextsListMock.mockRejectedValue(new Error("network down"));
		wrap(<ProjectContextsList projectId="proj_1" />);

		const errorCard = await screen.findByTestId("contexts-list-error");
		await waitFor(() => {
			expect(errorCard).toHaveTextContent(/Failed to load contexts/);
		});
		expect(errorCard).toHaveAttribute("role", "alert");
		// The error is contained — the empty state / groups are not also rendered.
		expect(
			screen.queryByTestId("meeting-transcripts-empty"),
		).not.toBeInTheDocument();
	});
});

/**
 * #2170 AC2/FR4 — an imported personal meeting is retrievable and visible
 * alongside every other context source.
 *
 * The import writes a `MEETING_TRANSCRIPT` row in the team format precisely so
 * this needs no new UI. That is a claim about this component's behaviour, not a
 * self-evident fact: the grouping keys off `metadata.meetingId`, and an
 * imported row reaches it through a different code path with an extra `origin`
 * marker. Asserted rather than assumed.
 */
describe("ProjectContextsList — imported personal meetings (#2170)", () => {
	beforeEach(() => {
		heroCtx.renderAside = false;
		contextsListMock.mockReset();
		deleteMock.mockReset();
		downloadUrlMock.mockReset();
		trackEventMock.mockReset();
		orgCtx.current = {
			organizationId: null,
			organizationSlug: null,
			basePath: "/app",
		};
	});

	function makeImportedContext(overrides: Record<string, unknown> = {}) {
		return makeTranscriptContext({
			id: "ctx_imported",
			metadata: {
				provider: "microsoft-teams",
				origin: "personal-import",
				meetingId: "meeting-abc",
				transcriptId: "transcript-1",
				joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
				meetingSubject: "Sprint planning",
				meetingDate: "2026-06-10T15:00:00Z",
				speakerNames: ["Alice", "Bob"],
				wasSummarized: false,
			},
			...overrides,
		});
	}

	it("lists an imported meeting in the Meeting Transcripts group", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeImportedContext()],
			total: 1,
			hasMore: false,
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandToTranscriptRows(user);
		await user.click(await screen.findByLabelText("More options"));

		expect(
			await screen.findByTestId("transcript-view-ctx_imported"),
		).toHaveAttribute("href", "/app/projects/proj_1/contexts/ctx_imported");
	});

	// An imported meeting and a synced one for the same occurrence are the same
	// meeting; splitting them into two groups would read as two meetings.
	it("groups it with a synced transcript for the same meeting", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeImportedContext(), makeTranscriptContext()],
			total: 2,
			hasMore: false,
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandToTranscriptRows(user);

		expect(screen.getAllByText("Sprint planning")).toHaveLength(1);
	});

	// "Synced from Microsoft Teams" over a meeting somebody added by hand hides
	// the only thing that distinguishes it: a teammate chose to share it.
	it("does not describe an imported meeting as synced", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeImportedContext()],
			total: 1,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		expect(
			await screen.findByText("Added from a personal calendar"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Synced from Microsoft Teams"),
		).not.toBeInTheDocument();
	});

	it("counts the imported ones when the group holds both", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeImportedContext(), makeTranscriptContext()],
			total: 2,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		expect(
			await screen.findByText(
				"Synced from Microsoft Teams · 1 added from a personal calendar",
			),
		).toBeInTheDocument();
	});

	it("leaves a wholly synced group's wording alone", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeTranscriptContext()],
			total: 1,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		expect(
			await screen.findByText("Synced from Microsoft Teams"),
		).toBeInTheDocument();
	});
});

/**
 * Staging, 18 Aug 2026: all 49 transcripts in a project showed a red "Failed"
 * because one embedding deployment was misconfigured. Every one of them was
 * stored in full and opened fine — extraction had succeeded, and only search
 * indexing had not. `extractionStatus` is written by both steps, so the badge
 * has to read the evidence rather than the field alone.
 */
describe("ProjectContextsList — a row that failed to index but has its content", () => {
	beforeEach(() => {
		heroCtx.renderAside = false;
		contextsListMock.mockReset();
		deleteMock.mockReset();
		downloadUrlMock.mockReset();
		trackEventMock.mockReset();
		orgCtx.current = {
			organizationId: null,
			organizationSlug: null,
			basePath: "/app",
		};
	});

	it("says the content is not searchable, not that it failed", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeTranscriptContext({
					extractionStatus: "FAILED",
					extractionError:
						"Search indexing failed: The API deployment for this resource does not exist.",
					embeddedAt: null,
					content: "Alice: morning\nBob: morning",
				}),
			],
			total: 1,
			hasMore: false,
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandToTranscriptRows(user);

		expect(await screen.findByText("Not searchable")).toBeInTheDocument();
		expect(screen.queryByText("Failed")).not.toBeInTheDocument();
	});

	// The shape written since the indexing-failure fix: extraction COMPLETED and
	// stays that way, with the reason recorded alongside it. The rows above are
	// the pre-fix shape, which is never backfilled and must keep rendering.
	it("says not searchable when a completed extraction failed to index", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeTranscriptContext({
					extractionStatus: "COMPLETED",
					extractionError:
						"Search indexing failed: The API deployment for this resource does not exist.",
					embeddedAt: null,
					content: "Alice: morning\nBob: morning",
				}),
			],
			total: 1,
			hasMore: false,
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandToTranscriptRows(user);

		expect(await screen.findByText("Not searchable")).toBeInTheDocument();
		expect(screen.queryByText("Failed")).not.toBeInTheDocument();
	});

	// A clean COMPLETED row carries no error and must stay unqualified.
	it("says nothing is wrong with a completed, indexed transcript", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeTranscriptContext({
					extractionStatus: "COMPLETED",
					extractionError: null,
					embeddedAt: new Date("2026-08-18T10:00:00Z"),
					content: "Alice: morning\nBob: morning",
				}),
			],
			total: 1,
			hasMore: false,
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandToTranscriptRows(user);

		expect(screen.queryByText("Not searchable")).not.toBeInTheDocument();
		expect(screen.queryByText("Failed")).not.toBeInTheDocument();
	});

	// A row with nothing in it really did fail to extract; that badge stays.
	it("still says failed when there is no content to show", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeTranscriptContext({
					extractionStatus: "FAILED",
					extractionError: "Transcript fetch returned nothing",
					embeddedAt: null,
					content: "",
				}),
			],
			total: 1,
			hasMore: false,
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandToTranscriptRows(user);

		expect(await screen.findByText("Failed")).toBeInTheDocument();
		expect(screen.queryByText("Not searchable")).not.toBeInTheDocument();
	});
});

/**
 * The indexing-status fix taught the transcript badge that a COMPLETED row
 * carrying an `extractionError` is stored-but-unsearchable. Two other readers
 * of the same rows were left on the old signal, and both now disagree with the
 * badge they sit next to.
 */
describe("ProjectContextsList — an indexing failure the rest of the page has to agree with", () => {
	beforeEach(() => {
		heroCtx.renderAside = false;
		contextsListMock.mockReset();
		deleteMock.mockReset();
		downloadUrlMock.mockReset();
		trackEventMock.mockReset();
		orgCtx.current = {
			organizationId: null,
			organizationSlug: null,
			basePath: "/app",
		};
	});

	// `url-source-crawl` stamps the parent LINK row COMPLETED and only THEN
	// embeds it, so an embedding failure lands on an already-completed row.
	// `LinkStatusRow` reads only `extractionStatus`, so it showed a green
	// "Indexed" over a source RAG cannot retrieve a single chunk from.
	it("does not call a LINK source indexed when its indexing failed", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeLinkContext({
					extractionStatus: "COMPLETED",
					extractionError:
						"Search indexing failed: The API deployment for this resource does not exist.",
					embeddedAt: null,
				}),
			],
			total: 1,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		expect(await screen.findByText("Example Docs")).toBeInTheDocument();
		expect(
			screen.queryByTestId("link-status-indexed"),
		).not.toBeInTheDocument();
	});

	it("still calls a genuinely indexed LINK source indexed", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeLinkContext({
					extractionStatus: "COMPLETED",
					extractionError: null,
					embeddedAt: new Date("2026-05-13T10:05:00Z"),
				}),
			],
			total: 1,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		expect(
			await screen.findByTestId("link-status-indexed"),
		).toBeInTheDocument();
	});

	// The readiness counters kept counting raw status, so a row whose own badge
	// says "Not searchable" was tallied under Ready — and Needs Care, the
	// counter whose entire job is surfacing rows that want attention, reported
	// nothing to attend to.
	it("counts an unsearchable row as needing care, not as ready", async () => {
		heroCtx.renderAside = true;
		contextsListMock.mockResolvedValue({
			contexts: [
				makeTranscriptContext({
					extractionStatus: "COMPLETED",
					extractionError:
						"Search indexing failed: The API deployment for this resource does not exist.",
					embeddedAt: null,
				}),
			],
			total: 1,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		const ready = await screen.findByTestId("context-readiness-ready");
		const needsCare = await screen.findByTestId("context-readiness-failed");
		expect(ready).toHaveTextContent("0");
		expect(needsCare).toHaveTextContent("1");
	});

	it("counts a healthy row as ready", async () => {
		heroCtx.renderAside = true;
		contextsListMock.mockResolvedValue({
			contexts: [makeTranscriptContext()],
			total: 1,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		const ready = await screen.findByTestId("context-readiness-ready");
		const needsCare = await screen.findByTestId("context-readiness-failed");
		expect(ready).toHaveTextContent("1");
		expect(needsCare).toHaveTextContent("0");
	});
});
