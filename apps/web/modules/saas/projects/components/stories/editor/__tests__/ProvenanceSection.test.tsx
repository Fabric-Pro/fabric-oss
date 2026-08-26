import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UserStory } from "../../../../lib/stories/types";
import { ProvenanceSection } from "../ProvenanceSection";

const base = {
	id: "s1",
	identifier: "F-1",
	title: "t",
	description: null,
	acceptanceCriteria: null,
	statusId: "st1",
	kind: "FEATURE",
	priority: "P2_MEDIUM",
	size: null,
	storyPoints: null,
	labels: [],
	tags: [],
	tasks: [],
	createdById: "u1",
	createdAt: new Date("2026-05-18T00:00:00Z"),
	updatedAt: new Date("2026-05-20T00:00:00Z"),
	lastEditedAt: null,
	source: "manual",
	version: 3,
	externalUrl: null,
	reporterName: null,
	reporterSource: null,
	reporterSourceUrl: null,
	lastEditedByName: null,
	lastEditedSource: null,
} as unknown as UserStory;

describe("ProvenanceSection", () => {
	it("shows creator name when resolved", () => {
		render(<ProvenanceSection story={base} creatorName="Dave" />);
		expect(screen.getByText(/Dave/)).toBeInTheDocument();
	});

	it("does not infer a modification from operational updatedAt", () => {
		render(<ProvenanceSection story={base} creatorName="Dave" />);
		expect(screen.getByText("Not recorded")).toBeInTheDocument();
	});

	it("shows one coherent modification event", () => {
		render(
			<ProvenanceSection
				story={{
					...base,
					lastEditedAt: new Date("2026-05-21T00:00:00Z"),
					lastEditedByName: "Ada",
					lastEditedSource: "CONFLICT_RESOLUTION",
				}}
			/>,
		);
		expect(screen.getByText(/by Ada/)).toBeInTheDocument();
		expect(screen.getByText(/Conflict resolution/)).toBeInTheDocument();
	});

	it("falls back to email then 'Unknown user'", () => {
		const { rerender } = render(
			<ProvenanceSection
				story={base}
				creatorName={null}
				creatorEmail="k@x.com"
			/>,
		);
		expect(screen.getByText(/k@x\.com/)).toBeInTheDocument();
		rerender(
			<ProvenanceSection
				story={base}
				creatorName={null}
				creatorEmail={null}
			/>,
		);
		expect(screen.getByText(/Unknown user/)).toBeInTheDocument();
	});

	it("omits the proposer line when reporterName is null", () => {
		render(<ProvenanceSection story={base} creatorName="Dave" />);
		expect(screen.queryByText(/Originally proposed by/)).toBeNull();
	});

	it("shows the proposer line for a Slack-originated story", () => {
		const story = {
			...base,
			reporterName: "Jane",
			reporterSource: "SLACK",
		} as unknown as UserStory;
		render(<ProvenanceSection story={story} creatorName="Dave" />);
		expect(
			screen.getByText(/Originally proposed by Jane via Slack/i),
		).toBeInTheDocument();
	});

	it("omits the PM row when externalUrl is null", () => {
		render(<ProvenanceSection story={base} creatorName="Dave" />);
		expect(screen.queryByText(/View in/)).toBeNull();
	});

	it("renders a normalized ADO web link", () => {
		const story = {
			...base,
			externalUrl:
				"https://dev.azure.com/org/proj/_apis/wit/workItems/149",
		} as unknown as UserStory;
		render(<ProvenanceSection story={story} creatorName="Dave" />);
		const link = screen.getByRole("link");
		expect(link).toHaveAttribute(
			"href",
			"https://dev.azure.com/org/proj/_workitems/edit/149",
		);
	});

	it("omits the PM row when externalUrl is a non-null invalid URL", () => {
		const story = {
			...base,
			externalUrl: "not-a-url",
		} as unknown as UserStory;
		render(<ProvenanceSection story={story} creatorName="Dave" />);
		expect(screen.queryByText(/PM ticket/i)).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("shows a skeleton while metadata is loading and creator unresolved", () => {
		const { container } = render(
			<ProvenanceSection story={base} creatorName={null} isMetaLoading />,
		);
		expect(
			container.querySelector("[data-testid='creator-skeleton']"),
		).not.toBeNull();
	});

	it("renders the source meeting reference when present", () => {
		render(
			<ProvenanceSection
				story={{
					...base,
					sourceMeeting: {
						subject: "Fabric Daily Sync",
						meetingDate: new Date("2026-07-06T09:00:00Z"),
					},
				}}
			/>,
		);
		expect(screen.getByText("From meeting")).toBeInTheDocument();
		expect(screen.getByText(/Fabric Daily Sync/)).toBeInTheDocument();
	});

	it("omits the meeting row when sourceMeeting is null", () => {
		render(<ProvenanceSection story={{ ...base, sourceMeeting: null }} />);
		expect(screen.queryByText("From meeting")).not.toBeInTheDocument();
	});
});
