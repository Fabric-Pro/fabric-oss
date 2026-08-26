import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2170 — the consent step in front of the only action that stores a personal
 * meeting.
 *
 * The rest of the personal lane tells the user their meeting "is visible only
 * to you" and "is never stored in Fabric". This button makes both sentences
 * false for the meeting it acts on, so the tests below are mostly about the
 * moment before the write: that nothing happens without a confirmation, and
 * that the confirmation says what actually changes rather than "Are you sure?".
 */

const importPersonalMeeting = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: {
				importPersonalMeeting: (...args: unknown[]) =>
					importPersonalMeeting(...args),
			},
		},
	},
}));

import { ImportToProjectContextButton } from "../ImportToProjectContextButton";

const MEETING = {
	id: "1",
	subject: "Weekly sync",
	startTime: "2026-08-14T09:00:00Z",
	organizer: "Ada",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
	linkedWithoutTranscript: false,
};

function renderButton(props: Record<string, unknown> = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);

	return render(
		<ImportToProjectContextButton
			projectId="p1"
			organizationId={null}
			projectName="Fabric Portal"
			meeting={MEETING}
			{...props}
		/>,
		{ wrapper },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	importPersonalMeeting.mockResolvedValue({
		status: "imported",
		contextId: "ctx-1",
	});
});

describe("ImportToProjectContextButton — consent", () => {
	it("does not import on the first click; it asks first", async () => {
		renderButton();

		await userEvent.click(
			screen.getByRole("button", { name: /add to project context/i }),
		);

		expect(importPersonalMeeting).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	// "Are you sure?" would be worse than nothing here: the user's mental model
	// is a private meeting, and the only thing that corrects it is spelling out
	// what changes.
	it("names the project and states stored, shared, and used by AI", async () => {
		renderButton();

		await userEvent.click(
			screen.getByRole("button", { name: /add to project context/i }),
		);

		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("Fabric Portal");
		expect(dialog).toHaveTextContent(/stored in Fabric/i);
		expect(dialog).toHaveTextContent(
			/everyone with access to this project/i,
		);
		expect(dialog).toHaveTextContent(/AI/);
	});

	it("imports nothing when the user backs out", async () => {
		renderButton();

		await userEvent.click(
			screen.getByRole("button", { name: /add to project context/i }),
		);
		await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

		expect(importPersonalMeeting).not.toHaveBeenCalled();
	});

	it("imports the selected occurrence once the user confirms", async () => {
		renderButton();

		await userEvent.click(
			screen.getByRole("button", { name: /add to project context/i }),
		);
		await userEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: /^add to project context$/i,
			}),
		);

		await waitFor(() => {
			expect(importPersonalMeeting).toHaveBeenCalledWith({
				projectId: "p1",
				organizationId: null,
				joinUrl: MEETING.joinUrl,
				startTime: MEETING.startTime,
				meetingSubject: MEETING.subject,
			});
		});
	});
});

describe("ImportToProjectContextButton — outcomes", () => {
	async function confirm() {
		await userEvent.click(
			screen.getByRole("button", { name: /add to project context/i }),
		);
		await userEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: /^add to project context$/i,
			}),
		);
	}

	it("reports the meeting is in the project once imported", async () => {
		renderButton();
		await confirm();

		expect(
			await screen.findByText(/in project context/i),
		).toBeInTheDocument();
	});

	// A duplicate is a success from the user's point of view — the meeting is
	// where they wanted it — so it must not read as a failure.
	it("treats an already-imported meeting as done, not as an error", async () => {
		importPersonalMeeting.mockResolvedValue({
			status: "duplicate",
			contextId: "ctx-existing",
		});
		renderButton();
		await confirm();

		expect(
			await screen.findByText(/already in project context/i),
		).toBeInTheDocument();
	});

	it.each([
		["no-transcript", /no transcript/i],
		["admin-consent-required", /IT admin/i],
		["transcript-access-disabled", /Teams admin/i],
		["not-connected", /Settings/i],
		["no-access", /someone else organised/i],
		// #2170 QA: Graph 404/3004. Previously a 500 whose copy said "Try again".
		["meeting-not-found", /couldn't find this meeting/i],
	])("explains the %s case in the user's terms", async (reason, copy) => {
		importPersonalMeeting.mockResolvedValue({
			status: "unavailable",
			reason,
		});
		renderButton();
		await confirm();

		expect(await screen.findByText(copy)).toBeInTheDocument();
	});

	it("says the transcript is too large rather than importing part of it", async () => {
		importPersonalMeeting.mockResolvedValue({
			status: "too-large",
			limit: 1_000_000,
		});
		renderButton();
		await confirm();

		expect(await screen.findByText(/too large/i)).toBeInTheDocument();
	});

	it("surfaces an outright failure instead of falling silent", async () => {
		importPersonalMeeting.mockRejectedValue(new Error("boom"));
		renderButton();
		await confirm();

		expect(
			await screen.findByText(/couldn't add this meeting/i),
		).toBeInTheDocument();
	});
});
