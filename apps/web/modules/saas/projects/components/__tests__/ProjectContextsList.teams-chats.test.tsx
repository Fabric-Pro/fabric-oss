/**
 * Teams Chats per-viewer access indicator tests for ProjectContextsList
 * (Fizzy #2450).
 *
 * A linked Teams chat/channel is read under the VIEWING user's own
 * Microsoft Graph token, so a Graph 403 for one member doesn't mean the
 * context is broken for everyone — it means that member specifically can't
 * read it. Before this, nothing in the UI said so: the row rendered like a
 * healthy one no matter who was looking at it. This pins the per-viewer
 * indicator sourced from `integrations.teams.contextAccess`:
 *   1. A row the viewer can't read shows "Not readable by you".
 *   2. A row the viewer CAN read shows nothing extra.
 *   3. When the viewer's Microsoft account isn't connected at all
 *      (`connected: false`), nothing extra renders for any row — that's a
 *      different, out-of-scope experience.
 *
 * Mirrors the sibling `ProjectContextsList.meeting-transcript.test.tsx`
 * mocking style; the Teams Chats group is itself a collapsible group, so
 * tests expand it before asserting row content.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

const { contextsListMock, contextAccessMock, trackEventMock } = vi.hoisted(
	() => ({
		contextsListMock: vi.fn(),
		contextAccessMock: vi.fn(),
		trackEventMock: vi.fn(),
	}),
);

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
				delete: { call: vi.fn() },
				createDownloadUrl: { call: vi.fn() },
			},
		},
		integrations: {
			teams: {
				contextAccess: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: [
							"integrations.teams.contextAccess",
							input,
						] as const,
						queryFn: () => contextAccessMock(input),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

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
	ProjectSectionHero: () => null,
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

function makeTeamsChatContext(
	id: string,
	chatTopic: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		type: "INTEGRATION",
		extractionStatus: null,
		extractionError: null,
		embeddedAt: null,
		createdAt: new Date("2026-06-10T16:30:00Z"),
		metadata: {
			provider: "MICROSOFT_TEAMS",
			chatType: "chat",
			chatId: `chat-${id}`,
			chatTopic,
		},
		...overrides,
	};
}

async function expandTeamsChatsGroup(user: ReturnType<typeof userEvent.setup>) {
	await user.click(await screen.findByText("Teams Chats"));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectContextsList — Teams Chats per-viewer access (Fizzy #2450)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		contextAccessMock.mockReset();
		trackEventMock.mockReset();
		// Default: no access probe issues, so tests that don't care about it
		// don't need to stub a resolved value themselves.
		contextAccessMock.mockResolvedValue({ connected: true, contexts: [] });
	});

	it("shows 'Not readable by you' on a context the viewer can't read", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeTeamsChatContext("ctx_teams_1", "example-team")],
			total: 1,
			hasMore: false,
		});
		contextAccessMock.mockResolvedValue({
			connected: true,
			contexts: [
				{
					contextId: "ctx_teams_1",
					readable: false,
					error: 'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"UnknownError"}}',
				},
			],
		});

		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandTeamsChatsGroup(user);

		expect(
			await screen.findByText("Not readable by you"),
		).toBeInTheDocument();
	});

	it("shows nothing extra for a context the viewer CAN read", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeTeamsChatContext("ctx_teams_2", "example-team")],
			total: 1,
			hasMore: false,
		});
		contextAccessMock.mockResolvedValue({
			connected: true,
			contexts: [
				{ contextId: "ctx_teams_2", readable: true, error: null },
			],
		});

		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandTeamsChatsGroup(user);

		// Wait for the row itself, then assert the indicator never appears.
		await screen.findByText("example-team");
		expect(
			screen.queryByText("Not readable by you"),
		).not.toBeInTheDocument();
	});

	it("shows nothing extra for any row when the viewer's Microsoft account isn't connected", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeTeamsChatContext("ctx_teams_3", "example-team")],
			total: 1,
			hasMore: false,
		});
		// Account-wide not-connected — the procedure never reports per-row
		// failures in this case (contexts is always []).
		contextAccessMock.mockResolvedValue({ connected: false, contexts: [] });

		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		await expandTeamsChatsGroup(user);

		await screen.findByText("example-team");
		expect(
			screen.queryByText("Not readable by you"),
		).not.toBeInTheDocument();
	});
});
