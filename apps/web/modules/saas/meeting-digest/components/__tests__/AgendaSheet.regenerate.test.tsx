/**
 * #1901 final review — FIX 1 and FIX 5.
 *
 * FIX 1: a stuck GENERATING row (worker down/unregistered workflow type at
 * deploy time — `workflow.start` still succeeds, so nothing ever surfaces an
 * error) previously bricked the occurrence forever: the Regenerate button
 * read `disabled={isGenerating}` straight off the row, so once `stalled`
 * became true there was still no way to click it. The button must become
 * clickable again once polling gives up and reports `stalled`.
 *
 * FIX 5: `generateAgendaProcedure` has no transaction around its
 * findFirst→create, so a double-click before the row flips to GENERATING can
 * race a raw Prisma P2002 into a 500. The button must also disable itself for
 * the lifetime of the generate round trip, not only once the row says
 * GENERATING.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAgenda, generateAgenda, saveAgenda, confirmMock } = vi.hoisted(
	() => ({
		getAgenda: vi.fn(),
		generateAgenda: vi.fn(),
		saveAgenda: vi.fn(),
		confirmMock: vi.fn(),
	}),
);

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: { getAgenda, generateAgenda, saveAgenda },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { MAX_AGENDA_POLLS } from "../../hooks/use-meeting-agenda";
import { AgendaSheet } from "../AgendaSheet";

function generatingAgenda() {
	return {
		id: "ag_1",
		status: "GENERATING" as const,
		content: null,
		contextStats: null,
		occurrenceStart: "2026-07-25T09:00:00.000Z",
		generatedAt: null,
		generationError: null,
		editedAt: null,
		editedById: null,
		version: 1,
	};
}

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

describe("AgendaSheet — Regenerate button stays reachable once stalled (FIX 1)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	it("disables the button while GENERATING and not yet stalled, then re-enables it once stalled", async () => {
		getAgenda.mockResolvedValue({ agenda: generatingAgenda() });

		renderSheet();

		const button = await screen.findByRole("button", {
			name: /generate agenda/i,
		});
		expect(button).toBeDisabled();

		// Drive polling all the way past the poll budget so the row is
		// reported stalled — a worker-down/unregistered-workflow situation
		// where `workflow.start` succeeded but nothing will ever finish it.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000 * (MAX_AGENDA_POLLS + 5));
		});

		await waitFor(() =>
			expect(
				screen.getByText(/taking longer than expected/i),
			).toBeInTheDocument(),
		);

		// The whole point of FIX 1: stalled must be escapable from the UI,
		// not just from a DB edit.
		expect(button).not.toBeDisabled();
	});
});

describe("AgendaSheet — regenerate-over-edits warns via the app dialog, not window.confirm (#2136 review)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("routes would-discard-edits through useConfirmationAlert and only forces after confirmation (D7)", async () => {
		getAgenda.mockResolvedValue({
			agenda: {
				...generatingAgenda(),
				status: "READY" as const,
				content: "## Agenda",
				editedAt: "2026-07-25T10:00:00.000Z",
			},
		});
		generateAgenda.mockResolvedValueOnce({
			started: false,
			reason: "would-discard-edits",
		});

		const user = (
			await import("@testing-library/user-event")
		).default.setup();
		renderSheet();

		const button = await screen.findByRole("button", {
			name: /generate agenda/i,
		});
		await user.click(button);

		// A native window.confirm blocks the renderer and sits outside the
		// app's dialog conventions — the warning must go through the shared
		// ConfirmationAlert instead.
		await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
		const options = confirmMock.mock.calls[0][0];
		expect(options.destructive).toBe(true);
		expect(options.title).toMatch(/regenerate/i);
		expect(options.message).toMatch(/edited/i);

		// Confirming re-runs generation with force; until then no force call.
		expect(generateAgenda).toHaveBeenCalledTimes(1);
		generateAgenda.mockResolvedValueOnce({
			started: true,
			reason: "started",
		});
		await options.onConfirm();
		expect(generateAgenda).toHaveBeenCalledTimes(2);
		expect(generateAgenda).toHaveBeenLastCalledWith(
			expect.objectContaining({ force: true }),
		);
	});
});

describe("AgendaSheet — Generate button disabled for the generate round trip (FIX 5)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("disables the button while the generate mutation is in flight, before the row ever says GENERATING", async () => {
		getAgenda.mockResolvedValue({ agenda: null });
		let resolveGenerate!: (value: {
			started: boolean;
			reason: "started";
		}) => void;
		generateAgenda.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveGenerate = resolve;
			}),
		);

		const user = (
			await import("@testing-library/user-event")
		).default.setup();
		renderSheet();

		const button = await screen.findByRole("button", {
			name: /generate agenda/i,
		});
		expect(button).not.toBeDisabled();

		await user.click(button);

		// The underlying row is still null/not GENERATING at this point — only
		// the in-flight request itself gates the button.
		await waitFor(() => expect(button).toBeDisabled());

		await act(async () => {
			resolveGenerate({ started: true, reason: "started" });
		});

		await waitFor(() => expect(button).not.toBeDisabled());
	});
});
