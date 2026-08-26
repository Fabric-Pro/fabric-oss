import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listAudit = vi.fn();
const listMembers = vi.fn();
const listPmSyncLog = vi.fn();

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			members: { list: (...args: unknown[]) => listMembers(...args) },
			pmSyncLog: { list: (...args: unknown[]) => listPmSyncLog(...args) },
			backlog: {
				history: {
					audit: { list: (...args: unknown[]) => listAudit(...args) },
				},
			},
		},
	},
}));

if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

import { BacklogAuditDialog, type HistoryView } from "../BacklogAuditDialog";

/**
 * The dialog is controlled, so the harness owns `view` exactly as the roadmap
 * does — which is also what lets a test assert what the FIRST render shows.
 */
function Harness({ initialView = "changes" }: { initialView?: HistoryView }) {
	const [view, setView] = useState<HistoryView>(initialView);
	return (
		<BacklogAuditDialog
			open
			onOpenChange={vi.fn()}
			projectId="project_1"
			organizationId={null}
			view={view}
			onViewChange={setView}
		/>
	);
}

function renderDialog(initialView?: HistoryView) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<Harness initialView={initialView} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listAudit.mockReset().mockResolvedValue({ items: [], nextCursor: null });
	listMembers.mockReset().mockResolvedValue({ members: [] });
	listPmSyncLog.mockReset().mockResolvedValue({ rows: [], total: 0 });
});

afterEach(() => cleanup());

describe("BacklogAuditDialog — Change History / Sync History tabs", () => {
	it("opens on Change History and does not query the sync log", async () => {
		renderDialog();

		expect(
			await screen.findByRole("tab", { name: "Change History" }),
		).toHaveAttribute("aria-selected", "true");
		expect(
			screen.getByRole("tab", { name: "Sync History" }),
		).toHaveAttribute("aria-selected", "false");

		await waitFor(() => expect(listAudit).toHaveBeenCalled());
		expect(listPmSyncLog).not.toHaveBeenCalled();
	});

	it("shows the sync log — with its empty state — on the Sync History tab", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("tab", { name: "Sync History" }));

		await waitFor(() => expect(listPmSyncLog).toHaveBeenCalled());
		expect(
			await screen.findByText("No sync activity yet"),
		).toBeInTheDocument();
	});

	it("opens straight onto the sync log when the deep link asks for it", async () => {
		renderDialog("sync");

		expect(
			await screen.findByRole("tab", { name: "Sync History" }),
		).toHaveAttribute("aria-selected", "true");
		await waitFor(() => expect(listPmSyncLog).toHaveBeenCalled());
		// Title AND description follow the tab — the title is the dialog's
		// accessible name, so it must not keep saying "Change history".
		expect(
			screen.getByRole("heading", { name: "Sync history" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/push to and pull from this project's PM tool/),
		).toBeInTheDocument();
	});

	// Regression: `view` used to initialise to "changes" and get corrected in an
	// effect, so a deep link mounted the audit panel for one commit and fired two
	// requests it immediately threw away (plus a visible flash of the wrong tab).
	it("never touches the audit endpoints when opened directly on the sync log", async () => {
		renderDialog("sync");

		await waitFor(() => expect(listPmSyncLog).toHaveBeenCalled());
		expect(listAudit).not.toHaveBeenCalled();
		expect(listMembers).not.toHaveBeenCalled();
	});

	// Both panels are force-mounted to preserve their state, so the inactive one
	// MUST carry `hidden` — Radix does not add it under `forceMount`, and without
	// it both logs render stacked on top of each other.
	it("hides the inactive panel rather than stacking both", async () => {
		renderDialog();

		const panels = await screen.findAllByRole("tabpanel", { hidden: true });
		expect(panels).toHaveLength(2);
		const visible = panels.filter((p) => !p.hasAttribute("hidden"));
		expect(visible).toHaveLength(1);
		expect(visible[0]).toHaveAttribute("data-state", "active");
	});

	// Regression: both panels used to unmount when hidden, so switching tabs to
	// correlate an event and switching back silently reset the audit filters.
	it("keeps Change History's filters when you visit the sync log and come back", async () => {
		const user = userEvent.setup();
		renderDialog();

		const search = await screen.findByRole("searchbox", {
			name: "Search change history",
		});
		await user.type(search, "checkout");

		await user.click(screen.getByRole("tab", { name: "Sync History" }));
		await waitFor(() => expect(listPmSyncLog).toHaveBeenCalled());
		await user.click(screen.getByRole("tab", { name: "Change History" }));

		expect(
			screen.getByRole("searchbox", { name: "Search change history" }),
		).toHaveValue("checkout");
	});

	// Regression: pinning the filters/pager moved `overflow-y-auto` off the Radix
	// tabpanel (which carries tabIndex=0) onto a plain div, so the rows became
	// unreachable by keyboard — a page of failure rows has no links at all.
	it("keeps both scroll regions reachable by keyboard", async () => {
		const user = userEvent.setup();
		renderDialog();

		const changes = await screen.findByRole("group", {
			name: "Change history entries",
		});
		expect(changes).toHaveAttribute("tabindex", "0");

		await user.click(screen.getByRole("tab", { name: "Sync History" }));
		expect(
			await screen.findByRole("group", { name: "Sync history entries" }),
		).toHaveAttribute("tabindex", "0");
	});

	// Regression: `isError` was never read, so a 403/500 fell through to
	// total === 0 and rendered "No sync activity yet" — an audit log asserting
	// nothing ever happened is the worst possible way to fail.
	it("shows an error, not an empty state, when the sync log fails to load", async () => {
		listPmSyncLog.mockRejectedValue(new Error("FORBIDDEN"));
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("tab", { name: "Sync History" }));

		expect(
			await screen.findByText(/Couldn.t load history/),
		).toBeInTheDocument();
		expect(
			screen.queryByText("No sync activity yet"),
		).not.toBeInTheDocument();
	});

	// Both logs are gated on PROJECT_READ server-side, so the tab is offered to
	// everyone who can open the window — there is no client-side role check left
	// to drift from the server.
	it("always offers both tabs", async () => {
		renderDialog();

		expect(
			await screen.findByRole("tab", { name: "Change History" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("tab", { name: "Sync History" }),
		).toBeInTheDocument();
	});
});
