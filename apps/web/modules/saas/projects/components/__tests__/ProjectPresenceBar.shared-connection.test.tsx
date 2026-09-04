/**
 * One presence connection per project page.
 *
 * `ProjectPresenceBar` used to call `useProjectPresence` itself. It is only
 * ever mounted through `ProjectHeader`, which only `ProjectDetails` renders —
 * and `ProjectDetails` calls the same hook for its own refetch callbacks. So
 * the project detail page ran TWO independent presence instances for one
 * project: two `join` POSTs, two heartbeat intervals and two `EventSource`
 * streams. The hook's own de-duplication is per instance and cannot see the
 * other one, so it never had a chance to help.
 *
 * The bar now reads the page's single subscription from
 * `ProjectPresenceProvider`. These tests pin both halves of that: the shared
 * tree opens exactly one connection, and the bar refuses to render without a
 * provider rather than quietly opening a second one.
 *
 * `useProjectRealtime` is mocked the way `useProjectPresence`'s own suite
 * mocks it — a stable `sendPresence` per project, since a fresh function each
 * render would re-run the join effect and mask the very duplication under
 * test.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { presenceCalls, senders, activeUsers } = vi.hoisted(() => ({
	presenceCalls: [] as unknown[][],
	senders: new Map<string, (...args: unknown[]) => void>(),
	activeUsers: [] as unknown[],
}));

vi.mock("../../hooks/useProjectRealtime", () => ({
	useProjectRealtime: ({ projectId }: { projectId: string }) => {
		let sendPresence = senders.get(projectId);
		if (!sendPresence) {
			sendPresence = (...args: unknown[]) => {
				presenceCalls.push([projectId, ...args]);
			};
			senders.set(projectId, sendPresence);
		}
		return {
			activeUsers,
			recentActivity: [],
			status: "connected",
			sendPresence,
		};
	},
}));

import { useProjectPresence } from "../../hooks/useProjectPresence";
import { ProjectPresenceBar } from "../ProjectPresenceBar";
import { ProjectPresenceProvider } from "../ProjectPresenceProvider";

/**
 * The shape of the real page: one hook call high in the tree, the bar reading
 * it from context further down.
 */
function ProjectPage({ activeTab }: { activeTab: string }) {
	const presence = useProjectPresence({ projectId: "p1", activeTab });
	return (
		<ProjectPresenceProvider value={presence}>
			<ProjectPresenceBar currentUserId="me" />
		</ProjectPresenceProvider>
	);
}

describe("ProjectPresenceBar shares the page's presence connection", () => {
	beforeEach(() => {
		presenceCalls.length = 0;
		senders.clear();
		activeUsers.length = 0;
	});

	it("opens a single connection for a page that also renders the bar", () => {
		render(<ProjectPage activeTab="overview" />);

		const joins = presenceCalls.filter(([, action]) => action === "join");
		expect(joins).toHaveLength(1);
		expect(joins[0]).toEqual(["p1", "join", "overview", undefined]);
	});

	it("renders the users from that shared connection", () => {
		activeUsers.push(
			{
				userId: "me",
				userName: "Current User",
				lastSeen: new Date(),
			},
			{
				userId: "u2",
				userName: "Ada Example",
				activeTab: "documents",
				lastSeen: new Date(),
			},
			{
				userId: "u3",
				userName: "Grace Example",
				activeTab: "overview",
				lastSeen: new Date(),
			},
		);

		render(<ProjectPage activeTab="overview" />);

		// The current user is filtered out; the other two come from the
		// provider, not from a subscription the bar opened for itself.
		expect(screen.getByText("2 people viewing")).toBeInTheDocument();
	});

	it("throws instead of opening its own connection outside a provider", () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		expect(() => render(<ProjectPresenceBar currentUserId="me" />)).toThrow(
			/ProjectPresenceProvider/,
		);
		expect(
			presenceCalls.filter(([, action]) => action === "join"),
		).toHaveLength(0);

		consoleError.mockRestore();
	});
});
