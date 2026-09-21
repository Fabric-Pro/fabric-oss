/**
 * Tests for the non-member contact register procedures (#2340):
 * `contacts.list` / `.create` / `.update` / `.delete`.
 *
 * Two seams, the same split this repository uses elsewhere (see
 * `modules/function-tags/procedures/__tests__/project.test.ts`):
 *
 *  1. **Schema level.** `.input()` is a no-op in the stubbed procedure chain
 *     below, so the field schemas are imported from `../shared` and parsed
 *     directly. That is where the empty/whitespace/over-long name cases live.
 *
 *  2. **Handler level.** The `@repo/database` helpers are mocked, so what is
 *     asserted is the ARGUMENTS the handler sends them (which organization,
 *     which id) and the audit payload — not Prisma behaviour, which is pinned
 *     in `packages/database/__tests__/non-member-contacts.test.ts`.
 *
 * The permission GATE cannot be exercised here: `.use()` is a no-op in the
 * stub. What this file pins is the DECLARATION — which permission each
 * procedure asks for, and that it passes `requireOrganization: true`. That the
 * declaration actually refuses a non-member, an under-privileged member and a
 * null organization is pinned against the real middleware in
 * `contacts-authorization.test.ts`, and the two files agree by using the same
 * permission key names.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/todos
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { INPUT_BOUNDS } from "../../../../../lib/zod-bounds";
import {
	contactNameSchema,
	optionalContactCompanySchema,
	optionalContactEmailSchema,
} from "../shared";

// ---------------------------------------------------------------------------
// Schema level — the real guard behind `.input(...)`
// ---------------------------------------------------------------------------

describe("contact field schemas", () => {
	it("requires a name", () => {
		expect(contactNameSchema.safeParse("").success).toBe(false);
	});

	it("rejects a whitespace-only name", () => {
		// Without the trim-before-min, this creates a row that renders as a
		// blank line in the register and can never be searched for.
		expect(contactNameSchema.safeParse("   \t  ").success).toBe(false);
	});

	it("trims a name rather than storing the padding", () => {
		const parsed = contactNameSchema.parse("  Dana Reyes  ");
		expect(parsed).toBe("Dana Reyes");
	});

	it("accepts a name at the ceiling and rejects one character more", () => {
		expect(
			contactNameSchema.safeParse("x".repeat(INPUT_BOUNDS.name)).success,
		).toBe(true);
		expect(
			contactNameSchema.safeParse("x".repeat(INPUT_BOUNDS.name + 1))
				.success,
		).toBe(false);
	});

	it("accepts a contact with no email and no company at all", () => {
		// The whole point of the register: a name is enough.
		expect(optionalContactEmailSchema.safeParse(undefined).success).toBe(
			true,
		);
		expect(optionalContactCompanySchema.safeParse(undefined).success).toBe(
			true,
		);
	});

	it("treats null and blank as ways of clearing email and company", () => {
		expect(optionalContactEmailSchema.safeParse(null).success).toBe(true);
		expect(optionalContactEmailSchema.safeParse("").success).toBe(true);
		expect(optionalContactEmailSchema.safeParse("  ").success).toBe(true);
		expect(optionalContactCompanySchema.safeParse(null).success).toBe(true);
	});

	it("rejects an email that is not one", () => {
		expect(
			optionalContactEmailSchema.safeParse("dana-at-example").success,
		).toBe(false);
		expect(
			optionalContactEmailSchema.safeParse("dana@example.com").success,
		).toBe(true);
	});

	it("bounds email and company", () => {
		expect(
			optionalContactCompanySchema.safeParse(
				"x".repeat(INPUT_BOUNDS.name + 1),
			).success,
		).toBe(false);
		expect(
			optionalContactEmailSchema.safeParse(
				`${"x".repeat(INPUT_BOUNDS.name)}@example.com`,
			).success,
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Handler level
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	listNonMemberContacts: vi.fn(),
	findNonMemberContactsByName: vi.fn(),
	createNonMemberContact: vi.fn(),
	updateNonMemberContact: vi.fn(),
	redactNonMemberContact: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	captured: {} as Record<
		string,
		(args: { context: any; input: any }) => Promise<any>
	>,
	declared: {} as Record<
		string,
		{ permission: string; options?: { requireOrganization?: boolean } }[]
	>,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		listNonMemberContacts: mocks.listNonMemberContacts,
		findNonMemberContactsByName: mocks.findNonMemberContactsByName,
		createNonMemberContact: mocks.createNonMemberContact,
		updateNonMemberContact: mocks.updateNonMemberContact,
		redactNonMemberContact: mocks.redactNonMemberContact,
	};
});

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		mocks.recordAuditFromRequest(...args),
}));

// Stub the procedure builder so the raw handlers can be extracted. `.input()`
// and `.route()` are intentionally no-ops — see the file header. `.use()` is
// not: it records what each procedure declared.
vi.mock("../../../../../orpc/procedures", () => {
	let pendingKey = "";
	const chainable: any = {
		use: (declaration: {
			permission: string;
			options?: { requireOrganization?: boolean };
		}) => {
			mocks.declared[pendingKey] ??= [];
			mocks.declared[pendingKey].push(declaration);
			return chainable;
		},
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.captured[pendingKey] = fn as any;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		// Mirrors the real resolver: an explicit string wins, an explicit null
		// means "no organization" and deliberately does NOT fall back to the
		// session, and `undefined` falls back.
		resolveOrganizationId: vi.fn(
			(
				organizationId: string | null | undefined,
				session?: { activeOrganizationId?: string | null },
			) => {
				if (organizationId) {
					return organizationId;
				}
				if (organizationId === null) {
					return undefined;
				}
				return session?.activeOrganizationId ?? undefined;
			},
		),
		requireInputOrgPermission: vi.fn(
			(
				permission: string,
				options?: { requireOrganization?: boolean },
			) => ({ permission, options }),
		),
		Permissions: new Proxy({}, { get: (_: unknown, prop: string) => prop }),
		__setPendingHandlerKey(key: string) {
			pendingKey = key;
		},
	};
});

const procedures = await import("../../../../../orpc/procedures");
const setSlot = (
	procedures as unknown as { __setPendingHandlerKey: (key: string) => void }
).__setPendingHandlerKey;

setSlot("list");
await import("../list");

setSlot("create");
await import("../create");

setSlot("update");
await import("../update");

setSlot("delete");
await import("../delete");

const ORG = "org-acme";
const OTHER_ORG = "org-meridian";

const baseCtx = {
	user: { id: "user-1", email: "alice@example.com", name: "Alice" },
	session: {
		id: "sess-1",
		activeOrganizationId: ORG,
		impersonatedBy: null,
	},
	headers: new Headers(),
};

function contactRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "contact-1",
		organizationId: ORG,
		name: "Dana Reyes",
		email: null,
		company: null,
		redactedAt: null,
		createdById: "user-1",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-02T00:00:00.000Z"),
		...overrides,
	};
}

beforeEach(() => {
	mocks.listNonMemberContacts.mockReset();
	mocks.findNonMemberContactsByName.mockReset();
	mocks.createNonMemberContact.mockReset();
	mocks.updateNonMemberContact.mockReset();
	mocks.redactNonMemberContact.mockReset();
	mocks.recordAuditFromRequest.mockReset();
});

// ---------------------------------------------------------------------------
// The declared gate
// ---------------------------------------------------------------------------

describe("permission declarations", () => {
	it.each([
		["list", "ORG_MEMBERS_READ"],
		["create", "ORG_MEMBERS_INVITE"],
		["update", "ORG_MEMBERS_INVITE"],
		["delete", "ORG_MEMBERS_REMOVE"],
	])(
		"%s gates on %s against the organization named in the input",
		(slot, permission) => {
			expect(mocks.declared[slot]).toEqual([
				{ permission, options: { requireOrganization: true } },
			]);
		},
	);

	it("passes requireOrganization on every procedure", () => {
		// Not a restatement of the table above: THIS is the assertion that
		// fails if someone drops the options object while keeping the right
		// permission. Without it, an input of `organizationId: null` resolves
		// to nothing, the middleware passes through, and the role check never
		// runs at all. The register is org-only — there is no personal variant
		// for that pass-through to be correct for.
		for (const slot of ["list", "create", "update", "delete"]) {
			expect(mocks.declared[slot]?.[0]?.options).toEqual({
				requireOrganization: true,
			});
		}
	});
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("contacts.list", () => {
	beforeEach(() => {
		mocks.listNonMemberContacts.mockResolvedValue({
			contacts: [{ ...contactRow(), todoCount: 2 }],
			total: 1,
			hasMore: false,
			nextOffset: null,
		});
	});

	it("reads the organization named in the input, not the caller's session", async () => {
		await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: OTHER_ORG },
		});

		expect(mocks.listNonMemberContacts).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: OTHER_ORG }),
		);
	});

	it("maps rows onto an explicit wire shape with ISO dates", async () => {
		const result = await mocks.captured.list({
			context: baseCtx,
			input: {},
		});

		expect(result.contacts).toEqual([
			{
				id: "contact-1",
				organizationId: ORG,
				name: "Dana Reyes",
				email: null,
				company: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-02T00:00:00.000Z",
				todoCount: 2,
			},
		]);
		// `redactedAt` and `createdById` are internal columns. Returning the
		// Prisma row would leak whatever the model grows next into a surface
		// that already holds third parties' contact details.
		expect(result.contacts[0]).not.toHaveProperty("redactedAt");
		expect(result.contacts[0]).not.toHaveProperty("createdById");
	});

	it("offers no way to ask for redacted contacts", async () => {
		// The exclusion itself is the database layer's (pinned there). What is
		// pinned here is that the handler has no switch to defeat it: an
		// `includeRedacted` in the input must not reach the query.
		await mocks.captured.list({
			context: baseCtx,
			input: { includeRedacted: true },
		});

		const args = mocks.listNonMemberContacts.mock.calls[0][0];
		expect(args).not.toHaveProperty("includeRedacted");
		expect(Object.keys(args).sort()).toEqual([
			"limit",
			"offset",
			"organizationId",
			"search",
		]);
	});

	it("is a read: it records no audit row", async () => {
		await mocks.captured.list({ context: baseCtx, input: {} });
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("contacts.create", () => {
	it("creates a name-only contact and audits it", async () => {
		mocks.findNonMemberContactsByName.mockResolvedValue([]);
		mocks.createNonMemberContact.mockResolvedValue(contactRow());

		const result = await mocks.captured.create({
			context: baseCtx,
			input: { name: "Dana Reyes" },
		});

		expect(mocks.createNonMemberContact).toHaveBeenCalledExactlyOnceWith({
			organizationId: ORG,
			name: "Dana Reyes",
			email: undefined,
			company: undefined,
			createdById: "user-1",
		});
		expect(result.status).toBe("created");
		expect(result.contact).toMatchObject({
			id: "contact-1",
			name: "Dana Reyes",
		});
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledExactlyOnceWith(
			baseCtx,
			expect.objectContaining({
				action: "org.contact.created",
				category: "org",
				organizationId: ORG,
				resource: {
					type: "non_member_contact",
					id: "contact-1",
					name: null,
				},
				metadata: { confirmedDuplicate: false },
			}),
		);
	});

	it("refuses a duplicate name without confirmation, returning the match and writing nothing", async () => {
		const existing = contactRow({ id: "contact-0", company: "Meridian" });
		mocks.findNonMemberContactsByName.mockResolvedValue([existing]);

		const result = await mocks.captured.create({
			context: baseCtx,
			input: { name: "Dana Reyes" },
		});

		expect(result.status).toBe("duplicate");
		// `contact: null` on this branch: a client that reads `.contact`
		// without reading `.status` gets nothing, never the wrong row.
		expect(result.contact).toBeNull();
		expect(result.duplicates).toEqual([
			expect.objectContaining({ id: "contact-0", company: "Meridian" }),
		]);
		expect(mocks.createNonMemberContact).not.toHaveBeenCalled();
		// Nothing happened, so nothing is in the ledger claiming it did.
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("creates the same name once confirmed, and records that it was confirmed", async () => {
		mocks.findNonMemberContactsByName.mockResolvedValue([
			contactRow({ id: "contact-0" }),
		]);
		mocks.createNonMemberContact.mockResolvedValue(
			contactRow({ id: "contact-2" }),
		);

		const result = await mocks.captured.create({
			context: baseCtx,
			input: { name: "Dana Reyes", confirmDuplicate: true },
		});

		expect(result.status).toBe("created");
		expect(result.contact).toMatchObject({ id: "contact-2" });
		expect(mocks.createNonMemberContact).toHaveBeenCalledOnce();
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			baseCtx,
			expect.objectContaining({
				metadata: { confirmedDuplicate: true },
			}),
		);
	});

	it("looks for duplicates inside the resolved organization only", async () => {
		// A same name in ANOTHER tenant is not a duplicate, and asking about it
		// would be a cross-tenant read of who that tenant's contacts are.
		mocks.findNonMemberContactsByName.mockResolvedValue([]);
		mocks.createNonMemberContact.mockResolvedValue(
			contactRow({ organizationId: OTHER_ORG }),
		);

		await mocks.captured.create({
			context: baseCtx,
			input: { name: "Dana Reyes", organizationId: OTHER_ORG },
		});

		expect(mocks.findNonMemberContactsByName).toHaveBeenCalledWith({
			organizationId: OTHER_ORG,
			name: "Dana Reyes",
		});
		expect(mocks.createNonMemberContact).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: OTHER_ORG }),
		);
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			baseCtx,
			// Filed under the organization acted on, never the session's.
			expect.objectContaining({ organizationId: OTHER_ORG }),
		);
	});

	it("keeps the contact's own details out of the audit row", async () => {
		// The audit log is append-only. A name or email written here would
		// outlive the redaction that `contacts.delete` performs, and the
		// erasure would leave its own subject behind in the ledger.
		mocks.findNonMemberContactsByName.mockResolvedValue([]);
		mocks.createNonMemberContact.mockResolvedValue(
			contactRow({ email: "dana@example.com", company: "Meridian" }),
		);

		await mocks.captured.create({
			context: baseCtx,
			input: {
				name: "Dana Reyes",
				email: "dana@example.com",
				company: "Meridian",
			},
		});

		const payload = mocks.recordAuditFromRequest.mock.calls[0][1];
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toContain("Dana Reyes");
		expect(serialized).not.toContain("dana@example.com");
		expect(serialized).not.toContain("Meridian");
		expect(payload.resource.name).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("contacts.update", () => {
	it("renames within the resolved organization and audits which fields changed", async () => {
		mocks.updateNonMemberContact.mockResolvedValue(
			contactRow({ name: "Dana Reyes-Okonkwo" }),
		);

		const result = await mocks.captured.update({
			context: baseCtx,
			input: { contactId: "contact-1", name: "Dana Reyes-Okonkwo" },
		});

		expect(mocks.updateNonMemberContact).toHaveBeenCalledExactlyOnceWith({
			contactId: "contact-1",
			organizationId: ORG,
			name: "Dana Reyes-Okonkwo",
			email: undefined,
			company: undefined,
		});
		expect(result.contact).toMatchObject({ name: "Dana Reyes-Okonkwo" });
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledExactlyOnceWith(
			baseCtx,
			expect.objectContaining({
				action: "org.contact.updated",
				organizationId: ORG,
				// Field NAMES, not their values.
				metadata: { fieldsChanged: ["name"] },
			}),
		);
		const serialized = JSON.stringify(
			mocks.recordAuditFromRequest.mock.calls[0][1],
		);
		expect(serialized).not.toContain("Dana Reyes-Okonkwo");
	});

	it("refuses an id the resolved organization does not hold, and audits nothing", async () => {
		// The database layer returns null for a contact in another tenant AND
		// for a redacted one, so both land on the same answer — neither becomes
		// a probe for whether an id exists somewhere else.
		mocks.updateNonMemberContact.mockResolvedValue(null);

		await expect(
			mocks.captured.update({
				context: baseCtx,
				input: { contactId: "contact-1", name: "Whoever" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("rejects an edit that changes nothing, before touching the database", async () => {
		await expect(
			mocks.captured.update({
				context: baseCtx,
				input: { contactId: "contact-1" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.updateNonMemberContact).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("passes an explicit null through as a clear", async () => {
		mocks.updateNonMemberContact.mockResolvedValue(contactRow());

		await mocks.captured.update({
			context: baseCtx,
			input: { contactId: "contact-1", email: null },
		});

		expect(mocks.updateNonMemberContact).toHaveBeenCalledWith(
			expect.objectContaining({ email: null }),
		);
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			baseCtx,
			expect.objectContaining({ metadata: { fieldsChanged: ["email"] } }),
		);
	});
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("contacts.delete", () => {
	it("redacts, detaches the to-dos, and reports how many moved", async () => {
		mocks.redactNonMemberContact.mockResolvedValue({
			contact: contactRow({
				name: "Removed contact",
				redactedAt: new Date("2026-02-02T00:00:00.000Z"),
			}),
			detachedTodoCount: 3,
			clearedSuggestionCount: 1,
		});

		const result = await mocks.captured.delete({
			context: baseCtx,
			input: { contactId: "contact-1" },
		});

		expect(mocks.redactNonMemberContact).toHaveBeenCalledExactlyOnceWith({
			contactId: "contact-1",
			organizationId: ORG,
		});
		expect(result).toEqual({
			success: true,
			contactId: "contact-1",
			redactedAt: "2026-02-02T00:00:00.000Z",
			detachedTodoCount: 3,
			clearedSuggestionCount: 1,
		});
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledExactlyOnceWith(
			baseCtx,
			expect.objectContaining({
				action: "org.contact.redacted",
				category: "org",
				organizationId: ORG,
				resource: {
					type: "non_member_contact",
					id: "contact-1",
					name: null,
				},
				metadata: {
					detachedTodoCount: 3,
					clearedSuggestionCount: 1,
				},
			}),
		);
	});

	it("never refuses because to-dos are still open", async () => {
		// An erasure request from someone outside the system has to be
		// satisfiable at any time. The count is information, never a gate.
		mocks.redactNonMemberContact.mockResolvedValue({
			contact: contactRow({ redactedAt: new Date() }),
			detachedTodoCount: 17,
			clearedSuggestionCount: 0,
		});

		const result = await mocks.captured.delete({
			context: baseCtx,
			input: { contactId: "contact-1" },
		});

		expect(result.success).toBe(true);
		expect(result.detachedTodoCount).toBe(17);
	});

	it("refuses an already-redacted contact without a second erasure row", async () => {
		mocks.redactNonMemberContact.mockResolvedValue(null);

		await expect(
			mocks.captured.delete({
				context: baseCtx,
				input: { contactId: "contact-1" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("gives the same answer for an id in another organization", async () => {
		// The database layer scopes on (id, organizationId), so a foreign id
		// resolves to the same null an already-redacted one does. Asserting
		// they AGREE is the property: differing answers would make this
		// endpoint an existence oracle for other tenants' contact ids.
		mocks.redactNonMemberContact.mockResolvedValue(null);
		const caught = (error: unknown) =>
			error as { code?: string; message?: string };

		const foreign = await mocks.captured
			.delete({
				context: baseCtx,
				input: { contactId: "contact-1", organizationId: OTHER_ORG },
			})
			.catch(caught);
		const alreadyRedacted = await mocks.captured
			.delete({
				context: baseCtx,
				input: { contactId: "contact-1" },
			})
			.catch(caught);

		expect(foreign).toMatchObject({ code: "NOT_FOUND" });
		expect(alreadyRedacted).toMatchObject({ code: "NOT_FOUND" });
		expect(foreign.message).toBe(alreadyRedacted.message);
		expect(mocks.redactNonMemberContact).toHaveBeenNthCalledWith(1, {
			contactId: "contact-1",
			organizationId: OTHER_ORG,
		});
	});

	it("keeps the erased contact's details out of the redaction row", async () => {
		mocks.redactNonMemberContact.mockResolvedValue({
			// What comes back is already the tombstone, but a handler that
			// audited `input`-side or pre-redaction values would still leak.
			contact: contactRow({
				name: "Removed contact",
				redactedAt: new Date("2026-02-02T00:00:00.000Z"),
			}),
			detachedTodoCount: 0,
			clearedSuggestionCount: 0,
		});

		await mocks.captured.delete({
			context: baseCtx,
			input: { contactId: "contact-1" },
		});

		const payload = mocks.recordAuditFromRequest.mock.calls[0][1];
		expect(payload.resource.name).toBeNull();
		expect(Object.keys(payload.metadata).sort()).toEqual([
			"clearedSuggestionCount",
			"detachedTodoCount",
			// A count of the rows whose stored candidate list still carried the
			// erased name. Still a number, never the name itself -- the ledger is
			// append-only and cannot be redacted a second time.
			"strippedCandidateCount",
		]);
	});
});
