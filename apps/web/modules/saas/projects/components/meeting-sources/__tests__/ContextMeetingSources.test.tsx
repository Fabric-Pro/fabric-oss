/**
 * @vitest-environment jsdom
 */

/**
 * Meetings on the Context tab before they have any context (Fizzy #3507).
 *
 * A meeting linked from the calendar has no context row until its first
 * transcript syncs. Until then the Context tab lists it as waiting, or as not
 * syncing when the last attempt failed, so adding a meeting from either page
 * never looks like nothing happened.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listLinkedMeetings: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingTranscriptSync: {
				listLinkedMeetings: mocks.listLinkedMeetings,
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { projects: { contexts: { list: { key: () => ["contexts"] } } } },
}));

vi.mock("@saas/meetings/components", () => ({
	LinkedMeetingSelector: () => null,
}));

vi.mock("../TranscriptFolderProgress", () => ({
	TranscriptFolderProgress: () => null,
}));

vi.mock("../AddMeetingMenu", () => ({
	AddMeetingMenu: () => null,
}));

import {
	ContextMeetingPlaceholders,
	meetingsAwaitingFirstTranscript,
} from "../ContextMeetingSources";

function linked(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		subject: `Series ${id}`,
		deactivatedAt: null,
		lastErrorMessage: null,
		_count: { transcripts: 0 },
		...overrides,
	};
}

function renderPlaceholders() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<ContextMeetingPlaceholders
			projectId="project-1"
			organizationId="org-1"
		/>,
		{ wrapper },
	);
}

beforeEach(() => {
	mocks.listLinkedMeetings.mockReset();
});

afterEach(() => {
	cleanup();
});

describe("meetingsAwaitingFirstTranscript", () => {
	it("keeps only active meetings with no transcript yet", () => {
		const rows = [
			linked("new"),
			linked("synced", { _count: { transcripts: 3 } }),
			linked("stopped", { deactivatedAt: "2026-11-01T00:00:00Z" }),
		];
		expect(meetingsAwaitingFirstTranscript(rows).map((r) => r.id)).toEqual([
			"new",
		]);
	});
});

describe("ContextMeetingPlaceholders", () => {
	it("lists a newly linked meeting as waiting for its first transcript", async () => {
		mocks.listLinkedMeetings.mockResolvedValue([
			linked("a"),
			linked("b", { _count: { transcripts: 1 } }),
		]);
		renderPlaceholders();

		const section = await screen.findByRole("region", {
			name: "Meetings waiting for a transcript",
		});
		expect(section).toHaveTextContent("Series a");
		expect(section).toHaveTextContent("Waiting for its first transcript");
		expect(section).not.toHaveTextContent("Series b");
	});

	it("says a meeting is not syncing, and why, instead of waiting forever", async () => {
		mocks.listLinkedMeetings.mockResolvedValue([
			linked("a", {
				lastErrorMessage:
					"The Microsoft account needs to sign in again.",
			}),
		]);
		renderPlaceholders();

		const section = await screen.findByRole("region", {
			name: "Meetings waiting for a transcript",
		});
		expect(section).toHaveTextContent(
			"Not syncing: The Microsoft account needs to sign in again.",
		);
		expect(section).not.toHaveTextContent(
			"Waiting for its first transcript",
		);
	});

	it("lists no meeting once every one has a transcript", async () => {
		mocks.listLinkedMeetings.mockResolvedValue([
			linked("a", { _count: { transcripts: 2 } }),
		]);
		const { container } = renderPlaceholders();
		await vi.waitFor(() =>
			expect(mocks.listLinkedMeetings).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
			}),
		);
		expect(
			screen.queryByRole("region", {
				name: "Meetings waiting for a transcript",
			}),
		).toBeNull();
		expect(container.textContent).toBe("");
	});
});
