/**
 * Accessibility coverage for the meeting picker (Fizzy #1898 NFR: "the
 * modal/panel must support keyboard navigation and focus management — focus
 * trap in modal, focus return on close").
 *
 * The picker is a Radix Dialog (`@ui/components/dialog`), which provides the
 * focus scope. These tests pin the parts jsdom can verify reliably: the
 * accessible name/description, focus entering the dialog on open, and keyboard
 * operation of the meeting checkboxes.
 *
 * NOTE on focus RETURN on close: Radix restores focus to the opener element,
 * but jsdom does not implement that restoration (focus lands on <body> in the
 * test environment), so it cannot be asserted here. That specific clause of the
 * NFR is covered in a real browser by the gated Playwright spec
 * `apps/web/tests/meeting-digest.spec.ts` ("keyboard: focus is trapped in the
 * picker and returns to the opener on close"). Do not add a jsdom focus-return
 * assertion — it will fail for environment reasons, not app reasons.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedMeetingSelector } from "../LinkedMeetingSelector";

const { listMeetingsMock, linkMeetingMock } = vi.hoisted(() => ({
	listMeetingsMock: vi.fn(),
	linkMeetingMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: { listMeetings: listMeetingsMock },
			meetingTranscriptSync: { linkMeeting: linkMeetingMock },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

/** Trigger button + state-controlled picker, mirroring the real caller. */
function Harness() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Add meeting
			</button>
			<LinkedMeetingSelector
				projectId="p1"
				organizationId="o1"
				open={open}
				onOpenChange={setOpen}
				onLinked={vi.fn()}
				existingJoinUrls={[]}
			/>
		</>
	);
}

describe("LinkedMeetingSelector — accessibility", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listMeetingsMock.mockResolvedValue({
			meetings: [
				{
					id: "m1",
					subject: "FABRIC | DSU",
					startTime: "2026-07-20T09:00:00Z",
					organizer: "dev@example.com",
					joinUrl: "https://teams.microsoft.com/l/meetup-join/dsu",
				},
			],
		});
	});

	it("exposes the dialog with an accessible name and description", async () => {
		const user = userEvent.setup();
		render(<Harness />, { wrapper });
		await user.click(screen.getByRole("button", { name: /add meeting/i }));

		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveAccessibleName(/link meetings/i);
		expect(dialog).toHaveAccessibleDescription(
			/select recurring meetings/i,
		);
	});

	it("moves focus into the dialog when it opens (focus trap entry)", async () => {
		const user = userEvent.setup();
		render(<Harness />, { wrapper });
		await user.click(screen.getByRole("button", { name: /add meeting/i }));

		const dialog = await screen.findByRole("dialog");
		await waitFor(() =>
			expect(dialog.contains(document.activeElement)).toBe(true),
		);
	});

	it("closes on Escape (keyboard dismiss)", async () => {
		const user = userEvent.setup();
		render(<Harness />, { wrapper });
		await user.click(screen.getByRole("button", { name: /add meeting/i }));
		expect(await screen.findByRole("dialog")).toBeInTheDocument();

		await user.keyboard("{Escape}");

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("lets a keyboard user select a meeting with Space", async () => {
		const user = userEvent.setup();
		render(<Harness />, { wrapper });
		await user.click(screen.getByRole("button", { name: /add meeting/i }));

		const checkbox = await screen.findByRole("checkbox", {
			name: /select fabric \| dsu/i,
		});
		checkbox.focus();
		expect(checkbox).toHaveFocus();

		await user.keyboard(" ");
		expect(checkbox).toBeChecked();
	});
});
