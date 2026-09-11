/**
 * A key minted from the CHECKLIST ROW stands the project's CLI prompt down
 * (Fizzy #2457, round 2).
 *
 * The regression this pins had a narrow door and a wide blast radius. Two
 * surfaces offer the same key — the prompt above the project, and the
 * "API Key for CLI" row inside the readiness checklist — and each mounts its
 * OWN issuing view, because that view holds the only copy of a secret the
 * server stores as a hash and neither surface may let the other's lifetime
 * decide its own. The prompt's suppression was state inside the prompt, set
 * from the callback of the prompt's view alone. Mint from the row instead and
 * nothing told it: the key-creation mutation does trigger a readiness refetch,
 * but the item behind `promptEligible` completes when a coding tool REACHES
 * Fabric rather than when a key exists, so the server's answer never moves and
 * the banner went on telling someone holding a fresh key that "No coding tool
 * is connected to Fabric yet".
 *
 * So this suite mounts the REAL provider, the REAL panel and the REAL prompt
 * together and drives the row's view end to end. Everything cheaper than that
 * — a mocked context, a called callback — would prove only that a flag flips,
 * and the defect was never in a flag: it was in which component held it. The
 * only stand-ins are the transport (`orpcClient`), the analytics sink, the
 * organization context and the tab gates.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
	for (const method of [
		"hasPointerCapture",
		"setPointerCapture",
		"releasePointerCapture",
		"scrollIntoView",
	] as const) {
		if (!HTMLElement.prototype[method]) {
			HTMLElement.prototype[method] = (() => undefined) as never;
		}
	}
});

const {
	readinessGetMock,
	markSeenMock,
	dismissCliNudgeMock,
	createKeyMock,
	trackEventMock,
} = vi.hoisted(() => ({
	readinessGetMock: vi.fn(),
	markSeenMock: vi.fn(),
	dismissCliNudgeMock: vi.fn(),
	createKeyMock: vi.fn(),
	trackEventMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			readiness: {
				get: (input: unknown) => readinessGetMock(input),
				markSeen: (input: unknown) => markSeenMock(input),
				dismissCliNudge: (input: unknown) => dismissCliNudgeMock(input),
			},
		},
		organizations: {
			apiKeys: { create: (input: unknown) => createKeyMock(input) },
		},
	},
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

const ORGANIZATION_ID = "org-hosting-the-project";
const ORGANIZATION_SLUG = "example-org";
const PROJECT_ID = "p1";
const PROJECT_NAME = "Checkout Rewrite";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: ORGANIZATION_ID,
		organizationSlug: ORGANIZATION_SLUG,
		basePath: `/app/${ORGANIZATION_SLUG}`,
	}),
}));

// Hoisted to a module constant for the reason the sibling suite gives: the real
// hook memoizes its return value so downstream `useMemo`s keep a stable
// identity, and a fresh object per render would model the opposite.
const GATES = { publishingSuiteEnabled: true };

vi.mock("@saas/projects/lib/project-tab-preferences", () => ({
	useProjectTabCustomization: () => ({ config: undefined, prefs: undefined }),
	useProjectTabGates: () => GATES,
	resolveProjectTabs: (tabs: readonly unknown[]) => tabs,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Resolve against the shipped catalogue, as the panel's other suites do: a row
// whose copy is missing must fail here rather than render its key.
vi.mock("next-intl", async () => {
	const { readFileSync } = await import("node:fs");
	const messages = JSON.parse(
		readFileSync("../../packages/i18n/translations/en.json", "utf8"),
	) as Record<string, unknown>;
	return {
		useTranslations: (namespace: string) => {
			const base = namespace
				.split(".")
				.reduce<unknown>(
					(node, part) => (node as Record<string, unknown>)?.[part],
					messages,
				);
			return (key: string, values?: Record<string, unknown>) => {
				const raw = key
					.split(".")
					.reduce<unknown>(
						(node, part) =>
							(node as Record<string, unknown>)?.[part],
						base,
					);
				if (typeof raw !== "string") {
					throw new Error(`missing message: ${namespace}.${key}`);
				}
				return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
					String(values?.[name] ?? `{${name}}`),
				);
			};
		},
	};
});

import { CliConnectionNudge } from "@saas/projects/components/cli-connection/CliConnectionNudge";
import { ProjectReadinessPanelSlot } from "../ProjectReadinessPanel";
import { ProjectReadinessProvider } from "../ProjectReadinessProvider";

/** The row, the prompt and the issuing view, each named as a reader finds it. */
const CLI_ITEM_NAME = "API Key for CLI";
const CLI_ACTION = "Connect CLI";
const PROMPT_LABEL = "CLI connection prompt";
const CREATE_KEY_LABEL = "Create the key";

/**
 * The funnel names, restated rather than imported.
 *
 * A dashboard joins on these strings, so a test that imported the constants
 * would keep passing through a silent rename that broke the funnel. The two
 * origins of one step are deliberately separate names, in the `cli.<surface>`
 * scheme the prompt's own three events already use.
 */
const CHECKLIST_KEY_ISSUED_EVENT = "cli.checklist.keyIssued";
const PROMPT_KEY_ISSUED_EVENT = "cli.prompt.keyIssued";

/**
 * The readiness payload, with the CLI row outstanding and the prompt eligible —
 * the state the acceptance example describes: gate on, project active, enough
 * context items, and a viewer whose organization role carries key creation.
 */
function readinessPayload() {
	return {
		enabled: true,
		projectName: PROJECT_NAME,
		level: "PARTIALLY_READY",
		phase: "DEVELOPMENT_EXECUTION",
		phaseSource: "set",
		completedCount: 1,
		totalCount: 26,
		canAct: true,
		suggestPhaseTransition: false,
		recentlyCompleted: [],
		attention: {
			changes: [],
			levelDropped: false,
			seenAt: null,
			// Null opens the panel on this view, which is where the row lives.
			autoExpandedAt: null,
		},
		items: [
			{
				key: "api-key-for-cli",
				category: "CONTEXT_AND_CONNECTIONS",
				i18nKey: "readiness.items.apiKeyForCli",
				ctaLabelKey: "readiness.cta.apiKeyForCli",
				needLevel: "SHOULD",
				isComplete: false,
				manualState: null,
				snoozeUntil: null,
				isVisible: true,
				isActiveGap: true,
				isInProgress: false,
				target: { kind: "tab", tab: "overview" },
			},
		],
		activeGaps: [] as unknown[],
		cliConnection: {
			organizationConnected: false,
			viewerCanCreateKey: true,
			viewerDismissed: false,
			// Unmoved by minting a key, which is the whole problem: the item
			// completes when a coding tool actually reaches Fabric.
			promptEligible: true,
		},
	};
}

function payloadWithGaps() {
	const payload = readinessPayload();
	payload.activeGaps = payload.items.filter((i) => i.isActiveGap);
	return payload;
}

/** The prompt as the DOM holds it — an open modal `aria-hidden`s the rest. */
const promptElement = () =>
	document.querySelector<HTMLElement>(
		`[role="alert"][aria-label="${PROMPT_LABEL}"]`,
	);

function mountProjectView() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<ProjectReadinessProvider projectId={PROJECT_ID}>
				{/* The two surfaces, in the places the project view puts them:
				    the panel from the route-group layout, the prompt from the
				    tabbed page beneath it. Both are descendants of the one
				    provider, which is what lets them share an answer. */}
				<ProjectReadinessPanelSlot />
				<CliConnectionNudge
					organizationId={ORGANIZATION_ID}
					organizationSlug={ORGANIZATION_SLUG}
					projectName={PROJECT_NAME}
				/>
			</ProjectReadinessProvider>
		</QueryClientProvider>,
	);
}

/** The `<li>` an item's name sits in, so one row's controls can be read alone. */
function rowFor(name: string): HTMLElement {
	const row = screen.getByRole("button", { name }).closest("li");
	if (!row) {
		throw new Error(`no row rendered for "${name}"`);
	}
	return row;
}

/** Mint a key from the CHECKLIST ROW — never from the prompt's own button. */
async function issueAKeyFromTheChecklistRow() {
	const user = userEvent.setup();
	mountProjectView();

	await screen.findByRole("alert", { name: PROMPT_LABEL });
	await user.click(
		within(rowFor(CLI_ITEM_NAME)).getByRole("button", {
			name: CLI_ACTION,
		}),
	);
	await user.click(
		await screen.findByRole("button", { name: CREATE_KEY_LABEL }),
	);
	await screen.findByTestId("connect-cli-configuration");
	return user;
}

beforeEach(() => {
	vi.clearAllMocks();
	readinessGetMock.mockImplementation(async () => payloadWithGaps());
	markSeenMock.mockResolvedValue({ ok: true });
	dismissCliNudgeMock.mockResolvedValue({ ok: true });
	createKeyMock.mockResolvedValue({
		id: "key-1",
		name: "Coding CLI (created from the connect prompt)",
		keyPrefix: "org_1a2b3c4d",
		rawKey: "org_1a2b3c4d_ZXhhbXBsZS1zZWNyZXQtdmFsdWU",
		scopes: ["mcp:read"],
		expiresAt: new Date("2026-12-09T00:00:00.000Z"),
		createdAt: new Date("2026-09-10T00:00:00.000Z"),
	});
});

describe("a key issued from the checklist row", () => {
	it("stands the project's CLI prompt down", async () => {
		await issueAKeyFromTheChecklistRow();

		// Gone from the DOM, not merely from the accessibility tree: the open
		// issuing view marks the rest of the document `aria-hidden`, so a role
		// query would report the prompt absent even where the defect is live.
		await waitFor(() => expect(promptElement()).not.toBeInTheDocument());
		// ...while the view holding the only copy of the secret is untouched.
		expect(
			screen.getByText("Connect Fabric to your coding tool"),
		).toBeInTheDocument();
	});

	it("stays down through the refetch the key creation triggers", async () => {
		await issueAKeyFromTheChecklistRow();

		// The provider re-reads readiness after any successful mutation, and
		// this is the read that used to put the prompt back: `promptEligible`
		// is still true, because the item completes on a coding tool reaching
		// Fabric rather than on a key existing.
		await waitFor(() =>
			expect(readinessGetMock.mock.calls.length).toBeGreaterThan(1),
		);
		expect(promptElement()).not.toBeInTheDocument();
	});

	it("records the checklist row's own leg of the funnel", async () => {
		await issueAKeyFromTheChecklistRow();

		expect(trackEventMock).toHaveBeenCalledWith(
			CHECKLIST_KEY_ISSUED_EVENT,
			{ projectId: PROJECT_ID },
		);
		// And not the prompt's. The two origins are the reason the issuing view
		// raises this fact without recording it, and a funnel that cannot tell
		// them apart cannot say which surface is doing the work.
		expect(trackEventMock).not.toHaveBeenCalledWith(
			PROMPT_KEY_ISSUED_EVENT,
			expect.anything(),
		);
	});

	it("keeps the offer on the row, because issuing is not connecting", async () => {
		await issueAKeyFromTheChecklistRow();

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: /^done$/i }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		// The reader may still have a configuration block to paste, and the row
		// is where the prompt's dismissal note sends people. Suppressing the
		// prompt must not take the checklist's copy of the offer away.
		expect(
			within(rowFor(CLI_ITEM_NAME)).getByRole("button", {
				name: CLI_ACTION,
			}),
		).toBeInTheDocument();
		expect(promptElement()).not.toBeInTheDocument();
	});
});
