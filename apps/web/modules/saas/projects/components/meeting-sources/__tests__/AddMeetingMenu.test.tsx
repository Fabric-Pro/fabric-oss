/**
 * @vitest-environment jsdom
 */

/**
 * "Add meeting" from Meeting Digest and the Context tab (Fizzy #3507).
 *
 * The menu adds no flow of its own: each action opens the one the Knowledge
 * settings already have. So the contract is which component each action opens,
 * with which project, that the dialogs outlive the button that opened them,
 * and that the page hears about it when a dialog closes.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@saas/projects/components/TranscriptFileUpload", () => ({
	TranscriptFileUpload: (props: { projectId: string }) => (
		<div data-testid="uploader">uploader for {props.projectId}</div>
	),
}));

vi.mock("@saas/projects/components/MeetingTranscriptSyncSettings", () => ({
	MeetingTranscriptSyncSettings: (props: {
		projectId: string;
		project: { meetingTranscriptSyncEnabled?: boolean };
	}) => (
		<div data-testid="teams-settings">
			Teams series for {props.projectId}, sync{" "}
			{props.project.meetingTranscriptSyncEnabled ? "on" : "off"}
		</div>
	),
}));

vi.mock("@saas/projects/components/SlackChannelMonitorSettings", () => ({
	SlackChannelMonitorSettings: (props: { projectId: string }) => (
		<div data-testid="slack-settings">Slack for {props.projectId}</div>
	),
}));

vi.mock("../ConnectTranscriptFolderDialog", () => ({
	ConnectTranscriptFolderDialog: (props: {
		open: boolean;
		projectId: string;
	}) =>
		props.open ? (
			<div role="dialog">
				Connect transcript folder for {props.projectId}
			</div>
		) : null,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { projects: { get: { key: () => ["projects.get"] } } },
}));

import { AddMeetingMenu, useMeetingSourceDialogs } from "../AddMeetingMenu";

const project = { meetingTranscriptSyncEnabled: true };

/** A page as the two real ones are built: dialogs once, a button that may go. */
function Page({
	onAddFromCalendar,
	onSourcesChanged,
}: {
	onAddFromCalendar: () => void;
	onSourcesChanged: () => void;
}) {
	const [showButton, setShowButton] = useState(true);
	const dialogs = useMeetingSourceDialogs({
		projectId: "project-1",
		organizationId: "org-1",
		project,
		onSourcesChanged,
	});
	return (
		<>
			{showButton && (
				<AddMeetingMenu
					onAddFromCalendar={onAddFromCalendar}
					onUpload={dialogs.openUpload}
					onConfigureSeries={dialogs.openSeries}
					onConnectFolder={dialogs.openFolder}
				/>
			)}
			<button type="button" onClick={() => setShowButton(false)}>
				first meeting lands
			</button>
			{dialogs.dialogs}
		</>
	);
}

function renderPage() {
	const client = new QueryClient();
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const props = { onAddFromCalendar: vi.fn(), onSourcesChanged: vi.fn() };
	render(
		<QueryClientProvider client={client}>
			<Page {...props} />
		</QueryClientProvider>,
	);
	return { ...props, invalidate };
}

async function choose(item: RegExp) {
	await userEvent.click(screen.getByRole("button", { name: /add meeting/i }));
	fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

afterEach(() => {
	cleanup();
});

describe("AddMeetingMenu", () => {
	it("offers the four ways in", async () => {
		renderPage();
		await userEvent.click(
			screen.getByRole("button", { name: /add meeting/i }),
		);
		const items = (await screen.findAllByRole("menuitem")).map(
			(item) => item.textContent,
		);
		expect(items).toEqual([
			"Add from calendar",
			"Upload transcript",
			"Configure meeting series",
			"Connect transcript folder",
		]);
	});

	it("opens the OneDrive folder picker for this project", async () => {
		renderPage();
		await choose(/connect transcript folder/i);
		expect(await screen.findByRole("dialog")).toHaveTextContent(
			"Connect transcript folder for project-1",
		);
	});

	it("hands the calendar to the page, which owns the picker", async () => {
		const page = renderPage();
		await choose(/add from calendar/i);
		expect(page.onAddFromCalendar).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens the existing uploader for this project", async () => {
		renderPage();
		await choose(/upload transcript/i);
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent("Upload transcript");
		expect(screen.getByTestId("uploader")).toHaveTextContent(
			"uploader for project-1",
		);
	});

	it("keeps the uploader open when the button that opened it goes away", async () => {
		renderPage();
		await choose(/upload transcript/i);
		await screen.findByRole("dialog");

		fireEvent.click(
			screen.getByRole("button", {
				name: "first meeting lands",
				hidden: true,
			}),
		);

		expect(
			screen.queryByRole("button", { name: /add meeting/i }),
		).toBeNull();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByTestId("uploader")).toBeInTheDocument();
	});

	it("opens the Knowledge settings cards with the project's own settings", async () => {
		renderPage();
		await choose(/configure meeting series/i);
		await screen.findByRole("dialog");
		expect(screen.getByTestId("teams-settings")).toHaveTextContent(
			"Teams series for project-1, sync on",
		);
		expect(screen.getByTestId("slack-settings")).toHaveTextContent(
			"Slack for project-1",
		);
	});

	it("reads the project again when the series dialog closes", async () => {
		const page = renderPage();
		await choose(/configure meeting series/i);
		await screen.findByRole("dialog");

		await userEvent.keyboard("{Escape}");

		expect(page.invalidate).toHaveBeenCalledWith({
			queryKey: ["projects.get"],
		});
		expect(page.onSourcesChanged).toHaveBeenCalledTimes(1);
	});

	it("tells the page to read its sources again when the uploader closes", async () => {
		const page = renderPage();
		await choose(/upload transcript/i);
		await screen.findByRole("dialog");
		expect(page.onSourcesChanged).not.toHaveBeenCalled();

		await userEvent.keyboard("{Escape}");

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(page.onSourcesChanged).toHaveBeenCalledTimes(1);
		expect(page.invalidate).not.toHaveBeenCalled();
	});
});
