/**
 * Reviewer-reproduced data-loss bug: a save conflict must never destroy the
 * user's in-progress draft. These tests drive the real AgendaSheet + hook
 * (not a source scan, not hardcoded props) through:
 *   - type → conflicting save → draft survives, incoming version surfaced
 *   - a clean (untouched) draft still adopts newly-arrived content
 *
 * See the #1987 incident this class of bug is named after.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAgenda, generateAgenda, saveAgenda } = vi.hoisted(() => ({
	getAgenda: vi.fn(),
	generateAgenda: vi.fn(),
	saveAgenda: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: { getAgenda, generateAgenda, saveAgenda },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

import { AgendaSheet } from "../AgendaSheet";

const READY_AGENDA = {
	id: "ag_1",
	status: "READY" as const,
	content: "## Original agenda\n\n1. Item one",
	contextStats: { hadPriorTranscripts: true, truncated: {} },
	occurrenceStart: "2026-07-25T09:00:00.000Z",
	generatedAt: "2026-07-24T12:00:00.000Z",
	generationError: null,
	editedAt: null,
	editedById: null,
	version: 1,
};

function renderSheet() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<AgendaSheet
			projectId="p1"
			organizationId={null}
			linkedMeetingId="lm_1"
			occurrenceStart="2026-07-25T09:00:00.000Z"
			meetingSubject="Sprint Sync"
			canEdit
			onClose={vi.fn()}
		/>,
		{ wrapper },
	);
}

describe("AgendaSheet — save conflict preserves the user's draft", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the typed draft in the textarea after a conflicting save, and surfaces the incoming version", async () => {
		const user = userEvent.setup();
		getAgenda.mockResolvedValue({ agenda: READY_AGENDA });
		saveAgenda.mockResolvedValueOnce({
			saved: false,
			reason: "conflict",
			current: {
				...READY_AGENDA,
				content: "## Their version\n\n1. Something else entirely",
				version: 2,
				editedById: "other-admin",
			},
		});

		renderSheet();

		const textarea = await screen.findByLabelText("Agenda content");
		expect(textarea).toHaveValue(READY_AGENDA.content);

		await user.type(textarea, "\nMy in-progress note");
		const myDraft = `${READY_AGENDA.content}\nMy in-progress note`;
		expect(textarea).toHaveValue(myDraft);

		await user.click(screen.getByRole("button", { name: /save agenda/i }));

		await waitFor(() => expect(saveAgenda).toHaveBeenCalledTimes(1));

		// The reviewer-reproduced bug: the draft got silently replaced here.
		// It must still be exactly what the user typed.
		await waitFor(() => expect(textarea).toHaveValue(myDraft));

		// The incoming version must be surfaced, not auto-applied.
		expect(
			screen.getByText(/someone else saved a newer version/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/something else entirely/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /keep my edits/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /load their version/i }),
		).toBeInTheDocument();

		// Still the user's draft, untouched, in the textarea.
		expect(textarea).toHaveValue(myDraft);
	});

	it("lets the user explicitly load the incoming version after a conflict", async () => {
		const user = userEvent.setup();
		getAgenda.mockResolvedValue({ agenda: READY_AGENDA });
		const incomingContent =
			"## Their version\n\n1. Something else entirely";
		saveAgenda.mockResolvedValueOnce({
			saved: false,
			reason: "conflict",
			current: {
				...READY_AGENDA,
				content: incomingContent,
				version: 2,
				editedById: "other-admin",
			},
		});

		renderSheet();

		const textarea = await screen.findByLabelText("Agenda content");
		await user.type(textarea, "\nMy in-progress note");
		await user.click(screen.getByRole("button", { name: /save agenda/i }));

		await screen.findByRole("button", { name: /load their version/i });
		await user.click(
			screen.getByRole("button", { name: /load their version/i }),
		);

		expect(textarea).toHaveValue(incomingContent);
		expect(
			screen.queryByText(/someone else saved a newer version/i),
		).not.toBeInTheDocument();
	});

	it("adopts newly-arrived content when the draft is clean (regeneration-completes path)", async () => {
		const user = userEvent.setup();
		getAgenda.mockResolvedValueOnce({ agenda: READY_AGENDA });

		renderSheet();

		const textarea = await screen.findByLabelText("Agenda content");
		expect(textarea).toHaveValue(READY_AGENDA.content);

		// Draft is left clean — no typing here. A regeneration completing
		// (or another admin's edit landing) is exactly what invalidates the
		// query and delivers new content underneath us; that must still be
		// picked up, or the fix for the dirty-conflict case would have
		// broken this path instead.
		const regenerated = {
			...READY_AGENDA,
			content: "## Regenerated agenda\n\n1. Brand new item",
			version: 2,
		};
		generateAgenda.mockResolvedValueOnce({
			started: true,
			reason: "started",
		});
		getAgenda.mockResolvedValue({ agenda: regenerated });

		await user.click(
			screen.getByRole("button", { name: /regenerate agenda/i }),
		);

		await waitFor(() => expect(textarea).toHaveValue(regenerated.content));
	});
});
