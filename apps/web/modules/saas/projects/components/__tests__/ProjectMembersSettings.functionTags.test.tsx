/**
 * Admin per-member function-tag display + editing on ProjectMembersSettings
 * (Stage 2+3 UI, Task 4 — Fizzy #1767).
 *
 * Coverage (per task brief):
 *   1. Member rows show tag chips sourced from `functionTags.listForProject`
 *      (e.g. a member with `["DEVELOPER"]` shows a "Developer" chip).
 *   2. A member with no tags renders no chips.
 *   3. When `getProject.canManageMembers` is true, each member row's `⋮`
 *      menu contains "Set function tags" — including the creator/self row,
 *      which the row-level `canManage` (not-self/not-creator) gate would
 *      otherwise exclude (Decision 4, locked). Opening it seeds the dialog
 *      with the member's current tags; saving calls `setForProjectMember`
 *      with `{ projectId, userId, tags, organizationId }` (the project's own
 *      organizationId, not an ambient value) and invalidates the
 *      `listForProject` query cache.
 *   4. When `canManageMembers` is false, "Set function tags" is absent from
 *      every row.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: [
							"projects.members.listSentInvitations",
							input,
						],
						queryFn: listSentInvitations,
					}),
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

function renderSettings() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const utils = render(
		<QueryClientProvider client={client}>
			<ProjectMembersSettings projectId="proj-1" organizationId="org-1" />
		</QueryClientProvider>,
	);
	return { client, ...utils };
}

beforeEach(() => {
	listMembers.mockReset();
	listSentInvitations.mockReset();
	listForProject.mockReset();
	getProject.mockReset();
	setForProjectMember.mockReset();

	listMembers.mockResolvedValue({
		members: [CURRENT_USER_MEMBER, OTHER_MEMBER],
	});
	listSentInvitations.mockResolvedValue({ invitations: [] });
	setForProjectMember.mockResolvedValue({ success: true, tags: [] });
});

describe("ProjectMembersSettings — function tag chips + admin control", () => {
	it("shows tag chips for a member with tags, and none for a member without", async () => {
		getProject.mockResolvedValue({ project: { canManageMembers: false } });
		listForProject.mockResolvedValue({
			members: [
				{ userId: "user-1", functionTags: [] },
				{ userId: "user-2", functionTags: ["DEVELOPER"] },
			],
		});

		renderSettings();

		expect(await screen.findByText("Developer")).toBeInTheDocument();

		// Current user's row (no tags) must not render a chip anywhere.
		const currentUserRow = (
			await screen.findByText("current@example.com")
		).closest("div.flex.items-center.justify-between");
		expect(currentUserRow).not.toBeNull();
		expect(currentUserRow?.textContent).not.toContain("Developer");
	});

	it('shows "Set function tags" on every row (including creator/self) when canManageMembers is true, seeds and saves the dialog, and invalidates listForProject', async () => {
		getProject.mockResolvedValue({ project: { canManageMembers: true } });
		listForProject.mockResolvedValue({
			members: [
				{ userId: "user-1", functionTags: [] },
				{ userId: "user-2", functionTags: ["DEVELOPER"] },
			],
		});
		setForProjectMember.mockResolvedValue({
			success: true,
			tags: ["DEVELOPER", "ARCHITECT"],
		});

		const user = userEvent.setup();
		const { client } = renderSettings();
		const invalidateSpy = vi.spyOn(client, "invalidateQueries");

		await screen.findByText("Developer");

		// Both member-action triggers are visible — including the current
		// user's own (creator) row, which the legacy `canManage` gate
		// (not-self / not-creator) would otherwise hide entirely.
		const triggers = await screen.findAllByLabelText("Member actions");
		expect(triggers).toHaveLength(2);

		// Open the OTHER_MEMBER row's menu and pick "Set function tags".
		await user.click(triggers[1]);
		const setTagsItem = await screen.findByRole("menuitem", {
			name: /set function tags/i,
		});
		await user.click(setTagsItem);

		// Dialog seeded with the member's current tags (Developer chip visible
		// inside the FunctionTagSelect trigger).
		const picker = await screen.findByLabelText("Member function tags");
		expect(picker.textContent).toContain("Developer");

		// Add a second tag, then save.
		await user.click(picker);
		await user.click(await screen.findByText("Architect"));
		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() =>
			expect(setForProjectMember).toHaveBeenCalledWith({
				projectId: "proj-1",
				userId: "user-2",
				tags: ["DEVELOPER", "ARCHITECT"],
				organizationId: "org-1",
			}),
		);

		await waitFor(() =>
			expect(invalidateSpy).toHaveBeenCalledWith({
				queryKey: [
					"functionTags.listForProject",
					{ projectId: "proj-1", organizationId: "org-1" },
				],
			}),
		);

		// Now exercise the creator/self row (index 0) — must ALSO offer "Set
		// function tags" despite failing the not-self/not-creator `canManage`
		// check (Decision 4: gated ONLY on canManageMembers).
		await user.click(triggers[0]);
		expect(
			await screen.findByRole("menuitem", { name: /set function tags/i }),
		).toBeInTheDocument();
		// The role-management items remain restricted to manageable members —
		// the creator/self row must not offer them.
		expect(
			screen.queryByRole("menuitem", { name: /change role/i }),
		).toBeNull();
		expect(
			screen.queryByRole("menuitem", { name: /remove member/i }),
		).toBeNull();
	});

	it('hides "Set function tags" on every row when canManageMembers is false', async () => {
		getProject.mockResolvedValue({ project: { canManageMembers: false } });
		listForProject.mockResolvedValue({
			members: [
				{ userId: "user-1", functionTags: [] },
				{ userId: "user-2", functionTags: ["DEVELOPER"] },
			],
		});

		const user = userEvent.setup();
		renderSettings();

		await screen.findByText("Developer");

		// `canManageMembers` is independent of the legacy `currentUserIsOwner` /
		// `canManage` (not-self / not-creator) role-management gate. The
		// current user is OWNER + creator here, so OTHER_MEMBER's row still
		// gets an action menu (role management), but WITHOUT "Set function
		// tags" — and the creator/self row gets no menu at all (fails both
		// `canManage` and `canManageMembers`).
		const triggers = await screen.findAllByLabelText("Member actions");
		expect(triggers).toHaveLength(1);

		await user.click(triggers[0]);
		expect(
			await screen.findByRole("menuitem", { name: /change role/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: /set function tags/i }),
		).toBeNull();
	});

	it("disables 'Set function tags' until listForProject resolves, then seeds the member's real tags (save-before-load guard)", async () => {
		getProject.mockResolvedValue({ project: { canManageMembers: true } });

		// Hold the tags query open so we can observe the pre-load state — a
		// member row can render (with canManageFunctionTags already true) before
		// tags arrive, and without the load-gate `openTagDialog` would seed an
		// empty draft that Save would persist over the member's real tags.
		let resolveTags!: (v: {
			members: { userId: string; functionTags: string[] }[];
		}) => void;
		listForProject.mockReturnValue(
			new Promise((resolve) => {
				resolveTags = resolve;
			}),
		);

		const user = userEvent.setup();
		renderSettings();

		// Member rows render off `listMembers` (resolved), independent of the
		// still-pending tags query.
		const triggers = await screen.findAllByLabelText("Member actions");
		await user.click(triggers[1]);

		const setTagsItem = await screen.findByRole("menuitem", {
			name: /set function tags/i,
		});
		// Loading → the control is disabled, so no empty seed can be opened and
		// Saved over the member's real tags.
		expect(setTagsItem).toHaveAttribute("aria-disabled", "true");

		// Resolve → the control enables and now seeds the member's REAL tags.
		resolveTags({
			members: [
				{ userId: "user-1", functionTags: [] },
				{ userId: "user-2", functionTags: ["DEVELOPER"] },
			],
		});

		await waitFor(() =>
			expect(
				screen.getByRole("menuitem", {
					name: /set function tags/i,
				}),
			).not.toHaveAttribute("aria-disabled", "true"),
		);

		await user.click(
			screen.getByRole("menuitem", { name: /set function tags/i }),
		);
		const picker = await screen.findByLabelText("Member function tags");
		expect(picker.textContent).toContain("Developer");

		// The empty-seed set was never persisted while loading.
		expect(setForProjectMember).not.toHaveBeenCalled();
	});

	it("disables 'Set function tags' when listForProject REJECTS (React Query v5: isLoading goes false on error too), so no empty-seed save can fire", async () => {
		getProject.mockResolvedValue({ project: { canManageMembers: true } });

		// A terminal error, not a pending state. In React Query v5,
		// `isLoading` is `isPending && isFetching`, so once this query
		// errors, `isLoading` is already `false` — a gate written as
		// `disabled={functionTagsLoading}` would have re-enabled the control
		// here even though `functionTagsData` never arrived, letting
		// `openTagDialog` seed an empty draft and Save persist `{ tags: [] }`
		// over the member's real tags. The fix gates on `!functionTagsData`
		// instead, which stays true on the error path.
		listForProject.mockRejectedValue(new Error("network down"));

		const user = userEvent.setup();
		renderSettings();

		const triggers = await screen.findAllByLabelText("Member actions");
		await user.click(triggers[1]);

		const setTagsItem = await screen.findByRole("menuitem", {
			name: /set function tags/i,
		});

		await waitFor(() =>
			expect(setTagsItem).toHaveAttribute("aria-disabled", "true"),
		);

		// jsdom doesn't resolve the `data-disabled:pointer-events-none`
		// Tailwind rule that blocks a real click, so exercise the click
		// anyway and rely on the SECOND, defense-in-depth gate on the
		// dialog's Save button (a real HTML `disabled` attribute, which
		// jsdom/user-event DOES honor) to prove the open path is blocked
		// end-to-end: no empty-seed save can ever reach the server.
		await user.click(setTagsItem);
		const picker = screen.queryByLabelText("Member function tags");
		if (picker) {
			const saveButton = screen.getByRole("button", { name: /^save$/i });
			expect(saveButton).toBeDisabled();
			await user.click(saveButton);
		}
		expect(setForProjectMember).not.toHaveBeenCalled();
	});
});
