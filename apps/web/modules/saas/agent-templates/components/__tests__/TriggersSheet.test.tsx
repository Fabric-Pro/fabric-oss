import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type TriggerConfig, TriggersSheet } from "../TriggersSheet";

vi.mock("@saas/shared/components/icons/RobotIcon", () => ({
	RobotIcon: () => <div data-testid="robot-icon" />,
}));

// Mock the slack-context query so tests can control what the Slack panel
// auto-defaults into trigger config without a real network round-trip.
const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		integrations: {
			slack: {
				getContext: {
					queryOptions: (opts: unknown) => ({
						queryKey: ["integrations.slack.getContext"],
						queryFn: () => null,
						__opts: opts,
					}),
				},
			},
		},
	},
}));

beforeEach(() => {
	useQueryMock.mockReset();
	useQueryMock.mockReturnValue({ data: undefined });
});

class ResizeObserverMock {
	observe() {}
	unobserve() {}
	disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;

HTMLElement.prototype.hasPointerCapture ??= () => false;
HTMLElement.prototype.setPointerCapture ??= () => {};
HTMLElement.prototype.releasePointerCapture ??= () => {};
HTMLElement.prototype.scrollIntoView ??= () => {};

// Locate the Slack trigger switch by walking up from the Slack card button
// to the row container, then querying the sibling switch. Stable against
// new trigger types being inserted into TRIGGER_TYPES (e.g. lifecycle).
function findSlackSwitch(): HTMLElement {
	const slackCardButton = screen.getByRole("button", { name: /Slack/i });
	const row = slackCardButton.closest(
		"div.flex.items-center.justify-between.p-4",
	);
	const toggle = row?.querySelector('[role="switch"]') as HTMLElement | null;
	if (!toggle) {
		throw new Error("Expected Slack trigger switch in card row");
	}
	return toggle;
}

describe("TriggersSheet Slack config", () => {
	it("shows a setup state when Slack is not configured", async () => {
		const user = userEvent.setup();
		render(
			<TriggersSheet
				open
				onOpenChange={() => {}}
				triggers={[]}
				onTriggersChange={() => {}}
				configuredIntegrations={[]}
			/>,
		);

		const slackCardButton = screen.getByRole("button", { name: /Slack/i });
		expect(slackCardButton).toBeInTheDocument();
		expect(screen.getByText(/Needs setup/i)).toBeInTheDocument();
		expect(findSlackSwitch()).toBeDisabled();

		await user.click(slackCardButton);
		expect(
			screen.queryByText(/Slack integration required/i),
		).not.toBeInTheDocument();
	});

	it("persists Slack conversational defaults when enabled and saved", async () => {
		const user = userEvent.setup();
		const onTriggersChange = vi.fn();
		const onOpenChange = vi.fn();
		render(
			<TriggersSheet
				open
				onOpenChange={onOpenChange}
				triggers={[]}
				onTriggersChange={onTriggersChange}
				configuredIntegrations={["SLACK"]}
			/>,
		);

		const slackCardButton = screen.getByRole("button", { name: /Slack/i });
		const slackToggle = findSlackSwitch();

		await user.click(slackToggle);
		await user.click(slackCardButton);
		await user.click(
			screen.getByRole("button", { name: /Save Triggers/i }),
		);

		expect(onTriggersChange).toHaveBeenCalledTimes(1);
		const saved = onTriggersChange.mock.calls[0][0] as TriggerConfig[];
		const slackTrigger = saved.find((trigger) => trigger.type === "slack");
		expect(slackTrigger).toMatchObject({
			type: "slack",
			enabled: true,
			config: {
				replyInThreads: true,
				threadTimeoutHours: 24,
				mentionOnly: true,
				respondToDms: true,
			},
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("persists edited Slack settings", async () => {
		const user = userEvent.setup();
		const onTriggersChange = vi.fn();
		render(
			<TriggersSheet
				open
				onOpenChange={() => {}}
				triggers={[]}
				onTriggersChange={onTriggersChange}
				configuredIntegrations={["SLACK"]}
			/>,
		);

		const slackCardButton = screen.getByRole("button", { name: /Slack/i });
		const slackToggle = findSlackSwitch();
		await user.click(slackToggle);
		await user.click(slackCardButton);

		const threadReplyRow = screen
			.getByText(/Reply in Slack threads/i)
			.closest("div.flex.items-center.justify-between.py-2");
		const dmRow = screen
			.getByText(/Respond to direct messages/i)
			.closest("div.flex.items-center.justify-between.py-2");
		const timeoutRow = screen
			.getByText(/Keep conversations active for/i)
			.closest("div.flex.items-center.justify-between.py-2");

		const threadReplySwitch = threadReplyRow?.querySelector(
			'[role="switch"]',
		) as HTMLElement | null;
		const dmSwitch = dmRow?.querySelector(
			'[role="switch"]',
		) as HTMLElement | null;
		const timeoutSelect = timeoutRow?.querySelector(
			'[role="combobox"]',
		) as HTMLElement | null;
		if (!threadReplySwitch || !dmSwitch || !timeoutSelect) {
			throw new Error("Expected Slack panel controls");
		}

		await user.click(threadReplySwitch);
		await user.click(dmSwitch);

		await user.click(timeoutSelect);
		await user.click(screen.getByRole("option", { name: /7 days/i }));

		await user.click(
			screen.getByRole("button", { name: /Save Triggers/i }),
		);

		const saved = onTriggersChange.mock.calls[0][0] as TriggerConfig[];
		const slackTrigger = saved.find((trigger) => trigger.type === "slack");
		expect(slackTrigger?.config).toMatchObject({
			replyInThreads: false,
			threadTimeoutHours: 168,
			mentionOnly: true,
			respondToDms: false,
		});
		expect(
			screen.getByText(/Slack conversational replies require/i),
		).toBeInTheDocument();
	});

	it("merges slack workspace context (teamId/botUserId) into saved config", async () => {
		useQueryMock.mockReturnValue({
			data: {
				teamId: "T0123ABCDE",
				teamName: "Acme",
				botUserId: "U999BOTID",
			},
		});
		const user = userEvent.setup();
		const onTriggersChange = vi.fn();
		render(
			<TriggersSheet
				open
				onOpenChange={() => {}}
				triggers={[]}
				onTriggersChange={onTriggersChange}
				configuredIntegrations={["SLACK"]}
			/>,
		);

		await user.click(findSlackSwitch());
		await user.click(
			screen.getByRole("button", { name: /Save Triggers/i }),
		);

		const saved = onTriggersChange.mock.calls[0][0] as TriggerConfig[];
		const slackTrigger = saved.find((t) => t.type === "slack");
		expect(slackTrigger?.config).toMatchObject({
			teamId: "T0123ABCDE",
			botUserId: "U999BOTID",
			replyInThreads: true,
			threadTimeoutHours: 24,
			mentionOnly: true,
			respondToDms: true,
		});
	});
});
