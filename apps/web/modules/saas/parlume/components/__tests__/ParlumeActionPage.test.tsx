import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParlumeActionDetail } from "../../lib/parlume-format";
import { ParlumeActionPage } from "../ParlumeActionPage";
import { PROJECT_BASE_PATH } from "./fixtures";

const mocks = vi.hoisted(() => ({
	action: vi.fn(),
	confirmAction: vi.fn(),
	dismissAction: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { parlume: mocks } },
}));

type Action = ParlumeActionDetail["action"];

function proposal(overrides: Partial<Action> = {}): Action {
	return {
		id: "action-1",
		sessionId: "s1",
		toolName: "fabric_create_story",
		summary: "Create feature “Export to CSV”",
		arguments: { title: "Export to CSV", priority: "High" },
		speakerName: "Attendee One",
		status: "PROPOSED",
		expiresAt: new Date("2026-10-01T10:05:00Z"),
		confirmedAt: null,
		completedAt: null,
		chatTag: "P8",
		outcome: null,
		createdAt: new Date("2026-09-30T10:05:00Z"),
		session: {
			agentLabel: "Fabric Agent",
			status: "ACTIVE",
			createdAt: new Date("2026-09-30T10:00:00Z"),
			joinedAt: new Date("2026-09-30T10:01:00Z"),
		},
		requestText: "Create a feature called Export to CSV",
		decidedByName: null,
		...overrides,
	};
}

function showPage({ dismissIntent = false } = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<ParlumeActionPage
				projectId="example-project"
				actionId="action-1"
				projectBasePath={PROJECT_BASE_PATH}
				dismissIntent={dismissIntent}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.action.mockResolvedValue({ action: proposal(), canConfirm: true });
});
afterEach(cleanup);

describe("ParlumeActionPage", () => {
	it("shows the change, every value it sets, who asked and in which meeting", async () => {
		showPage();

		expect(
			await screen.findByRole("heading", {
				level: 1,
				name: "Create feature “Export to CSV”",
			}),
		).toBeInTheDocument();
		expect(screen.getByText("Proposed change · P8")).toBeInTheDocument();
		expect(screen.getByText("Title")).toBeInTheDocument();
		expect(screen.getByText("Export to CSV")).toBeInTheDocument();
		expect(screen.getByText("Priority")).toBeInTheDocument();
		expect(screen.getByText("High")).toBeInTheDocument();
		expect(screen.getByText("Attendee One")).toBeInTheDocument();
		expect(
			screen.getByText("Create a feature called Export to CSV"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Proposed by Fabric Agent/),
		).toBeInTheDocument();
	});

	// The page showed "kind BUG" where the chat post said "Kind: Bug".
	it("names a kind and a priority as the app does, not by their stored values", async () => {
		mocks.action.mockResolvedValue({
			action: proposal({
				arguments: {
					title: "Export fails",
					kind: "BUG",
					priority: "P1_HIGH",
				},
			}),
			canConfirm: true,
		});

		showPage();

		expect(await screen.findByText("Kind")).toBeInTheDocument();
		expect(screen.getByText("Bug")).toBeInTheDocument();
		expect(screen.getByText("High")).toBeInTheDocument();
		expect(screen.queryByText("BUG")).not.toBeInTheDocument();
		expect(screen.queryByText("P1_HIGH")).not.toBeInTheDocument();
	});

	it("confirms the change for a member with edit rights and shows who confirmed it", async () => {
		mocks.confirmAction.mockResolvedValue({
			action: proposal({
				status: "EXECUTING",
				decidedByName: "Example Member",
			}),
		});
		const user = userEvent.setup();
		showPage();

		await user.click(
			await screen.findByRole("button", { name: "Confirm change" }),
		);

		expect(mocks.confirmAction).toHaveBeenCalledWith({
			projectId: "example-project",
			actionId: "action-1",
		});
		expect(
			await screen.findByText(
				"Example Member confirmed this change. Fabric is making it now.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Confirm change" }),
		).toBeNull();
	});

	it("dismisses the change and says no change was made", async () => {
		mocks.dismissAction.mockResolvedValue({
			action: proposal({
				status: "CANCELLED",
				decidedByName: "Example Member",
				outcome: "Dismissed in Fabric. No change was made.",
			}),
		});
		const user = userEvent.setup();
		showPage();

		await user.click(
			await screen.findByRole("button", { name: "Dismiss" }),
		);

		expect(mocks.dismissAction).toHaveBeenCalledTimes(1);
		expect(mocks.confirmAction).not.toHaveBeenCalled();
		expect(
			await screen.findByText(
				"Example Member dismissed this proposal. No change was made.",
			),
		).toBeInTheDocument();
	});

	it("puts the focus on Dismiss when opened from a chat post's Dismiss link", async () => {
		showPage({ dismissIntent: true });

		const dismiss = await screen.findByRole("button", { name: "Dismiss" });
		await waitFor(() => expect(dismiss).toHaveFocus());
		expect(mocks.dismissAction).not.toHaveBeenCalled();
	});

	it("tells a member without edit rights why they cannot decide, and offers no buttons", async () => {
		mocks.action.mockResolvedValue({
			action: proposal(),
			canConfirm: false,
		});
		showPage();

		expect(
			await screen.findByText(
				/Only a project member with edit rights can confirm or dismiss this change/,
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("says an expired proposal can no longer be confirmed", async () => {
		mocks.action.mockResolvedValue({
			action: proposal({ status: "EXPIRED" }),
			canConfirm: true,
		});
		showPage();

		expect(
			await screen.findByText(/This proposal has expired/),
		).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("says a handled proposal was already decided, with its result", async () => {
		mocks.action.mockResolvedValue({
			action: proposal({
				status: "COMPLETED",
				decidedByName: "Example Member",
				outcome: "Created feature F-12.",
			}),
			canConfirm: true,
		});
		showPage();

		expect(
			await screen.findByText(
				"Example Member confirmed this change, and Fabric made it.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Created feature F-12.")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("names the item a confirmed change made and links to it, instead of its raw result", async () => {
		const outcome = JSON.stringify({
			storyId: "story-3",
			identifier: "3",
			title: "Export to CSV",
			kind: "FEATURE",
			url: `${window.location.origin}/app/example-org/projects/example-project/stories/story-3`,
		});
		mocks.action.mockResolvedValue({
			action: proposal({
				status: "COMPLETED",
				decidedByName: "Example Member",
				outcome,
			}),
			canConfirm: true,
		});
		showPage();

		const link = await screen.findByRole("link", {
			name: "Feature 3 · Export to CSV",
		});
		expect(link).toHaveAttribute(
			"href",
			"/app/example-org/projects/example-project/stories/story-3",
		);
		expect(screen.queryByText(/storyId/)).toBeNull();
	});

	it("does not link a result address on another site", async () => {
		mocks.action.mockResolvedValue({
			action: proposal({
				status: "COMPLETED",
				decidedByName: "Example Member",
				outcome: JSON.stringify({
					identifier: "3",
					title: "Export to CSV",
					kind: "FEATURE",
					url: "https://example.com/stories/story-3",
				}),
			}),
			canConfirm: true,
		});
		showPage();

		expect(
			await screen.findByText("Feature 3 · Export to CSV"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "Feature 3 · Export to CSV" }),
		).toBeNull();
	});

	it("shows the server's reason when a confirmation is refused", async () => {
		mocks.confirmAction.mockRejectedValue(
			new ORPCError("CONFLICT", {
				message: "This proposal was already confirmed.",
			}),
		);
		const user = userEvent.setup();
		showPage();

		await user.click(
			await screen.findByRole("button", { name: "Confirm change" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"This proposal was already confirmed.",
		);
		await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(2));
	});

	it("does not show a proposal of another project or organization", async () => {
		mocks.action.mockRejectedValue(
			new ORPCError("NOT_FOUND", {
				message: "Parlume proposal not found",
			}),
		);
		showPage();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"This proposal does not exist in this project, or you cannot open it.",
		);
	});
});
