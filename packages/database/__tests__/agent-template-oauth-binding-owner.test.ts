/**
 * An agent template instance's `{ PROVIDER: "oauth" }` knowledge connection
 * binds to an OAuth connection row. In an organization each member's
 * connection is a personal OAuth grant, so a NEW binding must resolve to the
 * acting user's own connection — never to every teammate's connection for the
 * provider.
 *
 * The editor re-sends every selection as an `"oauth"` marker on each save, so
 * on update a provider that is already bound keeps its existing binding: an
 * authorized teammate's metadata-only edit must neither drop nor replace the
 * owner's connection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	connectionRow,
	type FakeWorkflowIntegrationRow,
} from "./_helpers/workflow-integration-fake";

interface StoredConfig {
	integrationId: string;
	integrationType: string;
	isEnabled: boolean;
	allowedResources: unknown;
}

const state = vi.hoisted(() => ({
	rows: [] as FakeWorkflowIntegrationRow[],
	/** Bindings already on the instance being edited. */
	existing: [] as StoredConfig[],
	created: [] as unknown[],
	updated: [] as unknown[],
}));

vi.mock("../prisma/client", async () => {
	const { createWorkflowIntegrationFake } = await import(
		"./_helpers/workflow-integration-fake"
	);
	const instance = () => ({
		id: "instance-1",
		sId: "instance-s1",
		userId: "user-1",
		organizationId: "org-example",
		version: 1,
		templateId: "template-1",
		template: {},
		integrationConfigurations: state.existing,
		memoryFiles: [],
	});
	const db: Record<string, unknown> = {
		get workflowIntegration() {
			return createWorkflowIntegrationFake(state.rows);
		},
		agentTemplate: { update: vi.fn() },
		agentTemplateInstance: {
			create: vi.fn(async (args: unknown) => {
				state.created.push(args);
				return instance();
			}),
			findUnique: vi.fn(async () => instance()),
			update: vi.fn(async () => instance()),
		},
		agentIntegrationConfiguration: {
			findMany: vi.fn(async () => state.existing),
			deleteMany: vi.fn(),
			createMany: vi.fn(async (args: unknown) => {
				state.updated.push(args);
			}),
		},
		agentDeployment: { updateMany: vi.fn() },
	};
	db.$transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(db));
	return { db };
});

import {
	createAgentTemplateInstance,
	getBoundOAuthProviderTypes,
	updateAgentTemplateInstance,
} from "../prisma/queries/agent-templates";

// Teammate rows are seeded FIRST, so a lookup that drops userId in the
// organization arm binds them.
const teammateNotion = connectionRow({
	id: "wi-notion-teammate",
	userId: "user-1",
	provider: "NOTION",
});
const callerNotion = connectionRow({
	id: "wi-notion-caller",
	userId: "user-2",
	provider: "NOTION",
});
const teammateDrive = connectionRow({
	id: "wi-drive-teammate",
	userId: "user-1",
	provider: "GOOGLE_DRIVE",
});
const callerDrive = connectionRow({
	id: "wi-drive-caller",
	userId: "user-2",
	provider: "GOOGLE_DRIVE",
});

/** The owner's (user-1) Notion connection, already bound on the instance. */
const ownerNotionBinding: StoredConfig = {
	integrationId: "wi-notion-teammate",
	integrationType: "NOTION",
	isEnabled: true,
	allowedResources: null,
};

function boundIntegrationIds(value: unknown): string[] {
	const ids: string[] = [];
	JSON.stringify(value, (key, nested) => {
		if (key === "integrationId" && typeof nested === "string") {
			ids.push(nested);
		}
		return nested;
	});
	return ids;
}

beforeEach(() => {
	state.rows = [];
	state.existing = [];
	state.created = [];
	state.updated = [];
});

describe("agent template instance OAuth-marker binding: connection owner", () => {
	it("create (org context): binds only the creator's own connection", async () => {
		state.rows = [teammateNotion, callerNotion];

		await createAgentTemplateInstance({
			templateId: "template-1",
			userId: "user-2",
			organizationId: "org-example",
			name: "Agent",
			knowledgeConnections: { NOTION: "oauth" },
		});

		expect(boundIntegrationIds(state.created)).toEqual([
			"wi-notion-caller",
		]);
	});

	it("create (org context): binds nothing when only a teammate is connected", async () => {
		state.rows = [teammateNotion];

		await createAgentTemplateInstance({
			templateId: "template-1",
			userId: "user-2",
			organizationId: "org-example",
			name: "Agent",
			knowledgeConnections: { NOTION: "oauth" },
		});

		expect(boundIntegrationIds(state.created)).toEqual([]);
	});
});

describe("agent template instance update: existing OAuth bindings", () => {
	// The editor (user-2) has their own Notion connection too, so a regression
	// that re-resolves the marker through the acting user would REPLACE the
	// owner's binding; with no connection it would DROP it. Both are covered.
	for (const editorConnected of [true, false]) {
		const label = editorConnected
			? "editor has their own connection"
			: "editor has no connection";

		it(`metadata-only edit by another editor keeps the owner's binding in place (${label})`, async () => {
			state.rows = editorConnected
				? [teammateNotion, callerNotion]
				: [teammateNotion];
			state.existing = [ownerNotionBinding];

			await updateAgentTemplateInstance({
				id: "instance-1",
				userId: "user-2",
				organizationId: "org-example",
				name: "Renamed",
				knowledgeConnections: { NOTION: "oauth" },
			});

			expect(boundIntegrationIds(state.updated)).toEqual([
				"wi-notion-teammate",
			]);
		});

		it(`metadata-only edit that creates a new version keeps the owner's binding (${label})`, async () => {
			state.rows = editorConnected
				? [teammateNotion, callerNotion]
				: [teammateNotion];
			state.existing = [ownerNotionBinding];

			await updateAgentTemplateInstance({
				id: "instance-1",
				userId: "user-2",
				organizationId: "org-example",
				name: "Renamed",
				knowledgeConnections: { NOTION: "oauth" },
				createNewVersion: true,
			});

			expect(boundIntegrationIds(state.created)).toEqual([
				"wi-notion-teammate",
			]);
		});
	}

	it("a newly added OAuth provider binds only the editor's own connection", async () => {
		state.rows = [teammateNotion, teammateDrive, callerDrive];
		state.existing = [ownerNotionBinding];

		await updateAgentTemplateInstance({
			id: "instance-1",
			userId: "user-2",
			organizationId: "org-example",
			knowledgeConnections: { NOTION: "oauth", GOOGLE_DRIVE: "oauth" },
		});

		expect(boundIntegrationIds(state.updated)).toEqual([
			"wi-notion-teammate",
			"wi-drive-caller",
		]);
	});

	it("a newly added OAuth provider binds nothing when only a teammate is connected", async () => {
		state.rows = [teammateNotion, teammateDrive];
		state.existing = [ownerNotionBinding];

		await updateAgentTemplateInstance({
			id: "instance-1",
			userId: "user-2",
			organizationId: "org-example",
			knowledgeConnections: { NOTION: "oauth", GOOGLE_DRIVE: "oauth" },
		});

		expect(boundIntegrationIds(state.updated)).toEqual([
			"wi-notion-teammate",
		]);
	});

	it("deselecting a provider drops its binding", async () => {
		state.existing = [ownerNotionBinding];

		await updateAgentTemplateInstance({
			id: "instance-1",
			userId: "user-2",
			organizationId: "org-example",
			knowledgeConnections: {},
		});

		expect(boundIntegrationIds(state.updated)).toEqual([]);
	});

	it("getBoundOAuthProviderTypes reports enabled OAuth bindings only", async () => {
		state.existing = [
			ownerNotionBinding,
			{
				...ownerNotionBinding,
				integrationType: "SLACK",
				isEnabled: false,
			},
			{
				integrationId: "wi-dbx",
				integrationType: "DATABRICKS_VECTOR_SEARCH",
				isEnabled: true,
				allowedResources: null,
			},
		];

		expect([...(await getBoundOAuthProviderTypes("instance-1"))]).toEqual([
			"NOTION",
		]);
	});
});

/**
 * Every binding written by an update, with its resource restriction. The
 * in-place path writes `agentIntegrationConfiguration.createMany`; the
 * new-version path nests the bindings in `agentTemplateInstance.create`.
 */
function writtenBindings(
	mode: "in-place" | "new-version",
): Array<{ integrationId: string; allowedResources: unknown }> {
	const bindings: Array<{
		integrationId: string;
		allowedResources: unknown;
	}> = [];
	JSON.stringify(
		mode === "in-place" ? state.updated : state.created,
		(_key, nested) => {
			if (
				nested &&
				typeof nested === "object" &&
				typeof (nested as { integrationId?: unknown }).integrationId ===
					"string"
			) {
				const binding = nested as {
					integrationId: string;
					allowedResources?: unknown;
				};
				bindings.push({
					integrationId: binding.integrationId,
					allowedResources: binding.allowedResources ?? null,
				});
			}
			return nested;
		},
	);
	return bindings;
}

describe.each([
	{ mode: "in-place" as const, createNewVersion: false },
	{ mode: "new-version" as const, createNewVersion: true },
])(
	"agent template instance update ($mode): disabled bindings and resource restrictions",
	({ mode, createNewVersion }) => {
		/** The owner's Notion binding, switched off on the instance. */
		const disabledOwnerNotion: StoredConfig = {
			...ownerNotionBinding,
			isEnabled: false,
		};
		const restriction = { pages: ["page-1", "page-2"] };

		function edit(extra: Record<string, unknown> = {}) {
			return updateAgentTemplateInstance({
				id: "instance-1",
				userId: "user-2",
				organizationId: "org-example",
				name: "Renamed",
				knowledgeConnections: { NOTION: "oauth" },
				createNewVersion,
				...extra,
			});
		}

		it("a disabled binding is not reused: the marker binds the editor's own connection", async () => {
			state.rows = [teammateNotion, callerNotion];
			state.existing = [disabledOwnerNotion];

			await edit();

			expect(writtenBindings(mode).map((b) => b.integrationId)).toEqual([
				"wi-notion-caller",
			]);
		});

		it("a disabled binding is not reused or re-enabled when only a teammate is connected", async () => {
			state.rows = [teammateNotion];
			state.existing = [disabledOwnerNotion];

			await edit();

			expect(writtenBindings(mode)).toEqual([]);
		});

		it("a metadata-only edit keeps a non-empty resource restriction exactly", async () => {
			state.rows = [teammateNotion, callerNotion];
			state.existing = [
				{ ...ownerNotionBinding, allowedResources: restriction },
			];

			await edit();

			expect(writtenBindings(mode)).toEqual([
				{
					integrationId: "wi-notion-teammate",
					allowedResources: restriction,
				},
			]);
		});

		it("an edit that supplies resources replaces the restriction", async () => {
			state.rows = [teammateNotion, callerNotion];
			state.existing = [
				{ ...ownerNotionBinding, allowedResources: restriction },
			];
			const replacement = {
				schema: "catalog.schema",
				indexes: ["idx-1"],
			};

			await edit({ knowledgeResources: { NOTION: replacement } });

			expect(writtenBindings(mode)).toEqual([
				{
					integrationId: "wi-notion-teammate",
					allowedResources: replacement,
				},
			]);
		});
	},
);
