/**
 * The timer widget's note. A recent note fills the field like typing does:
 * nothing is saved until the field is left or Enter is pressed, focus stays
 * in the field, and text typed before the pick is never saved over it.
 */

import { TimerNote } from "@saas/time-tracking/components/TimerNote";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRecentNotes } = vi.hoisted(() => ({
	mockRecentNotes: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		timeTracking: {
			listRecentNotes: {
				queryOptions: (options: { input: { projectId: string } }) => ({
					queryKey: [
						["timeTracking", "listRecentNotes"],
						{ input: options.input, type: "query" },
					],
					queryFn: () => mockRecentNotes(options.input),
				}),
			},
		},
	},
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		values?.note ? `${key}: ${values.note}` : key,
}));

function renderNote(props: { notesDisabled?: boolean } = {}) {
	const onCommit = vi.fn();
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<label htmlFor="timer-note">Note</label>
			<TimerNote
				id="timer-note"
				initial=""
				placeholder="What are you working on?"
				onCommit={onCommit}
				projectId="project-a"
				notesDisabled={props.notesDisabled ?? false}
			/>
			<button type="button">Elsewhere</button>
		</QueryClientProvider>,
	);
	return { onCommit };
}

beforeEach(() => {
	mockRecentNotes.mockReset();
	mockRecentNotes.mockResolvedValue({ notes: ["REQS", "Code review"] });
});

describe("TimerNote", () => {
	it("offers the recent notes on the timer's project", async () => {
		renderNote();

		expect(
			await screen.findByRole("button", { name: "useRecentNote: REQS" }),
		).toBeInTheDocument();
		expect(mockRecentNotes).toHaveBeenCalledWith({
			projectId: "project-a",
		});
	});

	it("fills the field on a pick and saves it only when the field is left", async () => {
		const user = userEvent.setup();
		const { onCommit } = renderNote();
		const field = screen.getByLabelText("Note");

		await user.click(field);
		await user.type(field, "half typed");
		await user.click(
			await screen.findByRole("button", { name: "useRecentNote: REQS" }),
		);

		expect(field).toHaveValue("REQS");
		expect(field).toHaveFocus();
		expect(onCommit).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Elsewhere" }));

		expect(onCommit).toHaveBeenCalledOnce();
		expect(onCommit).toHaveBeenCalledWith("REQS");
	});

	it("keeps a picked note editable and saves the edited text on Enter", async () => {
		const user = userEvent.setup();
		const { onCommit } = renderNote();
		const field = screen.getByLabelText("Note");

		await user.click(
			await screen.findByRole("button", {
				name: "useRecentNote: Code review",
			}),
		);
		expect(field).toHaveFocus();
		await user.keyboard("{End} of the API{Enter}");

		expect(onCommit).toHaveBeenCalledOnce();
		expect(onCommit).toHaveBeenCalledWith("Code review of the API");
	});

	it("disables the recent notes while the timer is changing", async () => {
		renderNote({ notesDisabled: true });

		expect(
			await screen.findByRole("button", { name: "useRecentNote: REQS" }),
		).toBeDisabled();
	});
});
