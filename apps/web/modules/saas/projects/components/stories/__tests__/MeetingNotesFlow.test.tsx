import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	MEETING_NOTES_SKIPPED_NONE_RESULT,
	MEETING_NOTES_SKIPPED_TOO_MANY_RESULT,
	MeetingNotesFlow,
	MeetingNotesFlowCard,
} from "../MeetingNotesFlow";

const meetings = [{ joinUrl: "https://example.com/meeting" }];
vi.mock("../MeetingSelector", () => ({
	MeetingSelector: ({ onConfirm, onCancel }: any) => (
		<>
			<button type="button" onClick={() => onConfirm(meetings)}>
				Confirm meetings
			</button>
			<button type="button" onClick={onCancel}>
				Skip meetings
			</button>
		</>
	),
}));

describe("document meeting source progression", () => {
	it("confirmation fetches directly once and model continuation only reads the cached result", async () => {
		const controller = new MeetingNotesFlow();
		const fetchNotes = vi.fn().mockResolvedValue("Transcripts");
		const respond = vi.fn();
		const view = render(
			<MeetingNotesFlowCard
				controller={controller}
				messageId="example-message"
				projectId="example-project"
				organizationId="example-org"
				fetchNotes={fetchNotes}
				respond={respond}
			/>,
		);
		await act(async () => {
			fireEvent.click(screen.getByText("Confirm meetings"));
		});
		expect(fetchNotes).toHaveBeenCalledExactlyOnceWith(meetings);
		expect(respond).toHaveBeenCalledWith("Transcripts");
		expect(await controller.result("example-message")).toBe("Transcripts");
		expect(fetchNotes).toHaveBeenCalledTimes(1);
		view.unmount();
		render(
			<MeetingNotesFlowCard
				controller={controller}
				messageId="example-message"
				projectId="example-project"
				organizationId="example-org"
				fetchNotes={fetchNotes}
				respond={respond}
			/>,
		);
		expect(screen.queryByText("Confirm meetings")).toBeNull();
		expect(controller.admit("example-next-message")).toBeTruthy();
	});
	it("claims double confirmation, skip, too-many and stale callbacks without another fetch", async () => {
		const controller = new MeetingNotesFlow();
		const fetchNotes = vi.fn().mockResolvedValue("Transcripts");
		const id = controller.admit("example-message") ?? "missing-admission";
		const first = controller.confirm(id, meetings, fetchNotes);
		await controller.confirm(id, meetings, fetchNotes);
		await first;
		expect(fetchNotes).toHaveBeenCalledTimes(1);
		const next = controller.admit("example-next") ?? "missing-admission";
		expect(await controller.confirm(id, meetings, fetchNotes)).toMatch(
			/stale/,
		);
		expect(await controller.confirm(next, [], fetchNotes)).toBe(
			MEETING_NOTES_SKIPPED_NONE_RESULT,
		);
		const oversized =
			controller.admit("example-oversized") ?? "missing-admission";
		expect(
			await controller.confirm(
				oversized,
				Array(11).fill(meetings[0]),
				fetchNotes,
			),
		).toBe(MEETING_NOTES_SKIPPED_TOO_MANY_RESULT);
		expect(fetchNotes).toHaveBeenCalledTimes(1);
	});
	it("fences a late transcript result from a superseded request", async () => {
		const controller = new MeetingNotesFlow();
		let finish!: (value: string) => void;
		const fetchNotes = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		);
		const id = controller.admit("example-message") ?? "missing-admission";
		const pending = controller.confirm(id, meetings, fetchNotes);
		await Promise.resolve();
		controller.admit("example-next");
		finish("Old transcripts");
		expect(await pending).toMatch(/superseded/);
		expect(await controller.result("example-message")).not.toBe(
			"Old transcripts",
		);
	});
});

it("attaches a remounted card to an in-flight fetch and delivers its result", async () => {
	const controller = new MeetingNotesFlow();
	let complete!: (value: string) => void;
	const fetchNotes = vi.fn(
		() =>
			new Promise<string>((resolve) => {
				complete = resolve;
			}),
	);
	const first = vi.fn();
	const second = vi.fn();
	const props = {
		controller,
		messageId: "example-message",
		projectId: "example-project",
		organizationId: "example-org",
		fetchNotes,
	};
	const view = render(<MeetingNotesFlowCard {...props} respond={first} />);
	await act(async () => {
		fireEvent.click(screen.getByText("Confirm meetings"));
	});
	view.unmount();
	render(<MeetingNotesFlowCard {...props} respond={second} />);
	expect(second).not.toHaveBeenCalled();
	await act(async () => {
		complete("Transcripts");
	});
	expect(second).toHaveBeenCalledExactlyOnceWith("Transcripts");
	expect(first).not.toHaveBeenCalled();
	expect(fetchNotes).toHaveBeenCalledTimes(1);
});
it("recovers admission when the genuine message arrives after the first render", async () => {
	const controller = new MeetingNotesFlow();
	const respond = vi.fn();
	const props = {
		controller,
		projectId: "example-project",
		organizationId: "example-org",
		fetchNotes: vi.fn().mockResolvedValue("Notes"),
		respond,
	};
	const view = render(<MeetingNotesFlowCard {...props} />);
	view.rerender(
		<MeetingNotesFlowCard {...props} messageId="example-message" />,
	);
	expect(screen.getByText("Confirm meetings")).toBeInTheDocument();
});

it("does not admit a completed tool card remounted after a newer message", async () => {
	const controller = new MeetingNotesFlow();
	const fetchNotes = vi.fn().mockResolvedValue("Notes");
	const old = controller.admit("example-old") ?? "missing-admission";
	await controller.confirm(old, meetings, fetchNotes);
	const before = controller.snapshot();
	render(
		<MeetingNotesFlowCard
			{...({
				controller,
				messageId: "example-new",
				status: "complete",
				projectId: "example-project",
				organizationId: "example-org",
				fetchNotes,
			} as any)}
		/>,
	);
	expect(screen.queryByText("Confirm meetings")).toBeNull();
	expect(controller.snapshot()).toBe(before);
	expect(fetchNotes).toHaveBeenCalledTimes(1);
	expect(controller.admit("example-new")).toBeTruthy();
});

it.each([
	"This meeting request was superseded.",
	"This meeting selection is stale or already completed.",
	"Confirm a meeting selection in the existing card. No notes were fetched.",
])(
	"renders the non-transcript result neutrally after restore: %s",
	(result) => {
		const fetchNotes = vi.fn();
		const card = render(
			<MeetingNotesFlowCard
				controller={new MeetingNotesFlow()}
				projectId="example-project"
				organizationId="example-org"
				status="complete"
				result={result}
				fetchNotes={fetchNotes}
			/>,
		);
		expect(
			card.queryByText("Meeting notes fetched successfully."),
		).toBeNull();
		expect(
			card.getByText("No meeting notes were fetched."),
		).toBeInTheDocument();
		expect(fetchNotes).not.toHaveBeenCalled();
	},
);
