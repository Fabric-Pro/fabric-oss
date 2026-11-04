/**
 * Opt-in real constraints/RLS proof, using the existing restricted-role harness.
 * Requires generated clients, the reviewed migration, and apply:rls. Only an
 * explicitly selected loopback example_* disposable database is accepted.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, type Prisma } from "../prisma/client";
import { asRlsRole, ensureRlsTestRole } from "./_helpers/rls-role";

const enabled = process.env.RUN_DB_INTEGRATION === "1";
const suffix = randomUUID();
const owner = `example-owner-${suffix}`;
const guest = `example-guest-${suffix}`;
const organizations = [0, 1, 2].map((n) => `example-org-${n}-${suffix}`);
const projects = [0, 1, 2].map((n) => `example-project-${n}-${suffix}`);
const integrationIds = [0, 1].map((n) => `example-integration-${n}-${suffix}`);
const integrationId = integrationIds[0]!;
const bindingIds = [0, 1].map((n) => `example-binding-${n}-${suffix}`);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const fingerprints = [
	sha(`example-principal-0-${suffix}`),
	sha(`example-principal-1-${suffix}`),
];
const deniedFingerprint = sha(`example-denied-principal-${suffix}`);
const ownCtx = {
	type: "organization" as const,
	tenantId: organizations[0]!,
	userId: owner,
};
const otherCtx = {
	type: "organization" as const,
	tenantId: organizations[1]!,
	userId: owner,
};
const guestCtx = {
	type: "organization" as const,
	tenantId: organizations[2]!,
	userId: guest,
};
const runIds: string[] = [];

function bindingData(
	overrides: Partial<Prisma.ProjectContextQualityBindingUncheckedCreateInput> = {},
): Prisma.ProjectContextQualityBindingUncheckedCreateInput {
	return {
		id: bindingIds[0]!,
		organizationId: organizations[0]!,
		projectId: projects[0]!,
		integrationId,
		workspaceOrigin: "https://example.com",
		jobId: "12",
		experimentId: "34",
		volumeRoot: "/Volumes/example_catalog/example_schema/example_volume",
		notebookPath: "/Shared/example-notebook",
		notebookSha256: sha("example-notebook"),
		principalFingerprint: fingerprints[0]!,
		configHash: sha("example-config"),
		createdBy: owner,
		updatedBy: owner,
		...overrides,
	};
}
function runData(
	overrides: Partial<Prisma.ProjectContextQualityRunUncheckedCreateInput> = {},
): Prisma.ProjectContextQualityRunUncheckedCreateInput {
	const id = `example-run-${randomUUID()}`;
	runIds.push(id);
	return {
		id,
		organizationId: organizations[0]!,
		projectId: projects[0]!,
		bindingId: bindingIds[0]!,
		requestedBy: owner,
		name: "Example run",
		idempotencyKey: id,
		requestHash: sha(id),
		sourceRefsJson: [],
		snapshotPayload: '{ "example": "private 🌱" }\n',
		payloadHash: sha('{ "example": "private 🌱" }\n'),
		snapshotHash: sha("example-snapshot"),
		scorerVersion: "fabric-deterministic-context-v1",
		localResultJson: {},
		bindingConfigJson: {},
		bindingConfigHash: sha("example-config"),
		workflowId: id,
		dispatchToken: id,
		deadlineAt: new Date(Date.now() + 60_000),
		snapshotExpiresAt: new Date(Date.now() + 120_000),
		...overrides,
	};
}

describe.skipIf(!enabled)(
	"saved context quality real constraints and RLS",
	() => {
		let targetValidated = false;
		beforeAll(async () => {
			const url = new URL(process.env.DATABASE_URL ?? "");
			if (
				!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
				!/^\/example_[a-z0-9_]+$/.test(url.pathname) ||
				url.search
			) {
				throw new Error(
					"Use a loopback example_* disposable database without URL parameters",
				);
			}
			targetValidated = true;
			await ensureRlsTestRole();
			const policies = await db.$queryRaw<
				{
					relname: string;
					enabled: boolean;
					forced: boolean;
					policy: boolean;
				}[]
			>`
			SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
				EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relname IN
				('project_context_quality_binding', 'project_context_quality_run', 'project_context_quality_principal')
			ORDER BY c.relname`;
			expect(policies).toHaveLength(3);
			for (const policy of policies)
				expect(policy).toMatchObject({
					enabled: true,
					forced: true,
					policy: true,
				});
			for (const id of organizations)
				await db.organization.create({
					data: {
						id,
						name: "Example organization",
						slug: id,
						createdAt: new Date(),
					},
				});
			for (const id of [owner, guest])
				await db.user.create({
					data: {
						id,
						name: "Example user",
						email: `${id}@example.com`,
						emailVerified: true,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				});
			for (const [index, id] of projects.entries())
				await db.project.create({
					data: {
						id,
						name: "Example project",
						userId: owner,
						organizationId: organizations[index === 2 ? 0 : index]!,
						techStack: [],
						features: [],
						tags: [],
					},
				});
			await db.projectMember.create({
				data: {
					projectId: projects[0]!,
					userId: guest,
					invitedBy: owner,
					acceptedAt: new Date(),
					role: "EDITOR",
				},
			});
			for (const [index, id] of integrationIds.entries()) {
				await db.member.create({
					data: {
						organizationId: organizations[index]!,
						userId: owner,
						role: "member",
						createdAt: new Date(),
					},
				});
				await db.workflowIntegration.create({
					data: {
						id,
						userId: owner,
						organizationId: organizations[index]!,
						provider: "DATABRICKS_PLATFORM",
						name: "Example integration",
						credentials: "{}",
						usageScope: "ORGANIZATION_SHARED",
					},
				});
			}
			for (const [index, fingerprint] of fingerprints.entries()) {
				await db.projectContextQualityPrincipal.create({
					data: {
						fingerprint,
						organizationId: organizations[index]!,
					},
				});
			}
			await db.projectContextQualityBinding.create({
				data: bindingData(),
			});
			await db.projectContextQualityBinding.create({
				data: bindingData({
					id: bindingIds[1]!,
					projectId: projects[1]!,
					organizationId: organizations[1]!,
					integrationId: integrationIds[1]!,
					principalFingerprint: fingerprints[1]!,
					jobId: "13",
					experimentId: "35",
					volumeRoot:
						"/Volumes/example_catalog/example_schema/example_other_volume",
				}),
			});
			await db.projectContextQualityRun.create({ data: runData() });
		});
		afterAll(async () => {
			if (!targetValidated) return;
			try {
				await db.projectContextQualityRun.deleteMany({
					where: { projectId: { in: projects } },
				});
				await db.projectContextQualityBinding.deleteMany({
					where: { projectId: { in: projects } },
				});
				await db.projectContextQualityPrincipal.deleteMany({
					where: {
						fingerprint: {
							in: [...fingerprints, deniedFingerprint],
						},
					},
				});
				await db.workflowIntegration.deleteMany({
					where: { id: { in: integrationIds } },
				});
				await db.project.deleteMany({
					where: { id: { in: projects } },
				});
				await db.organization.deleteMany({
					where: { id: { in: organizations } },
				});
				await db.user.deleteMany({
					where: { id: { in: [owner, guest] } },
				});
			} finally {
				await db.$disconnect();
			}
		});

		it("enforces cross-organization reads and writes on both project tables", async () => {
			expect(
				await asRlsRole(ownCtx, (tx) =>
					tx.projectContextQualityBinding.findMany({
						where: { id: bindingIds[0] },
					}),
				),
			).toHaveLength(1);
			expect(
				await asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityBinding.findMany({
						where: { id: bindingIds[0] },
					}),
				),
			).toEqual([]);
			expect(
				await asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityRun.findMany({
						where: { id: runIds[0] },
					}),
				),
			).toEqual([]);
			expect(
				await asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityRun.updateMany({
						where: { id: runIds[0] },
						data: { name: "Example refused" },
					}),
				),
			).toEqual({ count: 0 });
			expect(
				await asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityBinding.updateMany({
						where: { id: bindingIds[0] },
						data: { isEnabled: true },
					}),
				),
			).toEqual({ count: 0 });
			await expect(
				asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityRun.create({ data: runData() }),
				),
			).rejects.toThrow(/row-level security/i);
			await expect(
				asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityBinding.create({
						data: bindingData({
							id: `example-refused-${suffix}`,
							projectId: projects[2]!,
							jobId: "90",
							experimentId: "91",
							volumeRoot:
								"/Volumes/example_catalog/example_schema/example_refused",
						}),
					}),
				),
			).rejects.toThrow(/row-level security/i);
		});
		it("lets an invited project guest read and write matching rows, but not spoof their denormalized organization", async () => {
			expect(
				await asRlsRole(guestCtx, (tx) =>
					tx.projectContextQualityBinding.findMany({
						where: { id: bindingIds[0] },
					}),
				),
			).toHaveLength(1);
			const created = await asRlsRole(guestCtx, (tx) =>
				tx.projectContextQualityRun.create({
					data: runData({ requestedBy: guest }),
				}),
			);
			expect(created.projectId).toBe(projects[0]);
			expect(
				await asRlsRole(guestCtx, (tx) =>
					tx.projectContextQualityPrincipal.findMany({
						where: { fingerprint: fingerprints[0] },
					}),
				),
			).toEqual([]);
			await expect(
				asRlsRole(guestCtx, (tx) =>
					tx.projectContextQualityRun.create({
						data: runData({ organizationId: organizations[1]! }),
					}),
				),
			).rejects.toThrow(/row-level security/i);
			await expect(
				asRlsRole(guestCtx, (tx) =>
					tx.projectContextQualityBinding.update({
						where: { id: bindingIds[0]! },
						data: { organizationId: organizations[1]! },
					}),
				),
			).rejects.toThrow(/row-level security/i);
		});
		it("keeps the global principal exclusion even when the conflicting row is invisible under RLS", async () => {
			expect(
				await asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityPrincipal.createMany({
						data: [
							{
								fingerprint: fingerprints[0]!,
								organizationId: organizations[1]!,
							},
						],
						skipDuplicates: true,
					}),
				),
			).toEqual({ count: 0 });
			expect(
				await asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityPrincipal.findFirst({
						where: {
							fingerprint: fingerprints[0]!,
							organizationId: organizations[1]!,
						},
					}),
				),
			).toBeNull();
			expect(
				(
					await db.projectContextQualityPrincipal.findUniqueOrThrow({
						where: { fingerprint: fingerprints[0]! },
					})
				).organizationId,
			).toBe(organizations[0]);
		});
		it("does not read, claim or transfer another organization's principal under RLS", async () => {
			expect(
				await asRlsRole(ownCtx, (tx) =>
					tx.projectContextQualityPrincipal.findFirst({
						where: { fingerprint: fingerprints[0]! },
					}),
				),
			).not.toBeNull();
			expect(
				await asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityPrincipal.findFirst({
						where: { fingerprint: fingerprints[0]! },
					}),
				),
			).toBeNull();
			await expect(
				asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityPrincipal.createMany({
						data: [
							{
								fingerprint: deniedFingerprint,
								organizationId: organizations[0]!,
							},
						],
						skipDuplicates: true,
					}),
				),
			).rejects.toThrow(/row-level security/i);
			expect(
				await asRlsRole(otherCtx, (tx) =>
					tx.projectContextQualityPrincipal.updateMany({
						where: { fingerprint: fingerprints[0]! },
						data: { organizationId: organizations[1]! },
					}),
				),
			).toEqual({ count: 0 });
		});
		it("the composite binding foreign key rejects a different project or organization even with RLS bypassed", async () => {
			await expect(
				db.projectContextQualityRun.create({
					data: runData({ projectId: projects[2]! }),
				}),
			).rejects.toMatchObject({ code: "P2003" });
			await expect(
				db.projectContextQualityRun.create({
					data: runData({ organizationId: organizations[1]! }),
				}),
			).rejects.toMatchObject({ code: "P2003" });
			await expect(
				db.projectContextQualityBinding.create({
					data: bindingData({
						id: `example-wrong-principal-${suffix}`,
						projectId: projects[2]!,
						principalFingerprint: fingerprints[1]!,
						jobId: "90",
						experimentId: "91",
						volumeRoot:
							"/Volumes/example_catalog/example_schema/example_invalid_principal",
					}),
				}),
			).rejects.toMatchObject({ code: "P2003" });
		});
		it.each(["jobId", "experimentId", "volumeRoot"] as const)(
			"does not share the workspace's %s across projects",
			async (field) => {
				const original = bindingData();
				const candidate = bindingData({
					id: `example-resource-${field}-${suffix}`,
					projectId: projects[2]!,
					jobId: "90",
					experimentId: "91",
					volumeRoot:
						"/Volumes/example_catalog/example_schema/example_candidate",
					[field]: original[field],
				});
				await expect(
					db.projectContextQualityBinding.create({ data: candidate }),
				).rejects.toMatchObject({ code: "P2002" });
			},
		);
		it("enforces actor-scoped request idempotency and preserves snapshot TEXT bytes", async () => {
			const original =
				await db.projectContextQualityRun.findUniqueOrThrow({
					where: { id: runIds[0]! },
				});
			expect(original.snapshotPayload).toBe(
				'{ "example": "private 🌱" }\n',
			);
			expect(original.payloadHash).toBe(sha(original.snapshotPayload!));
			await expect(
				db.projectContextQualityRun.create({
					data: runData({ idempotencyKey: original.idempotencyKey }),
				}),
			).rejects.toMatchObject({ code: "P2002" });
			expect(
				await db.projectContextQualityRun.create({
					data: runData({
						idempotencyKey: original.idempotencyKey,
						requestedBy: guest,
					}),
				}),
			).toMatchObject({ requestedBy: guest });
		});
		it("restricts project, binding, organization and integration deletion while receipts remain", async () => {
			await expect(
				db.project.delete({ where: { id: projects[0]! } }),
			).rejects.toMatchObject({ code: "P2003" });
			await expect(
				db.projectContextQualityBinding.delete({
					where: { id: bindingIds[0]! },
				}),
			).rejects.toMatchObject({ code: "P2003" });
			await expect(
				db.organization.delete({ where: { id: organizations[0]! } }),
			).rejects.toMatchObject({ code: "P2003" });
			await expect(
				db.workflowIntegration.delete({ where: { id: integrationId } }),
			).rejects.toMatchObject({ code: "P2003" });
		});
	},
);
