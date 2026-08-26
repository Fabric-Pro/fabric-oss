/**
 * Component tests for the new `project_context_added_during_wizard`
 * telemetry event (spec
 * `2026-05-23-unified-context-uploader-wizard` §9.2, tasks.md Group 11.4).
 *
 * Spec:
 *  - fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §9.2
 *  - fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md
 *    Group 11.4
 *
 * Scope:
 *  1. URL (Link) submit success fires exactly one
 *     `project_context_added_during_wizard` event when the dialog is
 *     mounted with `surface="wizard"`. Payload: `{surface, contextType}`.
 *  2. The same URL submit fires the event with `surface="post-creation"`
 *     when no `surface` prop is passed (default branch).
 *  3. INTEGRATION rows: Teams onSuccess success carries
 *     `integrationKind: "TEAMS"`.
 *  4. The legacy `project_context_url_added` event still fires (so the
 *     two pipelines stay populated side-by-side and the URL Context
 *     Sources spec's gate is unaffected).
 *  5. Failure paths (processLink throws) emit ZERO
 *     `project_context_added_during_wizard` events.
 *
 * The url-tab test already covers the URL form submit shape end-to-end;
 * this file pins the new event's payload contract specifically.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
	if (!HTMLElement.prototype.hasPointerCapture) {
		HTMLElement.prototype.hasPointerCapture = (() => false) as never;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────

const {
	processLinkMock,
	getUserSearchProvidersMock,
	contextsListMock,
	mcpConfigsListMock,
	trackEventMock,
} = vi.hoisted(() => ({
	processLinkMock: vi.fn(),
	getUserSearchProvidersMock: vi.fn(),
	contextsListMock: vi.fn(),
	mcpConfigsListMock: vi.fn(),
	trackEventMock: vi.fn(),
}));

// The dialog reads PROJECT_READINESS to decide whether a link source has to be
// classified before it is saved (Fizzy #2165). Every assertion in this file
// predates that field and describes the flag-OFF behaviour, which must stay
// byte-identical to what shipped before it — so this mock is the regression
// guard, not a convenience.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				processLink: (input: unknown) => processLinkMock(input),
				list: (input: unknown) => contextsListMock(input),
				createUploadUrl: vi.fn(),
				processFile: vi.fn(),
			},
		},
		searchProviders: {
			getUserProviders: () => getUserSearchProvidersMock(),
			getOrganizationProviders: vi.fn(),
		},
		mcp: {
			configs: {
				list: (input: unknown) => mcpConfigsListMock(input),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryKey: (args: { input: unknown }) => [
						"projects.contexts.list",
						args.input,
					],
				},
				create: {
					mutationOptions: ({
						onSuccess,
						onError,
					}: {
						onSuccess?: () => void;
						onError?: (err: { message: string }) => void;
					}) => ({
						mutationFn: vi.fn(),
						onSuccess,
						onError,
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
		organizationId: null as string | null,
		organizationSlug: null as string | null,
		basePath: "/app",
	}),
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (path: string) => path,
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

// Replace the Notion / Slack child dialogs with inert null renders — only
// the Teams selector is exercised below and it uses a button to drive the
// onSuccess callback so we can read the resulting event payload.
vi.mock("../NotionResourceBrowser", () => ({
	NotionResourceBrowser: () => null,
}));
vi.mock("../SlackChannelSelectorDialog", () => ({
	SlackChannelSelectorDialog: () => null,
}));
// Render a real test-only Teams selector whose onSuccess is callable from
// the test via a button click. The actual dialog's onSuccess fires after a
// successful selection in production; emulating that contract via a button
// keeps the test focussed on the telemetry payload contract, not on the
// internal selection UI which has its own coverage.
vi.mock("../TeamsChatSelectorDialog", () => ({
	TeamsChatSelectorDialog: ({
		open,
		onSuccess,
	}: {
		projectId: string;
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onSuccess?: () => void;
	}) =>
		open ? (
			<button
				type="button"
				data-testid="teams-mock-success"
				onClick={() => onSuccess?.()}
			>
				Confirm Teams selection
			</button>
		) : null,
}));
vi.mock("../GoogleDocsSelectorDialog", () => ({
	GoogleDocsSelectorDialog: () => null,
}));

import { ContextUploaderDialog } from "../ContextUploaderDialog";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function getTabTrigger(id: string): HTMLElement {
	const el = document.getElementById(`context-tab-${id}`);
	if (!el) {
		throw new Error(`Tab trigger #context-tab-${id} not found`);
	}
	return el;
}

const CONFIGURED_ROWS = [
	{
		id: "row_firecrawl",
		providerName: "firecrawl",
		endpoint: null,
		isDefault: true,
		priority: 0,
		lastUsedAt: null,
		searchesCount: 0,
		totalCost: 0,
		enabled: true,
		maskedApiKey: "***-1234",
	},
];

// ── Tests ────────────────────────────────────────────────────────────────

describe("ContextUploaderDialog — project_context_added_during_wizard", () => {
	beforeEach(() => {
		processLinkMock.mockReset();
		getUserSearchProvidersMock.mockReset();
		contextsListMock.mockReset();
		mcpConfigsListMock.mockReset();
		trackEventMock.mockReset();
		contextsListMock.mockResolvedValue({ contexts: [] });
		mcpConfigsListMock.mockResolvedValue([]);
	});

	it("fires with surface='wizard' + contextType='LINK' on URL submit success when surface='wizard'", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		processLinkMock.mockResolvedValue(undefined);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_wizard"
				open
				onOpenChange={vi.fn()}
				surface="wizard"
			/>,
		);

		await user.click(getTabTrigger("link"));
		const urlInput = await screen.findByLabelText("URL");
		await user.type(urlInput, "https://example.com/single-article");
		urlInput.blur();

		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		// The legacy event must still fire (spec §9.1 documents the two
		// pipelines run side-by-side).
		await waitFor(() => {
			expect(processLinkMock).toHaveBeenCalledTimes(1);
		});
		expect(trackEventMock).toHaveBeenCalledWith(
			"project_context_url_added",
			expect.objectContaining({
				scope: "SINGLE_PAGE",
				refreshMode: "ONCE",
				projectId: "proj_wizard",
			}),
		);

		// New event fires exactly once with the wizard surface tag and the
		// spec-defined `contextType` enum value.
		const wizardEventCalls = trackEventMock.mock.calls.filter(
			(call) => call[0] === "project_context_added_during_wizard",
		);
		expect(wizardEventCalls).toHaveLength(1);
		expect(wizardEventCalls[0][1]).toEqual({
			surface: "wizard",
			contextType: "LINK",
		});
	});

	it("defaults surface to 'post-creation' when the prop is omitted", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		processLinkMock.mockResolvedValue(undefined);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_settings"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		const urlInput = await screen.findByLabelText("URL");
		await user.type(urlInput, "https://example.com/single-article");
		urlInput.blur();

		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		await waitFor(() => {
			expect(processLinkMock).toHaveBeenCalledTimes(1);
		});

		const wizardEventCalls = trackEventMock.mock.calls.filter(
			(call) => call[0] === "project_context_added_during_wizard",
		);
		expect(wizardEventCalls).toHaveLength(1);
		expect(wizardEventCalls[0][1]).toEqual({
			surface: "post-creation",
			contextType: "LINK",
		});
	});

	it("emits zero added-during-wizard events when processLink throws (failure path)", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		// Submit fails with a generic server error — should NOT fire the
		// new event. The legacy `project_context_url_added` also skips
		// because it lives inside the success branch.
		processLinkMock.mockRejectedValueOnce(new Error("server boom"));
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_failure"
				open
				onOpenChange={vi.fn()}
				surface="wizard"
			/>,
		);

		await user.click(getTabTrigger("link"));
		const urlInput = await screen.findByLabelText("URL");
		await user.type(urlInput, "https://example.com/will-fail");
		urlInput.blur();

		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		await waitFor(() => {
			expect(processLinkMock).toHaveBeenCalledTimes(1);
		});

		// Neither pipeline should have emitted on failure.
		const wizardEventCalls = trackEventMock.mock.calls.filter(
			(call) => call[0] === "project_context_added_during_wizard",
		);
		expect(wizardEventCalls).toHaveLength(0);
		const legacyEventCalls = trackEventMock.mock.calls.filter(
			(call) => call[0] === "project_context_url_added",
		);
		expect(legacyEventCalls).toHaveLength(0);
	});

	it("fires with contextType='INTEGRATION' + integrationKind='TEAMS' on Teams onSuccess", async () => {
		// Teams tab is enabled by default; we just open the tab, click the
		// "Connect Teams" / inner CTA which opens the mocked child dialog,
		// then click the mocked success button to trigger the dialog's
		// onSuccess callback. No need to mock the integration list here —
		// the parent dialog always renders a "Connect Teams Chats" CTA
		// that opens the child dialog regardless of integration state.
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_teams"
				open
				onOpenChange={vi.fn()}
				surface="wizard"
			/>,
		);

		await user.click(getTabTrigger("teams"));

		// Find and click the "Select Teams Chats" CTA inside the Teams
		// tab — that's the button that opens the (mocked) child dialog by
		// setting teamsDialogOpen=true.
		const teamsCta = await screen.findByRole("button", {
			name: /Select Teams Chats/i,
		});
		await user.click(teamsCta);

		// Mocked child dialog now renders its testid button — click it to
		// invoke the parent's onSuccess callback. Radix sets
		// `pointer-events: none` on the body while a dialog is open so
		// nested mocked children inside the parent dialog inherit it;
		// `pointerEventsCheck: 0` opts out for this assertion only — we
		// are not testing pointer-event chains here, only that the
		// parent's onSuccess handler fires the new event with the
		// `integrationKind: "TEAMS"` granular payload.
		const successButton = await screen.findByTestId("teams-mock-success");
		const noPointerCheck = userEvent.setup({ pointerEventsCheck: 0 });
		await noPointerCheck.click(successButton);

		const wizardEventCalls = trackEventMock.mock.calls.filter(
			(call) => call[0] === "project_context_added_during_wizard",
		);
		expect(wizardEventCalls).toHaveLength(1);
		expect(wizardEventCalls[0][1]).toEqual({
			surface: "wizard",
			contextType: "INTEGRATION",
			integrationKind: "TEAMS",
		});
	});
});
