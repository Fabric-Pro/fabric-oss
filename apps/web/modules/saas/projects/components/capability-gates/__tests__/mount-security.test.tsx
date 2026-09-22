/**
 * The security page's gate wiring (Fizzy #1930).
 *
 * The seam worth pinning is narrow: does the gate's verdict actually reach the
 * Scan button's `disabled`, and does an available gate leave the page exactly as
 * it is today. Standing up the real provider here is not possible — this page's
 * suites mock `@tanstack/react-query` wholesale, which is the same constraint
 * that made `useCapabilityGates` degrade under test rather than throw — so the
 * hook is mocked and the wiring is asserted directly.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityGateSelection } from "../useCapabilityGates";

const useQueryMock = vi.fn();
const useMutationMock = vi.fn();
const gateRef = { current: null as CapabilityGateSelection | null };
const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useMutation: (...args: unknown[]) => useMutationMock(...args),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const passthrough = {
		queryOptions: (opts: unknown) => opts,
		mutationOptions: (opts: unknown) => opts,
		key: () => ["k"],
	};
	return {
		orpc: {
			projects: {
				scan: {
					config: { get: passthrough },
					latest: passthrough,
					trigger: passthrough,
					cancel: passthrough,
					findings: { list: passthrough },
				},
			},
		},
	};
});

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: () => null,
}));

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string) => key;
		t.raw = () => "";
		return t;
	},
}));

// The gate itself, swapped per test. The banner reads the same hook, so one
// stub drives both halves of the wiring.
vi.mock("../../settings-tab-navigation", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../settings-tab-navigation")>()),
	navigateToProjectSettingsTab: navigateMock,
}));

vi.mock("../useCapabilityGates", async () => {
	// The real destination mapping: the banner owns its remedy links now
	// (Fizzy #1930), so this page renders them without supplying any.
	const { gateLinkFor } = await import("../gate-destinations");
	return {
		useCapabilityGate: () =>
			gateRef.current ?? {
				gate: null,
				view: null,
				blocked: false,
			},
		// `gates` and `restore` are read by the restore control this page also
		// mounts; `suppress` by the banner's dismiss menu. An empty map means
		// nothing has been dismissed, so the restore control renders nothing.
		useCapabilityGates: () => ({
			projectId: "proj-1",
			gates: new Map(),
			suppress: vi.fn(),
			restore: vi.fn(),
			isSessionDismissed: () => false,
			linkFor: (target: Parameters<typeof gateLinkFor>[0]) =>
				gateLinkFor(target, { projectId: "proj-1", basePath: "/app" }),
			codebaseRetryFor: () => undefined,
			codebaseRetrying: false,
		}),
		// The dismiss menu maps over this, so a mock that omitted it would fail
		// on the one state that renders the menu — a dismissible warning.
		SNOOZE_DURATIONS: ["session", "1d", "7d", "30d", "forever"] as const,
	};
});

vi.mock("../../security/ScanConfigCard", () => ({
	ScanConfigCard: () => <div data-testid="config-card" />,
}));
vi.mock("../../security/BranchScanStatusPanel", () => ({
	BranchScanStatusPanel: () => <div data-testid="branch-panel" />,
}));
vi.mock("../../security/ScanFindingsList", () => ({
	ScanFindingsList: () => <div data-testid="findings-list" />,
}));
vi.mock("../../security/ScanHistoryDialog", () => ({
	ScanHistoryDialog: () => null,
}));
vi.mock("../../security/ScanInfo", () => ({
	ScanPageInfoButton: () => null,
}));
vi.mock("@saas/shared/components/PageHeader", () => ({
	PageHeader: ({ actions }: { actions: React.ReactNode }) => (
		<div>{actions}</div>
	),
}));

import { SecurityAccessibilityPage } from "../../security/SecurityAccessibilityPage";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.setPointerCapture ??= () => {};
	HTMLElement.prototype.releasePointerCapture ??= () => {};
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
	gateRef.current = null;
	useQueryMock.mockReset();
	useMutationMock.mockReset();

	// A scanner is enabled and nothing is in flight, so the page's OWN reasons
	// to disable the button are all absent — anything observed here is the gate.
	useQueryMock.mockImplementation((opts: { refetchInterval?: unknown }) => {
		if (opts && typeof opts === "object" && "refetchInterval" in opts) {
			return { data: { scan: null }, isLoading: false, refetch: vi.fn() };
		}
		return {
			data: {
				config: {
					securityEnabled: true,
					accessibilityEnabled: false,
					semgrepEnabled: false,
					gitHistoryEnabled: false,
				},
			},
			isLoading: false,
		};
	});

	useMutationMock.mockImplementation(() => ({
		mutate: vi.fn(),
		isPending: false,
	}));
});

function scanButton() {
	return screen.getByRole("button", {
		name: /run an incremental scan of changed items/i,
	});
}

describe("security page — capability gate wiring", () => {
	it("leaves the Scan button enabled when nothing is gated", () => {
		// Also the flag-off case: the hook reports no gate either way.
		render(<SecurityAccessibilityPage projectId="proj-1" />);
		expect(scanButton()).toBeEnabled();
	});

	it("disables the Scan button when the gate blocks it", () => {
		gateRef.current = {
			gate: null,
			view: null,
			blocked: true,
		};
		render(<SecurityAccessibilityPage projectId="proj-1" />);
		expect(scanButton()).toBeDisabled();
	});

	it("explains a warning without disabling the scan", () => {
		// A warning is not a block — the scan genuinely runs — so the page says
		// so and leaves the button alone. Disabling it here would be the page
		// telling the user something untrue.
		gateRef.current = {
			gate: null,
			view: {
				capabilityKey: "security.run-scan",
				state: "WARNING",
				reasonKey: "codebase.index-stale",
				tone: "warning",
				title: "reason.codebase.index-stale.title",
				body: "reason.codebase.index-stale.body",
				params: { dependency: "the most recent indexing run" },
				ctaLabel: "remedy.retryJob",
				ctaKind: "retry",
				ctaTarget: null,
				blocksAction: false,
				dismissible: true,
				retry: {
					supported: true,
					permitted: true,
					available: true,
					targetId: null,
				},
			},
			blocked: false,
		};
		render(<SecurityAccessibilityPage projectId="proj-1" />);

		expect(scanButton()).toBeEnabled();
		expect(
			screen.getByText("reason.codebase.index-stale.body"),
		).toBeInTheDocument();
	});

	it("renders 'Connect a repository' and sends the viewer to the repository settings", async () => {
		// Rewritten in the Fizzy #1930 review round. The test here pinned the
		// ABSENCE of any codebase affordance on this page, and the page passed
		// no destination either — so "No repository connected" rendered with
		// nothing to press. The banner owns its remedy links now.
		gateRef.current = {
			gate: null,
			view: {
				capabilityKey: "security.run-scan",
				state: "HARD_BLOCK",
				reasonKey: "codebase.not-connected",
				tone: "destructive",
				title: "reason.codebase.not-connected.title",
				body: "reason.codebase.not-connected.body",
				params: { dependency: "a connected repository" },
				ctaLabel: "remedy.connectRepository",
				ctaKind: "navigate",
				ctaTarget: "repository",
				blocksAction: true,
				dismissible: false,
				retry: {
					supported: false,
					permitted: false,
					available: false,
					targetId: null,
				},
			},
			blocked: true,
		};
		render(<SecurityAccessibilityPage projectId="proj-1" />);

		expect(scanButton()).toBeDisabled();
		await userEvent.click(
			screen.getByRole("button", { name: "remedy.connectRepository" }),
		);
		expect(navigateMock).toHaveBeenCalledWith("proj-1", "development", {
			anchorId: "project-repository-settings",
		});
	});

	it("adds no element to the page when nothing is gated", () => {
		const { container } = render(
			<SecurityAccessibilityPage projectId="proj-1" />,
		);
		// The banner renders null rather than an empty wrapper, so the page's
		// own markup is untouched.
		expect(
			container.querySelectorAll('[role="alert"], [role="status"]'),
		).toHaveLength(0);
	});
});
