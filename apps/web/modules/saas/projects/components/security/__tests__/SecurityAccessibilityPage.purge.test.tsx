import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
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

// next-intl: surface the real destructive copy shape via t.raw.
const PURGE_COPY = {
	label: "Delete the current unresolved findings, then run a full scan from scratch.",
	warning:
		"Warning: open findings are permanently deleted before the scan starts.",
};
vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = () => "";
		t.raw = (key: string) => (key === "purgeRescan" ? PURGE_COPY : "");
		return t;
	},
}));

// Stub child surfaces — this test only exercises the page's scan controls.
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

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.setPointerCapture ??= () => {};
	HTMLElement.prototype.releasePointerCapture ??= () => {};
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
	useQueryMock.mockReset();
	useMutationMock.mockReset();
	triggerMutateMock.mockReset();

	// config.get → at least one scanner enabled so the run button is active;
	// scan.latest → no scan in flight.
	useQueryMock.mockImplementation((opts: { refetchInterval?: unknown }) => {
		// Only the latest query passes a refetchInterval function.
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
		mutate: (vars: unknown) => triggerMutateMock(vars),
		isPending: false,
	}));
});

async function openScanMenu(user: ReturnType<typeof userEvent.setup>) {
	await user.click(
		screen.getByRole("button", { name: /more scan options/i }),
	);
}

describe("SecurityAccessibilityPage — re-scan with purge (G10)", () => {
	it("offers a 'Delete current findings & re-scan' option in the scan menu", async () => {
		const user = userEvent.setup();
		render(<SecurityAccessibilityPage projectId="proj-1" />);
		await openScanMenu(user);
		expect(
			await screen.findByRole("menuitem", {
				name: /delete current findings & re-scan/i,
			}),
		).toBeInTheDocument();
	});

	it("opens a confirmation modal that explains the deletion before re-scanning", async () => {
		const user = userEvent.setup();
		render(<SecurityAccessibilityPage projectId="proj-1" />);
		await openScanMenu(user);
		await user.click(
			await screen.findByRole("menuitem", {
				name: /delete current findings & re-scan/i,
			}),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(
			/permanently deletes the current unresolved/i,
		);
		expect(dialog).toHaveTextContent(
			/resolved and dismissed findings are kept/i,
		);

		// Not triggered yet — confirmation pending.
		expect(triggerMutateMock).not.toHaveBeenCalled();
	});

	it("triggers a FULL scan with purgeUnresolved on confirm", async () => {
		const user = userEvent.setup();
		render(<SecurityAccessibilityPage projectId="proj-1" />);
		await openScanMenu(user);
		await user.click(
			await screen.findByRole("menuitem", {
				name: /delete current findings & re-scan/i,
			}),
		);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", { name: /delete & re-scan/i }),
		);

		expect(triggerMutateMock).toHaveBeenCalledTimes(1);
		expect(triggerMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "FULL",
				purgeUnresolved: true,
			}),
		);
	});

	it("does not trigger a scan when the confirmation is cancelled", async () => {
		const user = userEvent.setup();
		render(<SecurityAccessibilityPage projectId="proj-1" />);
		await openScanMenu(user);
		await user.click(
			await screen.findByRole("menuitem", {
				name: /delete current findings & re-scan/i,
			}),
		);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", { name: /cancel/i }),
		);
		expect(triggerMutateMock).not.toHaveBeenCalled();
	});
});
