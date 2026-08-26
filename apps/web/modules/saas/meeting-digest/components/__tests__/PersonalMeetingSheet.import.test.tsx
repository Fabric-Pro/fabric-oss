import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2170 — where the import action may appear, and what the sheet says once a
 * meeting has been added.
 *
 * The privacy notice is the only thing in this panel that tells the user who
 * can see the meeting. A stale one is not cosmetic: it would state that a
 * meeting now stored and shared with the project is "visible only to you".
 */

const { getPersonalTranscript, getPersonalInsights, importPersonalMeeting } =
	vi.hoisted(() => ({
		getPersonalTranscript: vi.fn(),
		getPersonalInsights: vi.fn(),
		importPersonalMeeting: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: {
				getPersonalTranscript,
				getPersonalInsights,
				importPersonalMeeting,
			},
		},
	},
}));

import { PersonalMeetingSheet } from "../PersonalMeetingSheet";

const MEETING = {
	id: "evt1",
	subject: "1:1 with Sam",
	startTime: "2026-07-14T09:00:00Z",
	organizer: "Sam Rivers",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
	linkedWithoutTranscript: false,
};

/** Linked project meeting with no synced transcript — shared, not private. */
const UNSYNCED_TEAM_MEETING = {
	...MEETING,
	id: "evt2",
	subject: "Fabric DSU",
	linkedWithoutTranscript: true,
};

function renderSheet(props: Record<string, unknown> = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);

	return render(
		<PersonalMeetingSheet
			projectId="p1"
			organizationId={null}
			meeting={MEETING}
			onClose={() => {}}
			canImportToContext
			projectName="Fabric Portal"
			{...props}
		/>,
		{ wrapper },
	);
}

const importButton = () =>
	screen.queryByRole("button", { name: /add to project context/i });

beforeEach(() => {
	vi.clearAllMocks();
	importPersonalMeeting.mockResolvedValue({
		status: "imported",
		contextId: "ctx-1",
	});
});

describe("PersonalMeetingSheet — where the import action appears", () => {
	it("offers it for a genuinely personal meeting", () => {
		renderSheet();
		expect(importButton()).toBeInTheDocument();
	});

	// Revoking MEETING_CONTEXT_IMPORT has to remove the affordance, not merely
	// make it fail — the same discipline the #2104 cache flag follows.
	it("hides it when the feature is off", () => {
		renderSheet({ canImportToContext: false });
		expect(importButton()).not.toBeInTheDocument();
	});

	// This one is already a project meeting whose transcript the sync pipeline
	// owns. Importing it would store a second copy of content the project is
	// about to receive anyway, under a different provenance.
	it("hides it for a linked project meeting awaiting sync", () => {
		renderSheet({ meeting: UNSYNCED_TEAM_MEETING });
		expect(importButton()).not.toBeInTheDocument();
	});
});

describe("PersonalMeetingSheet — the privacy notice after an import", () => {
	it("says the meeting is private before anything is imported", () => {
		renderSheet();

		expect(screen.getByText(/visible only to you/i)).toBeInTheDocument();
	});

	it("stops claiming privacy once the meeting is in the project", async () => {
		renderSheet();

		await userEvent.click(importButton() as HTMLElement);
		await userEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: /^add to project context$/i,
			}),
		);

		await waitFor(() => {
			expect(
				screen.queryByText(/visible only to you/i),
			).not.toBeInTheDocument();
		});
		expect(
			screen.getByText(
				/visible to everyone with access to this project/i,
			),
		).toBeInTheDocument();
	});

	// The sheet stays mounted across meeting changes (the same trap that once
	// leaked a summary from meeting A into meeting B), so a carried-over flag
	// here would tell the user a still-private meeting is shared.
	it("returns to the private notice when the sheet is pointed at another meeting", async () => {
		const { rerender } = renderSheet();

		await userEvent.click(importButton() as HTMLElement);
		await userEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: /^add to project context$/i,
			}),
		);
		await screen.findByText(
			/visible to everyone with access to this project/i,
		);

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		rerender(
			<QueryClientProvider client={client}>
				<PersonalMeetingSheet
					projectId="p1"
					organizationId={null}
					meeting={{ ...MEETING, id: "evt9", joinUrl: "other-url" }}
					onClose={() => {}}
					canImportToContext
					projectName="Fabric Portal"
				/>
			</QueryClientProvider>,
		);

		expect(screen.getByText(/visible only to you/i)).toBeInTheDocument();
	});
});

/**
 * QA on staging (18 Aug 2026) reloaded the page after importing and found the
 * sheet back to "never stored in Fabric" over a meeting whose transcript was
 * sitting in the project's Context tab. The import flag was component state, so
 * it died with the mount. These pin the server-supplied answer instead.
 */
describe("PersonalMeetingSheet — an import from an earlier session", () => {
	const IMPORTED = { ...MEETING, alreadyImported: true };

	it("does not call the meeting private", () => {
		renderSheet({ meeting: IMPORTED });

		expect(
			screen.queryByText(/visible only to you/i),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/stored in Fabric as project context/i),
		).toBeInTheDocument();
	});

	it("does not offer an import whose only outcome is the duplicate branch", () => {
		renderSheet({ meeting: IMPORTED });

		expect(importButton()).not.toBeInTheDocument();
		expect(
			screen.getByText(/already in project context/i),
		).toBeInTheDocument();
	});

	it("still calls an un-imported meeting private", () => {
		renderSheet({ meeting: { ...MEETING, alreadyImported: false } });

		expect(screen.getByText(/visible only to you/i)).toBeInTheDocument();
		expect(importButton()).toBeInTheDocument();
	});
});
