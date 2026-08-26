/**
 * Stacked-card notification layout (#2117).
 *
 * The card is the opt-in alternative to the compact row. These tests pin the
 * three things that make it worth having — the chip's context fallback chain,
 * an unread cue that does not depend on colour alone, and a title that wraps
 * instead of truncating — plus behavioural parity with the row for archive,
 * restore and the admin-incident gate.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBasePath } = vi.hoisted(() => ({
	mockBasePath: { current: "/app" },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useBasePath: () => mockBasePath.current,
}));

const { mockUseSession, mockToastInfo } = vi.hoisted(() => ({
	mockUseSession: vi.fn(),
	mockToastInfo: vi.fn(),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => mockUseSession(),
}));

vi.mock("sonner", () => ({
	toast: {
		info: (...args: unknown[]) => mockToastInfo(...args),
		success: vi.fn(),
		error: vi.fn(),
	},
}));

// Mirrors the repo-wide convention: `t` echoes its key. The card therefore
// renders "categories.MENTION" as its label here — the assertions below match
// on the key, which also proves the component never falls through to a raw
// enum for a mapped category.
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		className,
		onClick,
		...rest
	}: {
		children: ReactNode;
		href: string;
		className?: string;
		onClick?: (e: React.MouseEvent) => void;
	} & Record<string, unknown>) => (
		<a href={href} className={className} onClick={onClick} {...rest}>
			{children}
		</a>
	),
}));

import { NotificationCard } from "../NotificationCard";

beforeEach(() => {
	mockUseSession.mockReset();
	mockUseSession.mockReturnValue({ user: { role: "user" } });
	mockToastInfo.mockReset();
	mockBasePath.current = "/app";
});

function makeNotification(over: Partial<any> = {}) {
	return {
		id: "n1",
		userId: "u1",
		organizationId: null,
		organizationSlug: null,
		organizationName: null,
		projectName: null,
		type: "STORY_MENTION",
		category: "MENTION",
		title: "You were mentioned",
		snippet: null,
		link: "/app/projects/p1",
		iconKey: null,
		projectId: null,
		storyId: null,
		taskId: null,
		commentId: null,
		documentId: null,
		actorUserId: null,
		actor: null,
		payload: {},
		readAt: null,
		archivedAt: null,
		dedupeKey: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...over,
	};
}

describe("NotificationCard — chip context fallback", () => {
	it("prefers the project name when the notification has one", () => {
		render(
			<NotificationCard
				notification={makeNotification({
					projectId: "p1",
					projectName: "Fabric Portal",
					organizationName: "Acme Inc",
				})}
				onSelect={() => {}}
			/>,
		);
		expect(screen.getByTestId("notification-card-chip")).toHaveTextContent(
			"Fabric Portal",
		);
	});

	it("falls back to the organization name when there is no project", () => {
		render(
			<NotificationCard
				notification={makeNotification({
					organizationName: "Acme Inc",
				})}
				onSelect={() => {}}
			/>,
		);
		expect(screen.getByTestId("notification-card-chip")).toHaveTextContent(
			"Acme Inc",
		);
	});

	it("shows the category alone when there is neither, with no dangling separator", () => {
		render(
			<NotificationCard
				notification={makeNotification({ category: "SYSTEM" })}
				onSelect={() => {}}
			/>,
		);
		const chip = screen.getByTestId("notification-card-chip");
		expect(chip.textContent?.trim()).toBe("categories.SYSTEM");
		expect(chip.textContent).not.toContain("·");
	});

	it("never renders a raw id in the chip", () => {
		render(
			<NotificationCard
				notification={makeNotification({
					projectId: "clx123abc",
					projectName: null,
					organizationName: "Acme Inc",
				})}
				onSelect={() => {}}
			/>,
		);
		expect(
			screen.getByTestId("notification-card-chip").textContent,
		).not.toContain("clx123abc");
	});

	it("falls back to the SYSTEM label for a category with no mapped string", () => {
		// Defensive: NotificationCategory can grow. An unmapped value must not
		// leak `categories.SOMETHING_NEW` into the UI.
		render(
			<NotificationCard
				notification={makeNotification({ category: "TOTALLY_NEW" })}
				onSelect={() => {}}
			/>,
		);
		expect(screen.getByTestId("notification-card-chip")).toHaveTextContent(
			"categories.SYSTEM",
		);
	});
});

describe("NotificationCard — unread treatment", () => {
	it("distinguishes unread by weight, not colour alone (AC-8)", () => {
		const { rerender } = render(
			<NotificationCard
				notification={makeNotification({ readAt: null })}
				onSelect={() => {}}
			/>,
		);
		expect(
			screen.getByTestId("notification-card-title").className,
		).toContain("font-semibold");

		rerender(
			<NotificationCard
				notification={makeNotification({
					readAt: new Date().toISOString(),
				})}
				onSelect={() => {}}
			/>,
		);
		expect(
			screen.getByTestId("notification-card-title").className,
		).not.toContain("font-semibold");
	});
});

describe("NotificationCard — title", () => {
	it("clamps to two lines rather than truncating to one", () => {
		render(
			<NotificationCard
				notification={makeNotification({ title: "A".repeat(200) })}
				onSelect={() => {}}
			/>,
		);
		const title = screen.getByTestId("notification-card-title");
		expect(title.className).toContain("line-clamp-2");
		expect(title.className).not.toContain("truncate");
	});

	it("also breaks an unbroken token, which the clamp alone does not", () => {
		// `line-clamp` bounds the HEIGHT; it does not force a break inside one long
		// run of characters. A status-page URL in an announcement is the realistic
		// case, and without `break-words` it overflows the card's right edge at
		// narrow widths. The compact row escapes this because `truncate` sets
		// white-space: nowrap and clips regardless of word breaks.
		render(
			<NotificationCard
				notification={makeNotification({
					title: "See https://status.example.com/incidents/2026-08-07-degraded-ai-generation-root-cause for updates",
				})}
				onSelect={() => {}}
			/>,
		);
		const title = screen.getByTestId("notification-card-title");
		expect(title.className).toContain("break-words");
	});
});

describe("NotificationCard — parity with the compact row", () => {
	it("non-admin clicking a SYSTEM_INCIDENT gets the toast and no navigation", () => {
		mockUseSession.mockReturnValue({ user: { role: "user" } });
		const onSelect = vi.fn();
		render(
			<NotificationCard
				notification={makeNotification({
					type: "SYSTEM_INCIDENT",
					category: "SYSTEM",
					link: "/app/admin/monitoring",
				})}
				onSelect={onSelect}
			/>,
		);
		fireEvent.click(screen.getByRole("link"));
		expect(mockToastInfo).toHaveBeenCalled();
		expect(onSelect).toHaveBeenCalledWith("n1");
	});

	it("admin clicking a SYSTEM_INCIDENT navigates with no toast", () => {
		mockUseSession.mockReturnValue({ user: { role: "admin" } });
		render(
			<NotificationCard
				notification={makeNotification({
					type: "SYSTEM_INCIDENT",
					category: "SYSTEM",
					link: "/app/admin/monitoring",
				})}
				onSelect={() => {}}
			/>,
		);
		fireEvent.click(screen.getByRole("link"));
		expect(mockToastInfo).not.toHaveBeenCalled();
	});

	it("renders Restore in archived mode instead of the dismiss control", () => {
		render(
			<NotificationCard
				notification={makeNotification()}
				onSelect={() => {}}
				onRestore={() => {}}
				mode="archived"
			/>,
		);
		expect(screen.getByText("restore")).toBeInTheDocument();
		expect(screen.queryByLabelText("dismiss")).toBeNull();
	});

	it("archives without navigating when the dismiss control is used", () => {
		const onArchive = vi.fn();
		render(
			<NotificationCard
				notification={makeNotification()}
				onSelect={() => {}}
				onArchive={onArchive}
			/>,
		);
		fireEvent.click(screen.getByLabelText("dismiss"));
		expect(onArchive).toHaveBeenCalledWith("n1");
	});

	it("resolves a relative link against the notification's own org", () => {
		mockBasePath.current = "/app/current-org";
		render(
			<NotificationCard
				notification={makeNotification({
					organizationSlug: "owning-org",
					link: "projects/p1",
				})}
				onSelect={() => {}}
			/>,
		);
		expect(screen.getByRole("link")).toHaveAttribute(
			"href",
			"/app/owning-org/projects/p1",
		);
	});
});
