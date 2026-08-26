import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockInvitationFindMany,
	mockMemberFindMany, // db.projectMember.findMany (recent-member source)
	mockOrgMemberFindMany, // db.member.findMany (userOrgIds, personal scope)
	mockUserFindMany,
	mockInvitationFindFirst,
	mockMemberFindFirst, // db.projectMember.findFirst (Task 2 — add now)
	mockPrefUpsert,
} = vi.hoisted(() => ({
	mockInvitationFindMany: vi.fn(),
	mockMemberFindMany: vi.fn(),
	mockOrgMemberFindMany: vi.fn(),
	mockUserFindMany: vi.fn(),
	mockInvitationFindFirst: vi.fn(),
	mockMemberFindFirst: vi.fn(),
	mockPrefUpsert: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		projectInvitation: {
			findMany: (...a: unknown[]) => mockInvitationFindMany(...a),
			findFirst: (...a: unknown[]) => mockInvitationFindFirst(...a),
		},
		projectMember: {
			findMany: (...a: unknown[]) => mockMemberFindMany(...a),
			findFirst: (...a: unknown[]) => mockMemberFindFirst(...a),
		},
		member: { findMany: (...a: unknown[]) => mockOrgMemberFindMany(...a) },
		user: { findMany: (...a: unknown[]) => mockUserFindMany(...a) },
		projectUserPreference: {
			upsert: (...a: unknown[]) => mockPrefUpsert(...a),
		},
	},
	Prisma: {},
}));

import {
	dismissInviteWelcomeWidget,
	getInviteWelcomeWidgetData,
	getUserPendingInviteForProject,
	getUserRecentMemberForProject,
} from "../members";

function invite(
	over: Partial<{
		id: string;
		invitedBy: string;
		role: string;
		createdAt: Date;
		expiresAt: Date;
		projectId: string;
		projectName: string;
		description: string | null;
		heroImageUrl: string | null;
		heroEmojis: string[];
		icon: string | null;
		color: string | null;
		organizationId: string | null;
		organizationSlug: string | null;
		userPreferences: Array<{
			inviteWidgetDismissedInviteExpiry: Date | null;
		}>;
	}> = {},
) {
	return {
		id: over.id ?? "inv-1",
		invitedBy: over.invitedBy ?? "user-inviter",
		role: over.role ?? "VIEWER",
		createdAt: over.createdAt ?? new Date("2026-06-01T00:00:00Z"),
		expiresAt: over.expiresAt ?? new Date("2026-06-08T00:00:00Z"),
		project: {
			id: over.projectId ?? "proj-1",
			name: over.projectName ?? "Fabric Main",
			description: over.description ?? "A platform",
			heroImageUrl: over.heroImageUrl ?? null,
			heroEmojis: over.heroEmojis ?? [],
			icon: over.icon ?? null,
			color: over.color ?? null,
			organizationId: over.organizationId ?? null,
			organization: over.organizationSlug
				? { slug: over.organizationSlug }
				: null,
			userPreferences: over.userPreferences ?? [],
		},
	};
}

function memberRow(
	over: Partial<{
		invitedBy: string;
		role: string;
		acceptedAt: Date;
		expiresAt: Date | null;
		projectId: string;
		projectName: string;
		organizationId: string | null;
		organizationSlug: string | null;
		dismissedAt: Date | null;
	}> = {},
) {
	return {
		invitedBy: over.invitedBy ?? "user-inviter",
		role: over.role ?? "VIEWER",
		acceptedAt: over.acceptedAt ?? new Date("2026-06-16T00:00:00Z"),
		expiresAt: over.expiresAt ?? null,
		project: {
			id: over.projectId ?? "pm-1",
			name: over.projectName ?? "Joined Project",
			description: null,
			heroImageUrl: null,
			heroEmojis: [],
			icon: null,
			color: null,
			organizationId: over.organizationId ?? null,
			organization: over.organizationSlug
				? { slug: over.organizationSlug }
				: null,
			userPreferences:
				over.dismissedAt !== undefined
					? [{ inviteWidgetDismissedAt: over.dismissedAt }]
					: [],
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockMemberFindMany.mockResolvedValue([]);
	mockOrgMemberFindMany.mockResolvedValue([]);
	mockMemberFindFirst.mockResolvedValue(null);
	mockUserFindMany.mockResolvedValue([
		{ id: "user-inviter", name: "Avery", image: null, banned: false },
	]);
});

describe("getInviteWelcomeWidgetData", () => {
	it("returns the most recent invite and total count", async () => {
		mockInvitationFindMany.mockResolvedValue([
			invite({
				id: "a",
				projectId: "p-a",
				projectName: "Alpha",
				expiresAt: new Date("2026-06-08T00:00:00Z"),
			}),
			invite({
				id: "b",
				projectId: "p-b",
				projectName: "Bravo",
				expiresAt: new Date("2026-06-10T00:00:00Z"),
			}),
		]);
		const res = await getInviteWelcomeWidgetData(
			"ME@x.com",
			"user-me",
			null,
		);
		expect(res.totalCount).toBe(2);
		expect(res.mostRecent?.kind).toBe("invite");
		expect(
			res.mostRecent?.kind === "invite" && res.mostRecent.invitationId,
		).toBe("b"); // later expiresAt = most recently issued
		expect(res.mostRecent?.inviter).toEqual({
			name: "Avery",
			image: null,
			banned: false,
		});
	});

	it("normalizes the email to lowercase for the query", async () => {
		mockInvitationFindMany.mockResolvedValue([]);
		await getInviteWelcomeWidgetData("ME@X.com", "user-me", null);
		expect(mockInvitationFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ email: "me@x.com" }),
			}),
		);
	});

	it("filters org vs personal via the project relation (XOR)", async () => {
		mockInvitationFindMany.mockResolvedValue([]);
		await getInviteWelcomeWidgetData("me@x.com", "user-me", "org-9");
		expect(mockInvitationFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					project: { organizationId: "org-9" },
				}),
			}),
		);
	});

	it("suppresses invites at/under the dismissal watermark but keeps re-invites", async () => {
		mockInvitationFindMany.mockResolvedValue([
			invite({
				id: "dismissed",
				projectName: "Dismissed",
				expiresAt: new Date("2026-06-08T00:00:00Z"),
				userPreferences: [
					{
						inviteWidgetDismissedInviteExpiry: new Date(
							"2026-06-08T00:00:00Z",
						),
					},
				],
			}),
			invite({
				id: "reinvited",
				projectName: "Reinvited",
				expiresAt: new Date("2026-06-20T00:00:00Z"),
				userPreferences: [
					{
						inviteWidgetDismissedInviteExpiry: new Date(
							"2026-06-08T00:00:00Z",
						),
					},
				],
			}),
		]);
		const res = await getInviteWelcomeWidgetData(
			"me@x.com",
			"user-me",
			null,
		);
		expect(res.totalCount).toBe(1);
		expect(
			res.mostRecent?.kind === "invite" && res.mostRecent.invitationId,
		).toBe("reinvited");
	});

	it("maps a banned inviter through (component decides the fallback copy)", async () => {
		mockUserFindMany.mockResolvedValue([
			{ id: "user-inviter", name: "Avery", image: null, banned: true },
		]);
		mockInvitationFindMany.mockResolvedValue([invite({ id: "a" })]);
		const res = await getInviteWelcomeWidgetData(
			"me@x.com",
			"user-me",
			null,
		);
		expect(res.mostRecent?.inviter?.banned).toBe(true);
	});

	it("returns inviter null when the inviter user no longer exists", async () => {
		mockUserFindMany.mockResolvedValue([]);
		mockInvitationFindMany.mockResolvedValue([invite({ id: "a" })]);
		const res = await getInviteWelcomeWidgetData(
			"me@x.com",
			"user-me",
			null,
		);
		expect(res.mostRecent?.inviter).toBeNull();
	});

	it("returns null mostRecent and 0 count when there are no invites", async () => {
		mockInvitationFindMany.mockResolvedValue([]);
		const res = await getInviteWelcomeWidgetData(
			"me@x.com",
			"user-me",
			null,
		);
		expect(res).toEqual({ mostRecent: null, totalCount: 0 });
	});
});

describe("getInviteWelcomeWidgetData — recent-member source", () => {
	it("surfaces a recently-accepted membership as a member-kind entry", async () => {
		mockInvitationFindMany.mockResolvedValue([]);
		mockMemberFindMany.mockResolvedValue([
			memberRow({
				projectId: "pm-1",
				projectName: "Joined",
				acceptedAt: new Date("2026-06-16T00:00:00Z"),
			}),
		]);
		const res = await getInviteWelcomeWidgetData(
			"me@x.com",
			"user-me",
			null,
		);
		expect(res.totalCount).toBe(1);
		expect(res.mostRecent?.kind).toBe("member");
		expect(res.mostRecent?.projectId).toBe("pm-1");
		expect(res.mostRecent && "acceptedAt" in res.mostRecent).toBe(true);
	});

	it("ranks an actionable pending invite above a passive membership", async () => {
		mockInvitationFindMany.mockResolvedValue([
			invite({ id: "inv", projectId: "p-inv" }),
		]);
		mockMemberFindMany.mockResolvedValue([
			memberRow({ projectId: "p-mem" }),
		]);
		const res = await getInviteWelcomeWidgetData(
			"me@x.com",
			"user-me",
			null,
		);
		expect(res.totalCount).toBe(2);
		expect(res.mostRecent?.kind).toBe("invite");
	});

	it("dedups by projectId, keeping the invite over the membership", async () => {
		mockInvitationFindMany.mockResolvedValue([
			invite({ id: "inv", projectId: "dup" }),
		]);
		mockMemberFindMany.mockResolvedValue([memberRow({ projectId: "dup" })]);
		const res = await getInviteWelcomeWidgetData(
			"me@x.com",
			"user-me",
			null,
		);
		expect(res.totalCount).toBe(1);
		expect(res.mostRecent?.kind).toBe("invite");
	});

	it("breaks ties deterministically by projectId when name+timestamps match", async () => {
		const acceptedAt = new Date("2026-06-16T00:00:00Z");
		mockInvitationFindMany.mockResolvedValue([]);
		mockMemberFindMany.mockResolvedValue([
			memberRow({ projectId: "p-zzz", projectName: "Same", acceptedAt }),
			memberRow({ projectId: "p-aaa", projectName: "Same", acceptedAt }),
		]);
		const res = await getInviteWelcomeWidgetData(
			"me@x.com",
			"user-me",
			null,
		);
		expect(res.mostRecent?.projectId).toBe("p-aaa");
	});

	it("hides a membership at/under the dismissal watermark, surfaces a newer acceptedAt (re-add)", async () => {
		const dismissedAt = new Date("2026-06-10T00:00:00Z");
		mockInvitationFindMany.mockResolvedValue([]);
		mockMemberFindMany.mockResolvedValue([
			memberRow({
				projectId: "old",
				acceptedAt: new Date("2026-06-09T00:00:00Z"),
				dismissedAt,
			}),
			memberRow({
				projectId: "new",
				acceptedAt: new Date("2026-06-15T00:00:00Z"),
				dismissedAt,
			}),
		]);
		const res = await getInviteWelcomeWidgetData(
			"me@x.com",
			"user-me",
			null,
		);
		expect(res.totalCount).toBe(1);
		expect(res.mostRecent?.projectId).toBe("new");
	});

	it("personal context surfaces guest memberships (org NOT in userOrgIds) and excludes own-org rows", async () => {
		mockOrgMemberFindMany.mockResolvedValue([
			{ organizationId: "org-mine" },
		]);
		mockInvitationFindMany.mockResolvedValue([]);
		mockMemberFindMany.mockResolvedValue([]);
		await getInviteWelcomeWidgetData("me@x.com", "user-me", null);
		const expectedScope = {
			OR: [
				{ organizationId: null },
				{ organizationId: { notIn: ["org-mine"] } },
			],
		};
		expect(mockInvitationFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ project: expectedScope }),
			}),
		);
		expect(mockMemberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					project: expect.objectContaining({
						...expectedScope,
						userId: { not: "user-me" },
					}),
				}),
			}),
		);
	});

	it("zero-org guest: personal context applies no org constraint (notIn empty-array trap avoided)", async () => {
		mockOrgMemberFindMany.mockResolvedValue([]);
		mockInvitationFindMany.mockResolvedValue([]);
		mockMemberFindMany.mockResolvedValue([]);
		await getInviteWelcomeWidgetData("me@x.com", "user-me", null);
		expect(mockInvitationFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ project: {} }),
			}),
		);
	});

	it("org context keeps strict XOR for both sources and never queries userOrgIds", async () => {
		mockInvitationFindMany.mockResolvedValue([]);
		mockMemberFindMany.mockResolvedValue([]);
		await getInviteWelcomeWidgetData("me@x.com", "user-me", "org-9");
		expect(mockOrgMemberFindMany).not.toHaveBeenCalled();
		expect(mockMemberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					project: {
						organizationId: "org-9",
						userId: { not: "user-me" },
					},
				}),
			}),
		);
	});
});

describe("getUserPendingInviteForProject", () => {
	it("returns the in-scope pending invite (id, expiry, project org)", async () => {
		mockInvitationFindFirst.mockResolvedValue({
			id: "inv-7",
			expiresAt: new Date("2026-06-09T00:00:00Z"),
			project: { organizationId: "org-2" },
		});
		const res = await getUserPendingInviteForProject(
			"ME@x.com",
			"user-me",
			"proj-7",
			"org-2",
		);
		expect(res).toEqual({
			id: "inv-7",
			expiresAt: new Date("2026-06-09T00:00:00Z"),
			projectOrganizationId: "org-2",
		});
		expect(mockInvitationFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "proj-7",
					email: "me@x.com",
					status: "PENDING",
					project: { organizationId: "org-2" },
				}),
			}),
		);
	});

	it("returns null when there is no matching pending invite", async () => {
		mockInvitationFindFirst.mockResolvedValue(null);
		const res = await getUserPendingInviteForProject(
			"me@x.com",
			"user-me",
			"proj-x",
			null,
		);
		expect(res).toBeNull();
	});
});

describe("getUserRecentMemberForProject", () => {
	it("returns the in-scope recent membership (acceptedAt + project org)", async () => {
		mockMemberFindFirst.mockResolvedValue({
			acceptedAt: new Date("2026-06-16T00:00:00Z"),
			project: { organizationId: "org-2" },
		});
		const res = await getUserRecentMemberForProject(
			"user-me",
			"pm-1",
			"org-2",
		);
		expect(res).toEqual({
			acceptedAt: new Date("2026-06-16T00:00:00Z"),
			projectOrganizationId: "org-2",
		});
		expect(mockMemberFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "pm-1",
					userId: "user-me",
					// scope ALSO excludes self-owned projects (matches the
					// recent-member source in getInviteWelcomeWidgetData)
					project: expect.objectContaining({
						organizationId: "org-2",
					}),
				}),
			}),
		);
	});

	it("returns null when there is no matching recent membership", async () => {
		mockMemberFindFirst.mockResolvedValue(null);
		expect(
			await getUserRecentMemberForProject("user-me", "pm-x", null),
		).toBeNull();
	});
});

describe("getUserPendingInviteForProject — guest scoping", () => {
	it("uses the personal+guest scope (not bare organizationId:null) in personal context", async () => {
		mockOrgMemberFindMany.mockResolvedValue([
			{ organizationId: "org-mine" },
		]);
		mockInvitationFindFirst.mockResolvedValue(null);
		// NEW 4-arg signature: (email, userId, projectId, organizationId?)
		await getUserPendingInviteForProject(
			"me@x.com",
			"user-me",
			"proj-1",
			null,
		);
		expect(mockInvitationFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "proj-1",
					email: "me@x.com",
					project: {
						OR: [
							{ organizationId: null },
							{ organizationId: { notIn: ["org-mine"] } },
						],
					},
				}),
			}),
		);
	});
});

describe("dismissInviteWelcomeWidget", () => {
	it("upserts the preference with the watermark and project org", async () => {
		mockPrefUpsert.mockResolvedValue({});
		const expiry = new Date("2026-06-09T00:00:00Z");
		await dismissInviteWelcomeWidget({
			projectId: "proj-7",
			userId: "user-me",
			organizationId: "org-2",
			dismissedInviteExpiry: expiry,
		});
		expect(mockPrefUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId_userId: {
						projectId: "proj-7",
						userId: "user-me",
					},
				},
				create: expect.objectContaining({
					projectId: "proj-7",
					userId: "user-me",
					organizationId: "org-2",
					inviteWidgetDismissedInviteExpiry: expiry,
				}),
				update: expect.objectContaining({
					organizationId: "org-2",
					inviteWidgetDismissedInviteExpiry: expiry,
				}),
			}),
		);
	});

	it("member-only dismissal (no expiry) omits inviteWidgetDismissedInviteExpiry so it can't lower an existing watermark", async () => {
		mockPrefUpsert.mockResolvedValue({});
		await dismissInviteWelcomeWidget({
			projectId: "pm-1",
			userId: "user-me",
			organizationId: "org-host",
			// dismissedInviteExpiry omitted (member-only)
		});
		const call = mockPrefUpsert.mock.calls[0][0];
		expect(call.update).not.toHaveProperty(
			"inviteWidgetDismissedInviteExpiry",
		);
		expect(call.create).not.toHaveProperty(
			"inviteWidgetDismissedInviteExpiry",
		);
		expect(call.update).toMatchObject({ organizationId: "org-host" });
		expect(call.update.inviteWidgetDismissedAt).toBeInstanceOf(Date);
	});
});
