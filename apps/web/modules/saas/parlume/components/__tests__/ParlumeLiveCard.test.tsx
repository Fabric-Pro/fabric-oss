import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParlumeLiveCard } from "../ParlumeLiveCard";
import { liveSession, request } from "./fixtures";

const NOW = new Date("2026-10-01T12:00:00Z");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function showCard(
	overrides: Partial<Parameters<typeof ParlumeLiveCard>[0]> = {},
) {
	const onStop = vi.fn();
	const joinedAt = new Date(NOW.getTime() - (28 * 60 + 14) * 1000);
	render(
		<ParlumeLiveCard
			session={liveSession({ joinedAt })}
			joinedAt={joinedAt}
			costMicroUsd={undefined}
			requests={[]}
			requestsLoading={false}
			canStop
			isStopping={false}
			onStop={onStop}
			{...overrides}
		/>,
	);
	return { onStop };
}

describe("ParlumeLiveCard elapsed time", () => {
	it("counts up from when the bot joined, every second", () => {
		showCard();
		expect(screen.getByRole("timer")).toHaveTextContent("28:14");

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByRole("timer")).toHaveTextContent("28:15");

		act(() => {
			vi.advanceTimersByTime(46_000);
		});
		expect(screen.getByRole("timer")).toHaveTextContent("29:01");
	});

	it("adds the hour once the meeting passes one", () => {
		const joinedAt = new Date(NOW.getTime() - (62 * 60 + 9) * 1000);
		showCard({ session: liveSession({ joinedAt }), joinedAt });
		expect(screen.getByRole("timer")).toHaveTextContent("1:02:09");
	});

	it("stops its timer when the card goes away", () => {
		showCard();
		cleanup();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("ParlumeLiveCard removal", () => {
	it("moves focus to the safe choice, and back to Remove when it is declined", () => {
		showCard();
		const remove = screen.getByRole("button", {
			name: "Remove from meeting",
		});
		fireEvent.click(remove);

		const keep = screen.getByRole("button", { name: "Keep in meeting" });
		expect(keep).toHaveFocus();

		fireEvent.click(keep);
		expect(
			screen.getByRole("button", { name: "Remove from meeting" }),
		).toHaveFocus();
	});

	it("stops the session only from the confirmation", () => {
		const { onStop } = showCard();
		fireEvent.click(
			screen.getByRole("button", { name: "Remove from meeting" }),
		);
		expect(onStop).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Remove now" }));

		expect(onStop).toHaveBeenCalledExactlyOnceWith("live1");
		expect(
			screen.queryByRole("group", { name: "Confirm removal" }),
		).toBeNull();
	});

	it("reports leaving once the stop is under way, with nothing left to press", () => {
		showCard({ session: liveSession({ status: "LEAVING" }) });
		expect(
			screen.getByRole("heading", { name: "Leaving the meeting…" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Remove from meeting" }),
		).toBeNull();
	});

	it("lets a failed stop be tried again", () => {
		showCard({ session: liveSession({ status: "STOP_FAILED" }) });
		expect(
			screen.getByText(/could not confirm it left the meeting/),
		).toHaveAttribute("role", "alert");
		expect(
			screen.getByRole("button", { name: "Remove from meeting" }),
		).toBeEnabled();
	});

	it("does not offer removal to a reader who cannot stop it", () => {
		showCard({ canStop: false });
		expect(
			screen.queryByRole("button", { name: "Remove from meeting" }),
		).toBeNull();
		expect(screen.getByRole("timer")).toBeInTheDocument();
	});
});

describe("ParlumeLiveCard details", () => {
	it("shows a dash for spend until the spend is known, then the amount in cents", () => {
		showCard();
		expect(
			screen.getByText("Spend so far").nextElementSibling,
		).toHaveTextContent("—");
		cleanup();

		showCard({ costMicroUsd: 91_200 });
		expect(
			screen.getByText("Spend so far").nextElementSibling,
		).toHaveTextContent("$0.09");
		expect(
			screen.getByText(
				"Bot and transcription time are added when the meeting ends.",
			),
		).toBeInTheDocument();
	});

	it("shows only the three latest requests, newest first as given", () => {
		showCard({
			requests: [1, 2, 3, 4].map((n) =>
				request({ id: `t${n}`, requestText: `Question ${n}` }),
			),
		});
		expect(screen.getByText("Question 1")).toBeInTheDocument();
		expect(screen.getByText("Question 3")).toBeInTheDocument();
		expect(screen.queryByText("Question 4")).toBeNull();
	});

	it("names an unidentified speaker rather than leaving the line blank", () => {
		showCard({
			requests: [request({ speakerId: null, speakerName: null })],
		});
		expect(screen.getByText("Unidentified attendee")).toBeInTheDocument();
		expect(screen.getByText("?")).toBeInTheDocument();
	});

	it("says requests are loading, then that none have come in", () => {
		showCard({ requestsLoading: true });
		expect(screen.getByText("Loading requests…")).toBeInTheDocument();
		cleanup();

		showCard();
		expect(
			screen.getByText(/No requests yet\. Any attendee can say/),
		).toBeInTheDocument();
	});
});
