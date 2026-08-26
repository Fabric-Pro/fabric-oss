import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
// One useQuery drives the branches read; one useMutation is the trigger. The
// mutate spy captures the trigger vars; onSuccess/onError are never fired by the
// stub, so toast/invalidation aren't exercised here.
const useQueryMock = vi.fn();
const triggerMutateMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useMutation: (opts: unknown) => {
		void opts;
		return { mutate: triggerMutateMock, isPending: false };
	},
	useQueryClient: () => ({ invalidateQueries: invalidateMock }),
}));

// Thin orpc stub — every leaf returns queryOptions/mutationOptions/key so the
// component can build inputs; the data comes from useQueryMock.
vi.mock("@shared/lib/orpc-query-utils", () => {
	const passthrough = {
		queryOptions: (opts: unknown) => opts,
		mutationOptions: (opts: unknown) => opts,
		key: () => ["branches"],
	};
	return {
		orpc: {
			projects: {
				scan: {
					branches: passthrough,
					trigger: passthrough,
				},
			},
		},
	};
});

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		info: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
		warning: vi.fn(),
	}),
}));

import { BranchScanStatusPanel } from "../BranchScanStatusPanel";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.setPointerCapture ??= () => {};
	HTMLElement.prototype.releasePointerCapture ??= () => {};
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

type BranchSeed = {
	name: string;
	status: "SCANNED" | "STALE" | "NOT_SCANNED" | "SCANNING";
	isDefault?: boolean;
	isPinned?: boolean;
	lastScannedAt?: Date | null;
	changedFileCount?: number | null;
	changedCommitCount?: number | null;
};

/** Build one server-shaped branch row with sensible defaults. */
function branch(seed: BranchSeed) {
	return {
		isDefault: false,
		isPinned: false,
		headSha: "sha",
		lastScan: null,
		checkpointSha: null,
		lastScannedAt: null,
		changedFileCount: null,
		changedCommitCount: null,
		...seed,
	};
}

/** One branch per status. `develop` (STALE) + `feature` (NOT_SCANNED) are the
 *  only two "unscanned" rows; `main` (SCANNED) and `hotfix` (SCANNING) are not. */
const FOUR = [
	branch({
		name: "main",
		status: "SCANNED",
		isDefault: true,
		lastScannedAt: new Date("2026-07-01T00:00:00.000Z"),
		changedFileCount: 12,
		changedCommitCount: 3,
	}),
	branch({
		name: "develop",
		status: "STALE",
		isPinned: true,
		lastScannedAt: new Date("2026-06-01T00:00:00.000Z"),
	}),
	branch({ name: "feature", status: "NOT_SCANNED" }),
	branch({ name: "hotfix", status: "SCANNING" }),
];

function primeBranches(branches: ReturnType<typeof branch>[]) {
	useQueryMock.mockReturnValue({
		data: { branches },
		isLoading: false,
	});
}

function renderPanel() {
	render(<BranchScanStatusPanel projectId="proj-1" organizationId={null} />);
}

beforeEach(() => {
	useQueryMock.mockReset();
	triggerMutateMock.mockReset();
	invalidateMock.mockReset();
});

describe("BranchScanStatusPanel — rows + indicators", () => {
	it("renders a row per branch with its status indicator label and name", () => {
		primeBranches(FOUR);
		renderPanel();

		for (const label of ["Scanned", "Stale", "Not scanned", "Scanning"]) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
		for (const name of ["main", "develop", "feature", "hotfix"]) {
			expect(screen.getByText(name)).toBeInTheDocument();
		}
	});

	it("shows the diff-scope line when the checkpoint recorded change counts", () => {
		primeBranches(FOUR);
		renderPanel();
		// main carries changedFileCount 12 / changedCommitCount 3.
		expect(screen.getByText(/12 changed files/)).toBeInTheDocument();
		expect(screen.getByText(/3 commits/)).toBeInTheDocument();
	});
});

describe("BranchScanStatusPanel — selection + triggering", () => {
	it("select-all-unscanned selects only NOT_SCANNED and STALE branches", async () => {
		const user = userEvent.setup();
		primeBranches(FOUR);
		renderPanel();

		await user.click(
			screen.getByRole("checkbox", {
				name: /select unscanned branches/i,
			}),
		);

		// develop (STALE) + feature (NOT_SCANNED) → 2; SCANNED/SCANNING excluded.
		expect(
			screen.getByRole("button", { name: /scan selected \(2\)/i }),
		).toBeInTheDocument();
	});

	it("Scan selected triggers a bulk scan with exactly the selected names", async () => {
		const user = userEvent.setup();
		primeBranches(FOUR);
		renderPanel();

		await user.click(
			screen.getByRole("checkbox", {
				name: /select unscanned branches/i,
			}),
		);
		await user.click(
			screen.getByRole("button", { name: /scan selected/i }),
		);

		expect(triggerMutateMock).toHaveBeenCalledTimes(1);
		const vars = triggerMutateMock.mock.calls[0][0];
		expect(vars.branches).toEqual(["develop", "feature"]);
		expect(vars.branch).toBeUndefined();
		expect(vars.projectId).toBe("proj-1");
	});

	it("a per-row Scan triggers a single-branch scan with that branch", async () => {
		const user = userEvent.setup();
		primeBranches(FOUR);
		renderPanel();

		await user.click(screen.getByRole("button", { name: "Scan develop" }));

		expect(triggerMutateMock).toHaveBeenCalledTimes(1);
		const vars = triggerMutateMock.mock.calls[0][0];
		expect(vars.branch).toBe("develop");
		expect(vars.branches).toBeUndefined();
		// Panel scans are incremental by default so the DIFF path engages.
		expect(vars.mode).toBe("INCREMENTAL");
	});

	it("disables the Scan button of a branch that is already scanning", () => {
		primeBranches(FOUR);
		renderPanel();

		expect(
			screen.getByRole("button", { name: "Scan hotfix" }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: "Scan main" })).toBeEnabled();
	});

	it("sends mode FULL when the Force full re-scan toggle is on", async () => {
		const user = userEvent.setup();
		primeBranches(FOUR);
		renderPanel();

		await user.click(
			screen.getByRole("switch", { name: /force full re-scan/i }),
		);
		await user.click(screen.getByRole("button", { name: "Scan main" }));

		const vars = triggerMutateMock.mock.calls[0][0];
		expect(vars.mode).toBe("FULL");
		expect(vars.branch).toBe("main");
	});
});

describe("BranchScanStatusPanel — empty state", () => {
	it("renders the connect-a-repository message when there are no branches", () => {
		primeBranches([]);
		renderPanel();

		expect(
			screen.getByText(/connect a repository to see branch coverage/i),
		).toBeInTheDocument();
		// No coverage rows or bulk action when there's nothing to scan.
		expect(
			screen.queryByRole("button", { name: /scan selected/i }),
		).not.toBeInTheDocument();
	});
});
