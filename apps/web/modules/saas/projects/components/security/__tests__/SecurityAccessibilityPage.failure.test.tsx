import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (mirror SecurityAccessibilityPage.purge.test.tsx) ──────────────────
const useQueryMock = vi.fn();
const useMutationMock = vi.fn();
const triggerMutateMock = vi.fn();

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
		const t = () => "";
		t.raw = () => ({ label: "", warning: "" });
		return t;
	},
}));

// The FAILED settle-effect fires toast.error — mock sonner so it's a no-op.
vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("../ScanConfigCard", () => ({
	ScanConfigCard: () => <div data-testid="config-card" />,
}));
vi.mock("../BranchScanStatusPanel", () => ({
	BranchScanStatusPanel: () => <div data-testid="branch-panel" />,
}));
vi.mock("../ScanFindingsList", () => ({
	ScanFindingsList: () => <div data-testid="findings-list" />,
}));
vi.mock("../ScanHistoryDialog", () => ({
	ScanHistoryDialog: () => null,
}));
vi.mock("../ScanInfo", () => ({
	ScanPageInfoButton: () => null,
}));
vi.mock("@saas/shared/components/PageHeader", () => ({
	PageHeader: ({ actions }: { actions: React.ReactNode }) => (
		<div>{actions}</div>
	),
}));

import { SecurityAccessibilityPage } from "../SecurityAccessibilityPage";

const REASON =
	"The AI model was rate-limited (its request/token quota was exceeded). This is usually temporary — please try again in a few minutes.";

const FAILED_SCAN = {
	id: "scan-1",
	status: "FAILED",
	error: REASON,
	branch: null,
	securityFindingCount: 0,
	accessibilityFindingCount: 0,
	durationMs: null,
	modelName: null,
	startedAt: "2026-07-17T10:00:00.000Z",
	completedAt: "2026-07-17T10:05:00.000Z",
	createdAt: "2026-07-17T10:00:00.000Z",
	user: { name: "Alice Anderson", email: "alice@example.com" },
};

function mockLatestScan(scan: unknown) {
	useQueryMock.mockImplementation((opts: { refetchInterval?: unknown }) => {
		if (opts && typeof opts === "object" && "refetchInterval" in opts) {
			return { data: { scan }, isLoading: false, refetch: vi.fn() };
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
}

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
	useQueryMock.mockReset();
	useMutationMock.mockReset();
	triggerMutateMock.mockReset();
	useMutationMock.mockImplementation(() => ({
		mutate: (vars: unknown) => triggerMutateMock(vars),
		isPending: false,
	}));
	mockLatestScan(FAILED_SCAN);
});

describe("SecurityAccessibilityPage — failed-scan surface (#1935)", () => {
	it("persistently renders the failure reason in an alert (not just a toast)", () => {
		render(<SecurityAccessibilityPage projectId="proj-1" />);
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent(/last scan failed/i);
		expect(alert).toHaveTextContent(/rate-limited/i);
	});

	it("shows a generic actionable message when no reason was captured", () => {
		mockLatestScan({ ...FAILED_SCAN, error: null });
		render(<SecurityAccessibilityPage projectId="proj-1" />);
		expect(screen.getByRole("alert")).toHaveTextContent(
			/couldn't be completed.*try again/i,
		);
	});

	it("retries an incremental scan from the failure surface", async () => {
		const user = userEvent.setup();
		render(<SecurityAccessibilityPage projectId="proj-1" />);
		await user.click(screen.getByRole("button", { name: /try again/i }));
		expect(triggerMutateMock).toHaveBeenCalledTimes(1);
		expect(triggerMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "INCREMENTAL" }),
		);
		expect(triggerMutateMock).toHaveBeenCalledWith(
			expect.not.objectContaining({ purgeUnresolved: true }),
		);
	});

	it("does NOT show the failure alert for a user-cancelled scan", () => {
		// A cancel is stored as FAILED ("Cancelled by user") — it must stay on the
		// calm settled summary, not the alarming failure alert with a retry.
		mockLatestScan({ ...FAILED_SCAN, error: "Cancelled by user" });
		render(<SecurityAccessibilityPage projectId="proj-1" />);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
		// Settled summary is shown instead (the "Failed" status badge).
		expect(screen.getByText("Failed")).toBeInTheDocument();
	});
});
