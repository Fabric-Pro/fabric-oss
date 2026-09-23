/**
 * A document's auto-refresh control warns when a refresh has nothing to read
 * (Fizzy #1930). The warning sits in the settings popover — where the schedule
 * is configured, and only once it is on — and never disables anything.
 *
 * The harness is the one `DocumentAutoRefreshToggle.test.tsx` uses: a real
 * `QueryClient` and the control's own client calls stubbed. The gate is driven
 * per test and the banner renders through its real component.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAutoRefreshMock, setAutoRefreshMock } = vi.hoisted(() => ({
	getAutoRefreshMock: vi.fn(),
	setAutoRefreshMock: vi.fn(),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
}));

vi.mock("next-intl", () => ({
	useTranslations: (namespace?: string) => (key: string) =>
		namespace ? `${namespace}.${key}` : key,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@shared/hooks/use-tenant-query", () => ({
	useTenantContext: () => ({
		organizationId: null,
		isOrgContext: false,
		queryKeyPrefix: ["tenant", null],
	}),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			documents: {
				getAutoRefresh: getAutoRefreshMock,
				setAutoRefresh: setAutoRefreshMock,
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documents: {
				get: { queryKey: () => ["document", "doc-1"] },
				versions: {
					list: { queryKey: () => ["document", "doc-1", "versions"] },
				},
			},
		},
	},
}));

const gateRef = { current: null as CapabilityGateSelection | null };
vi.mock(
	"@saas/projects/components/capability-gates/useCapabilityGates",
	() => ({
		useCapabilityGate: (key: string) =>
			key === "documents.auto-refresh" && gateRef.current
				? gateRef.current
				: { gate: null, view: null, blocked: false },
		useCapabilityGates: () => ({
			projectId: "project-1",
			suppress: vi.fn(),
			linkFor: () => ({ href: "/app/example-org/projects/project-1" }),
			codebaseRetryFor: () => undefined,
			codebaseRetrying: false,
		}),
		SNOOZE_DURATIONS: ["session", "1d", "7d", "30d", "forever"] as const,
	}),
);

import type { CapabilityGateSelection } from "@saas/projects/components/capability-gates/useCapabilityGates";
import { DocumentAutoRefreshToggle } from "../DocumentAutoRefreshToggle";

const NOTHING_TO_READ: CapabilityGateSelection = {
	gate: null,
	view: {
		capabilityKey: "documents.auto-refresh",
		state: "WARNING",
		reasonKey: "documents.refresh-nothing-to-read",
		tone: "warning",
		title: "reason.documents.refresh-nothing-to-read.title",
		body: "reason.documents.refresh-nothing-to-read.body",
		params: { dependency: "a source a refresh can read" },
		ctaLabel: "remedy.addContext",
		ctaKind: "navigate",
		ctaTarget: "context",
		blocksAction: false,
		dismissible: true,
		retry: {
			supported: false,
			permitted: false,
			available: false,
			targetId: null,
		},
	},
	blocked: false,
};

function settings(overrides: Record<string, unknown> = {}) {
	return {
		enabled: false,
		cadence: "BIWEEKLY",
		autoApply: false,
		lastRefreshedAt: null,
		lastRefreshStatus: null,
		lastRefreshSummary: null,
		lastAttemptAt: null,
		pending: null,
		...overrides,
	};
}

function renderToggle() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	function wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);
	}
	return render(
		<DocumentAutoRefreshToggle documentId="doc-1" projectId="project-1" />,
		{ wrapper },
	);
}

beforeEach(() => {
	gateRef.current = null;
	getAutoRefreshMock.mockReset();
	setAutoRefreshMock.mockReset();
	getAutoRefreshMock.mockResolvedValue(settings({ enabled: true }));
});

describe("DocumentAutoRefreshToggle — what a refresh can read", () => {
	it("warns inside the settings popover, with the way to add context", async () => {
		gateRef.current = NOTHING_TO_READ;
		const user = userEvent.setup();
		renderToggle();

		await user.click(
			await screen.findByRole("button", {
				name: "Auto-refresh settings — check what it can read",
			}),
		);

		const banner = await screen.findByRole("status");
		expect(banner).toHaveTextContent(
			"projects.capabilityGates.reason.documents.refresh-nothing-to-read.title",
		);
		expect(
			within(banner).getByRole("link", {
				name: "projects.capabilityGates.remedy.addContext",
			}),
		).toHaveAttribute("href", "/app/example-org/projects/project-1");
		// Beside the settings it is about, not instead of them.
		expect(
			screen.getByRole("combobox", { name: "Auto-refresh cadence" }),
		).toBeEnabled();
	});

	it("never disables the toggle — a warning is not a block", async () => {
		gateRef.current = NOTHING_TO_READ;
		renderToggle();

		expect(
			await screen.findByRole("button", {
				name: "Turn off scheduled auto-refresh",
			}),
		).toBeEnabled();
	});

	it("keeps the warning off the masthead until refresh is on", async () => {
		// Not a page-wide banner on every document: someone who has not
		// scheduled a refresh has nothing to be warned about.
		gateRef.current = NOTHING_TO_READ;
		getAutoRefreshMock.mockResolvedValue(settings({ enabled: false }));
		renderToggle();

		await waitFor(() =>
			expect(
				screen.getByRole("button", {
					name: "Turn on scheduled auto-refresh",
				}),
			).toBeEnabled(),
		);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /auto-refresh settings/i }),
		).not.toBeInTheDocument();
	});

	it("offers dismissal from inside the popover without closing it", async () => {
		gateRef.current = NOTHING_TO_READ;
		const user = userEvent.setup();
		renderToggle();

		await user.click(
			await screen.findByRole("button", {
				name: "Auto-refresh settings — check what it can read",
			}),
		);
		const banner = await screen.findByRole("status");
		await user.click(
			within(banner).getByRole("button", {
				name: "projects.capabilityGates.dismiss.action",
			}),
		);

		expect(
			await screen.findByRole("menuitem", {
				name: "projects.capabilityGates.dismiss.session",
			}),
		).toBeInTheDocument();
		// The open menu is modal, so it hides the rest of the page from the
		// accessibility tree; the popover is still mounted beneath it.
		expect(document.getElementById("auto-refresh-cadence")).not.toBeNull();
		expect(banner).toBeInTheDocument();
	});

	it("shows nothing extra when the refresh has something to read", async () => {
		const user = userEvent.setup();
		renderToggle();

		await user.click(
			await screen.findByRole("button", {
				name: "Auto-refresh settings",
			}),
		);
		await screen.findByRole("combobox", { name: "Auto-refresh cadence" });
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
