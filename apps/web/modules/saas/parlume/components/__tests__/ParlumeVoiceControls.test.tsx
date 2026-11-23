import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParlumeLiveCard } from "../ParlumeLiveCard";
import { ParlumeVoiceControls } from "../ParlumeVoiceControls";
import { liveSession } from "./fixtures";

const mocks = vi.hoisted(() => ({
	stopSpeech: vi.fn(),
	pauseListening: vi.fn(),
	resumeListening: vi.fn(),
	continueReading: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { parlume: mocks } },
}));

const PAUSED_AT = new Date("2026-10-01T12:00:00Z");

beforeEach(() => {
	vi.resetAllMocks();
	mocks.stopSpeech.mockResolvedValue({ changed: true });
	mocks.pauseListening.mockResolvedValue({ changed: true });
	mocks.resumeListening.mockResolvedValue({ changed: true });
	mocks.continueReading.mockResolvedValue({ changed: true });
});
afterEach(cleanup);

function showCard(session = liveSession()) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<QueryClientProvider client={client}>
			<ParlumeLiveCard
				session={session}
				joinedAt={session.joinedAt ?? new Date()}
				costMicroUsd={undefined}
				showSpend={false}
				requests={[]}
				requestsLoading={false}
				canStop={false}
				isStopping={false}
				onStop={vi.fn()}
				voiceControls={
					<ParlumeVoiceControls
						projectId="example-project"
						session={session}
					/>
				}
			/>
		</QueryClientProvider>,
	);
	return { invalidate };
}

describe("Parlume voice controls on the live card", () => {
	it("stops the answer for a reader who cannot remove Parlume, and refreshes the session", async () => {
		const { invalidate } = showCard();

		fireEvent.click(screen.getByRole("button", { name: "Stop speaking" }));

		await waitFor(() =>
			expect(mocks.stopSpeech).toHaveBeenCalledExactlyOnceWith({
				projectId: "example-project",
				sessionId: "live1",
			}),
		);
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: ["parlume-sessions", "example-project"],
			}),
		);
		expect(
			screen.queryByRole("button", { name: "Remove from meeting" }),
		).toBeNull();
	});

	it("says so when there was nothing to stop", async () => {
		mocks.stopSpeech.mockResolvedValue({ changed: false });
		showCard();

		fireEvent.click(screen.getByRole("button", { name: "Stop speaking" }));

		expect(await screen.findByRole("status")).toHaveTextContent(
			"Parlume was not speaking.",
		);
	});

	it("has Parlume read the next part of a long post, and says so when none waits", async () => {
		showCard();

		fireEvent.click(
			screen.getByRole("button", { name: "Continue reading" }),
		);

		await waitFor(() =>
			expect(mocks.continueReading).toHaveBeenCalledExactlyOnceWith({
				projectId: "example-project",
				sessionId: "live1",
			}),
		);
		const button = screen.getByRole("button", { name: "Continue reading" });
		await waitFor(() => expect(button).toBeEnabled());
		expect(screen.queryByRole("status")).toBeNull();

		mocks.continueReading.mockResolvedValue({ changed: false });
		fireEvent.click(button);

		expect(await screen.findByRole("status")).toHaveTextContent(
			"No part of a post is waiting to be read.",
		);
	});

	it("pauses listening", async () => {
		showCard();

		fireEvent.click(
			screen.getByRole("button", { name: "Pause listening" }),
		);

		await waitFor(() =>
			expect(mocks.pauseListening).toHaveBeenCalledExactlyOnceWith({
				projectId: "example-project",
				sessionId: "live1",
			}),
		);
	});

	it("shows a paused session as paused, names who paused it, and offers only Resume", async () => {
		showCard(liveSession({ pausedAt: PAUSED_AT, pausedBy: "Dana Member" }));

		expect(
			screen.getByRole("heading", { name: "Listening paused" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Listening paused by Dana Member\./),
		).toBeInTheDocument();
		expect(screen.queryByText("Listening for “Hey Fabric”")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Pause listening" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Stop speaking" }),
		).toBeDisabled();

		fireEvent.click(
			screen.getByRole("button", { name: "Resume listening" }),
		);

		await waitFor(() =>
			expect(mocks.resumeListening).toHaveBeenCalledExactlyOnceWith({
				projectId: "example-project",
				sessionId: "live1",
			}),
		);
	});

	it("reports a bridge that did not answer", async () => {
		mocks.pauseListening.mockRejectedValue(new Error("bridge down"));
		showCard();

		fireEvent.click(
			screen.getByRole("button", { name: "Pause listening" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Parlume's media bridge did not answer. Try again.",
		);
	});

	it("offers no controls once Parlume is leaving", () => {
		showCard(liveSession({ status: "LEAVING" }));

		expect(
			screen.queryByRole("button", { name: "Stop speaking" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Pause listening" }),
		).toBeNull();
	});
});
