/**
 * The change-history window renders a status move the PM status sync applied
 * (Fizzy #2304, spec §4.4 "Change-history rendering"). The row is produced by
 * the REAL `mapAuditRow`, fed exactly what the leaf hands `recordAudit`, so a
 * drift in either the metadata shape or the mapping fails here.
 */

import {
	type AuditRowLike,
	mapAuditRow,
} from "@repo/api/modules/projects/procedures/backlog/history-mapping";
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

// jsdom gaps the Radix Select needs — copied from BacklogAuditDialog.tabs.test.tsx.
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

const LEAF_PM_STATUS_SYNC_AUDIT = {
	action: "story.pm_status_synced",
	category: "story",
	actor: { type: "system" },
	organizationId: "org_1",
	projectId: "project_1",
	resource: { type: "story", id: "story_1", name: "Checkout flow" },
	metadata: {
		fromStatus: "status_backlog",
		toStatus: "status_review",
		statusName: "In Review",
		source: "PM_STATUS_SYNC",
		pmTool: "GitLab",
	},
};

/** Mirrors `buildAuditRow` in packages/database/prisma/queries/audit-log.ts. */
function rowFromRecordAudit(
	input: typeof LEAF_PM_STATUS_SYNC_AUDIT,
): AuditRowLike {
	return {
		id: "a_sync_1",
		action: input.action,
		actorType: input.actor.type,
		userId: null,
		actorNameSnapshot: null,
		actorEmailSnapshot: null,
		resourceId: input.resource.id,
		resourceName: input.resource.name,
		metadata: input.metadata,
		createdAt: new Date("2026-09-21T09:00:00.000Z"),
	};
}

const SYNCED_MOVE_TEXT =
	'Moved «Checkout flow» to "In Review" — synced from GitLab';

function Harness() {
	const [view, setView] = useState<HistoryView>("changes");
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

function renderDialog() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<Harness />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	// Stands in for the server's action filter (pinned for the real procedure
	// in packages/api/.../backlog/__tests__/history-audit-list.test.ts): the
	// synced move is listed under "All actions" and "Status changed" only.
	listAudit
		.mockReset()
		.mockImplementation(async (args: { action?: string }) => ({
			items:
				args.action === "all" || args.action === "status_changed"
					? [
							mapAuditRow(
								rowFromRecordAudit(LEAF_PM_STATUS_SYNC_AUDIT),
								{
									identifier: "F-12",
								},
							),
						]
					: [],
			nextCursor: null,
		}));
	listMembers.mockReset().mockResolvedValue({ members: [] });
	listPmSyncLog.mockReset().mockResolvedValue({ rows: [], total: 0 });
});

afterEach(() => cleanup());

describe("BacklogAuditDialog — a move the PM status sync applied", () => {
	it("describes the move as synced from the tool, attributes it to the tool, and tags the source", async () => {
		renderDialog();

		expect(await screen.findByText(SYNCED_MOVE_TEXT)).toBeInTheDocument();
		expect(
			screen.getByRole("img", { name: "Source: GitLab sync" }),
		).toBeInTheDocument();
		expect(screen.getByText("GitLab")).toBeInTheDocument();
		// Positive controls above; the row must not read as an AI edit.
		expect(screen.queryByText("Fabric AI")).toBeNull();
	});

	it("keeps the synced move under the Status changed filter", async () => {
		const user = userEvent.setup();
		renderDialog();
		await screen.findByText(SYNCED_MOVE_TEXT);

		const chooseAction = async (name: string) => {
			await user.click(
				screen.getByRole("combobox", { name: "Filter by change type" }),
			);
			await user.click(await screen.findByRole("option", { name }));
		};

		// Positive control: a filter the synced move does not belong to empties
		// the list, so the row that reappears below comes from the
		// "Status changed" response, not from the previous page's placeholder.
		await chooseAction("Created");
		await waitFor(() => {
			expect(listAudit).toHaveBeenLastCalledWith(
				expect.objectContaining({ action: "created" }),
			);
		});
		await waitFor(() => {
			expect(screen.queryByText(SYNCED_MOVE_TEXT)).toBeNull();
		});

		await chooseAction("Status changed");
		await waitFor(() => {
			expect(listAudit).toHaveBeenLastCalledWith(
				expect.objectContaining({ action: "status_changed" }),
			);
		});
		expect(await screen.findByText(SYNCED_MOVE_TEXT)).toBeInTheDocument();
	});
});
