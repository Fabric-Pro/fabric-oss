import { beforeEach, describe, expect, it, vi } from "vitest";

const { rows, member, decrypt } = vi.hoisted(() => ({
	rows: [] as Array<Record<string, unknown>>,
	member: vi.fn(),
	decrypt: vi.fn((value: string) => value),
}));
function matches(
	row: Record<string, unknown>,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (value === undefined) {
			return true;
		}
		if (key === "AND") {
			return (Array.isArray(value) ? value : [value]).every((clause) =>
				matches(row, clause),
			);
		}
		if (key === "OR") {
			return (value as Array<Record<string, unknown>>).some((clause) =>
				matches(row, clause),
			);
		}
		if (key === "NOT") {
			return !matches(row, value as Record<string, unknown>);
		}
		if (value && typeof value === "object" && "in" in value) {
			return (value.in as unknown[]).includes(row[key]);
		}
		return row[key] === value;
	});
}
vi.mock("../prisma/client", () => ({
	db: {
		member: { findFirst: member },
		workflowIntegration: {
			findFirst: vi.fn(
				async ({ where }) =>
					rows.find((row) => matches(row, where)) ?? null,
			),
			findMany: vi.fn(async ({ where }) =>
				rows.filter((row) => matches(row, where)),
			),
		},
	},
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: decrypt }));

import {
	fetchCredentialsByIdAndProviderInTenant,
	fetchCredentialsByProvider,
} from "../prisma/queries/workflows/credential-fetcher";
import {
	getWorkflowIntegrationByIdInTenant,
	listWorkflowIntegrationsInTenant,
} from "../prisma/queries/workflows/integrations";

function connection(
	userId: string,
	usageScope = "OWNER_ONLY",
	organizationId = "org-example",
) {
	const row = {
		id: `${userId}-${rows.length}`,
		userId,
		organizationId,
		usageScope,
		provider: "GMAIL",
		name: "Gmail",
		isActive: true,
		credentials: JSON.stringify({ access_token: `${userId}-grant` }),
	};
	rows.push(row);
	return row;
}
beforeEach(() => {
	rows.length = 0;
	member.mockReset().mockResolvedValue({ id: "member-example" });
	decrypt.mockClear();
});
describe("explicit connection usage scope", () => {
	it("does not borrow a teammate's private OAuth grant when the caller never connected", async () => {
		connection("teammate");
		expect(
			await fetchCredentialsByProvider("GMAIL", "actor", "org-example"),
		).toBeNull();
		expect(decrypt).not.toHaveBeenCalled();
	});
	it("selects the acting user's grant even when a teammate's row comes first", async () => {
		connection("teammate");
		connection("actor");
		expect(
			await fetchCredentialsByProvider("GMAIL", "actor", "org-example"),
		).toMatchObject({ GMAIL_ACCESS_TOKEN: "actor-grant" });
	});
	it("allows expressly shared connections in the same organization", async () => {
		const shared = connection("teammate", "ORGANIZATION_SHARED");
		expect(
			await fetchCredentialsByIdAndProviderInTenant(
				shared.id,
				"GMAIL",
				"actor",
				"org-example",
			),
		).toMatchObject({ GMAIL_ACCESS_TOKEN: "teammate-grant" });
	});
	it("denies a private teammate connection even when its exact ID is supplied", async () => {
		const privateRow = connection("teammate");
		expect(
			await fetchCredentialsByIdAndProviderInTenant(
				privateRow.id,
				"GMAIL",
				"actor",
				"org-example",
			),
		).toBeNull();
		expect(
			await getWorkflowIntegrationByIdInTenant(
				privateRow.id,
				"actor",
				"org-example",
			),
		).toBeNull();
	});
	it("limits discovery to own and explicitly shared connections", async () => {
		connection("private-teammate");
		const own = connection("actor");
		const shared = connection("shared-teammate", "ORGANIZATION_SHARED");
		connection("other-org", "ORGANIZATION_SHARED", "org-other");
		expect(
			(
				await listWorkflowIntegrationsInTenant({
					userId: "actor",
					organizationId: "org-example",
				})
			).map((row) => row.id),
		).toEqual([own.id, shared.id]);
	});
	it("fails closed after membership is revoked, including the owner's own connection", async () => {
		connection("actor");
		member.mockResolvedValue(null);
		expect(
			await fetchCredentialsByProvider("GMAIL", "actor", "org-example"),
		).toBeNull();
		expect(
			await listWorkflowIntegrationsInTenant({
				userId: "actor",
				organizationId: "org-example",
			}),
		).toEqual([]);
	});
	it("never reaches another organization or an unmarked legacy row", async () => {
		const foreign = connection(
			"teammate",
			"ORGANIZATION_SHARED",
			"org-other",
		);
		const legacy = connection("legacy");
		delete (legacy as Partial<typeof legacy>).usageScope;
		expect(
			await fetchCredentialsByIdAndProviderInTenant(
				foreign.id,
				"GMAIL",
				"actor",
				"org-example",
			),
		).toBeNull();
		expect(
			await fetchCredentialsByProvider("GMAIL", "actor", "org-example"),
		).toBeNull();
	});
	it("revoking sharing immediately prevents another member's next use", async () => {
		const shared = connection("teammate", "ORGANIZATION_SHARED");
		expect(
			await fetchCredentialsByIdAndProviderInTenant(
				shared.id,
				"GMAIL",
				"actor",
				"org-example",
			),
		).not.toBeNull();
		shared.usageScope = "OWNER_ONLY";
		expect(
			await fetchCredentialsByIdAndProviderInTenant(
				shared.id,
				"GMAIL",
				"actor",
				"org-example",
			),
		).toBeNull();
	});
});
