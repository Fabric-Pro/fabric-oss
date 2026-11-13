/**
 * Inviting needs PROJECT_MEMBERS_MANAGE on the server, which project admins
 * hold, but the page only offered it to owners. The org-member picker has to be
 * reachable by the people the card names (Fizzy #1986, FR6), and they have to
 * see the invitations they send.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the import of ProjectMembersSettings.
// ----------------------------------------------------------------------------

// The global next-intl mock (vitest.setup.ts) returns a key-echoing function
// with no `.raw`. ProjectMembersSettings calls `t.raw("removeMember")` and
// `t.raw("revokeInvitation")` unconditionally at render (for
// `DestructiveTooltip` copy), so extend the mock locally (mirrors
// ReviewCenterRow.test.tsx's technique).
vi.mock("next-intl", () => {
	function makeT() {
		const t = (key: string) => key;
		(t as unknown as { raw: (k: string) => unknown }).raw = (
			k: string,
		) => ({
			label: `${k}.label`,
			warning: `Warning: ${k}.warning`,
		});
		return t;
	}
	return {
		useTranslations: () => makeT(),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: unknown }) =>
			children,
	};
});

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "user-1", name: "Current User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

const listMembers = vi.fn();
const listSentInvitations = vi.fn();
const listForProject = vi.fn();
const getProject = vi.fn();
const setForProjectMember = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			members: {
				invite: vi.fn(),
				remove: vi.fn(),
				updateRole: vi.fn(),
				resendInvitation: vi.fn(),
				revokeInvitation: vi.fn(),
			},
		},
		functionTags: {
			setForProjectMember: (input: unknown) => setForProjectMember(input),
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			members: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.members.list", input],
						queryFn: listMembers,
					}),
				},
				listSentInvitations: {
					queryOptions: ({
						input,
						enabled,
					}: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						queryKey: [
							"projects.members.listSentInvitations",
							input,
						],
						queryFn: listSentInvitations,
						enabled,
					}),
					queryKey: ({ input }: { input: unknown }) => [
						"projects.members.listSentInvitations",
						input,
					],
				},
				lookupEmail: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.members.lookupEmail", input],
						queryFn: async () => ({ status: "no_account" }),
					}),
				},
			},
			get: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.get", input],
					queryFn: getProject,
				}),
			},
		},
		functionTags: {
			listForProject: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["functionTags.listForProject", input],
					queryFn: listForProject,
				}),
				queryKey: ({ input }: { input: unknown }) => [
					"functionTags.listForProject",
					input,
				],
			},
		},
	},
}));

import { ProjectMembersSettings } from "../ProjectMembersSettings";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const CURRENT_USER_MEMBER = {
	userId: "user-1",
	role: "OWNER",
	user: { id: "user-1", name: "Current User", email: "current@example.com" },
	isOwner: true,
	isCreator: true,
	isGuest: false,
	invitedAt: null,
	acceptedAt: new Date("2026-01-01"),
	expiresAt: null,
};

const OTHER_MEMBER = {
	userId: "user-2",
	role: "EDITOR",
	user: { id: "user-2", name: "Other Member", email: "other@example.com" },
	isOwner: false,
	isCreator: false,
	isGuest: false,
	invitedAt: null,
	acceptedAt: new Date("2026-01-01"),
	expiresAt: null,
};

const ownerRow = {
	id: "m-owner",
	userId: "user-2",
	role: "OWNER",
	isOwner: true,
	user: {
		id: "user-2",
		name: "Owner",
		email: "owner@example.com",
		image: null,
	},
	invitedAt: null,
	acceptedAt: null,
};

function members(role: string, isOwner = false) {
	return {
		members: [
			ownerRow,
			{
				...ownerRow,
				id: "m-self",
				userId: "user-1",
				role,
				isOwner,
				user: { ...ownerRow.user, id: "user-1", name: "Current User" },
			},
		],
	};
}

function renderPage(organizationId: string | null) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ProjectMembersSettings
				projectId="proj_1"
				organizationId={organizationId}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	listSentInvitations.mockResolvedValue({ invitations: [] });
	listForProject.mockResolvedValue({ members: [] });
});

describe("ProjectMembersSettings — who can invite", () => {
	it("gives a project admin the picker, the invite form and the pending list", async () => {
		listMembers.mockResolvedValue(members("PROJECT_ADMIN"));
		getProject.mockResolvedValue({ project: { canManageMembers: true } });

		renderPage("org_example");

		expect(
			await screen.findByRole("button", {
				name: "Add from organization",
			}),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Invite Member" }),
		).toBeTruthy();
		expect(screen.getByText("Pending Invitations")).toBeTruthy();
		expect(listSentInvitations).toHaveBeenCalled();
	});

	it("gives an editor none of them", async () => {
		listMembers.mockResolvedValue(members("EDITOR"));
		getProject.mockResolvedValue({ project: { canManageMembers: false } });

		renderPage("org_example");

		await screen.findAllByText("Owner");
		expect(
			screen.queryByRole("button", { name: "Add from organization" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Invite Member" }),
		).toBeNull();
		expect(screen.queryByText("Pending Invitations")).toBeNull();
		expect(listSentInvitations).not.toHaveBeenCalled();
	});

	it("does not tell a project admin that only owners can invite", async () => {
		listMembers.mockResolvedValue(members("PROJECT_ADMIN"));
		getProject.mockResolvedValue({ project: { canManageMembers: true } });

		renderPage("org_example");

		await screen.findByRole("button", { name: "Invite Member" });
		expect(
			screen.queryByText(/can invite members and manage roles/),
		).toBeNull();
	});

	it("tells an editor who can invite", async () => {
		listMembers.mockResolvedValue(members("EDITOR"));
		getProject.mockResolvedValue({ project: { canManageMembers: false } });

		renderPage("org_example");

		expect(
			await screen.findByText(
				"Only project owners and project admins can invite members and manage roles.",
			),
		).toBeTruthy();
	});

	it("does not show that notice while the project is still loading", async () => {
		listMembers.mockResolvedValue(members("PROJECT_ADMIN"));
		getProject.mockReturnValue(new Promise(() => {}));

		renderPage("org_example");

		await screen.findByText("Current User");
		expect(
			screen.queryByText(/can invite members and manage roles/),
		).toBeNull();
	});

	it("has nobody to pick from on a personal project", async () => {
		listMembers.mockResolvedValue(members("OWNER", true));
		getProject.mockResolvedValue({ project: { canManageMembers: true } });

		renderPage(null);

		expect(
			await screen.findByRole("button", { name: "Invite Member" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Add from organization" }),
		).toBeNull();
	});
});

describe("ProjectMembersSettings — who can change roles and remove members", () => {
	function row(userId: string, name: string, role: string) {
		return {
			id: `m-${userId}`,
			userId,
			role,
			isOwner: role === "OWNER",
			isCreator: false,
			isGuest: false,
			user: {
				id: userId,
				name,
				email: `${userId}@example.com`,
				image: null,
			},
			invitedAt: null,
			acceptedAt: null,
		};
	}

	async function menuItemsFor(userId: string) {
		const user = userEvent.setup();
		const line = (await screen.findByText(`${userId}@example.com`)).closest(
			"div.flex.items-center.justify-between",
		) as HTMLElement;
		await user.click(within(line).getByLabelText("Member actions"));
		const items = (await screen.findAllByRole("menuitem")).map(
			(item) => item.textContent,
		);
		await user.keyboard("{Escape}");
		return items;
	}

	it("lets a project admin manage a non-owner but not an owner", async () => {
		listMembers.mockResolvedValue({
			members: [
				row("user-2", "Some Owner", "OWNER"),
				row("user-1", "Current User", "PROJECT_ADMIN"),
				row("user-3", "Some Editor", "EDITOR"),
			],
		});
		getProject.mockResolvedValue({ project: { canManageMembers: true } });

		renderPage("org_example");

		expect(await menuItemsFor("user-3")).toEqual(
			expect.arrayContaining(["Change Role", "Remove Member"]),
		);
		const ownerItems = await menuItemsFor("user-2");
		expect(ownerItems).not.toContain("Change Role");
		expect(ownerItems).not.toContain("Remove Member");
	});

	it("gives an editor no member actions, even on another non-owner", async () => {
		listMembers.mockResolvedValue({
			members: [
				row("user-2", "Some Owner", "OWNER"),
				row("user-1", "Current User", "EDITOR"),
				row("user-3", "Some Editor", "EDITOR"),
			],
		});
		getProject.mockResolvedValue({ project: { canManageMembers: false } });

		renderPage("org_example");

		await screen.findByText("user-3@example.com");
		await screen.findByText(
			"Only project owners and project admins can invite members and manage roles.",
		);
		expect(screen.queryByLabelText("Member actions")).toBeNull();
	});

	it("still lets an owner manage another owner", async () => {
		listMembers.mockResolvedValue({
			members: [
				row("user-2", "Some Owner", "OWNER"),
				row("user-1", "Current User", "OWNER"),
			],
		});
		getProject.mockResolvedValue({ project: { canManageMembers: true } });

		renderPage("org_example");

		expect(await menuItemsFor("user-2")).toEqual(
			expect.arrayContaining(["Change Role", "Remove Member"]),
		);
	});
});
