/**
 * Test Case PM Sync Activities
 *
 * The entity-agnostic PM sync for test cases — the test-case counterpart of the
 * story sync activities in `story-sync.ts`. The `testCaseSyncWorkflow`
 * orchestrates these; the cross-provider step serialization lives in the pure
 * `test-case-serializer.ts` so the workflow (which cannot import
 * `@repo/database`) and these activities share one implementation.
 *
 *  - `getTestCasesToSync`            — thin wrapper over the query layer.
 *  - `createOrUpdateTestCaseFromPMItem` — the pull/import upsert.
 *  - `updateTestCaseExternalRefs`    — persist external link + SUCCESS state.
 */

import {
	createTestCase,
	db,
	getTestCasesToSync as dbGetTestCasesToSync,
	PmSyncStatus,
	type TestCaseForSync,
	type TestCaseStepInput,
	updateTestCase,
	updateTestCasePmRefs,
} from "@repo/database";
import { fetchPmTicket } from "./fetch-pm-ticket";
import { computePmHash } from "./pm-sync-hash";
import { recordPmSyncLog } from "./record-pm-sync-log";
import { parseTestCaseStepsFromBody } from "./test-case-serializer";
import type { PMToolCapabilities } from "./tool-analyzer";

// Re-export the serializer so callers can reach the whole test-case sync
// surface from this module (the serializer is split out only to keep it pure
// for the workflow bundle).
export {
	buildTestCaseDescription,
	formatTestCaseStepsForProvider,
	parseTestCaseStepsFromBody,
} from "./test-case-serializer";

// =============================================================================
// getTestCasesToSync — push/pull candidate selection (wraps the query layer)
// =============================================================================

export interface GetTestCasesToSyncInput {
	projectId: string;
	organizationId?: string;
	testCaseIds?: string[];
	unsyncedOnly?: boolean;
	direction?: "push" | "pull";
}

/**
 * Select the test cases to sync. Delegates to the `@repo/database` query (tenant
 * scope is the project, which the workflow already resolved); the activity
 * boundary exists so the workflow can `proxyActivities` it like `getStoriesToSync`.
 */
export async function getTestCasesToSync(
	input: GetTestCasesToSyncInput,
): Promise<TestCaseForSync[]> {
	return dbGetTestCasesToSync({
		projectId: input.projectId,
		testCaseIds: input.testCaseIds,
		unsyncedOnly: input.unsyncedOnly,
		direction: input.direction,
	});
}

// =============================================================================
// updateTestCaseExternalRefs — persist the external link + SUCCESS state
// =============================================================================

export interface UpdateTestCaseExternalRefsInput {
	testCaseId: string;
	projectId: string;
	externalId: string;
	externalUrl?: string | null;
	externalMcpServerId?: string | null;
	/**
	 * Post-push drift baseline. When supplied (an MCP push with a `get`-capable
	 * tool), the activity reads the PM item BACK and stamps `lastSyncedPmHash`
	 * from the tool's STORED content — the same `fetchPmTicket` + `computePmHash`
	 * the push-time conflict guard uses — so the NEXT push can detect PM-side
	 * edits. Omitted, or when the readback fails, the existing baseline is left
	 * untouched (never hash the pushed body: ADO re-renders markdown to HTML,
	 * which would false-flag every edit as drift).
	 */
	baseline?: {
		mcpConfigId: string;
		capabilities: PMToolCapabilities;
		userId: string;
		organizationId?: string;
		/** The board/container the push targeted — required by `fetchPmTicket`. */
		containerId: string;
		containerName?: string;
		additionalContext?: Record<string, string>;
	};
}

/**
 * Persist the external link on a case after a SUCCESSFUL push (the counterpart
 * of `updateStoryExternalRefs`). Also stamps a SUCCESS sync state — clearing any
 * stale FAILED/CONFLICT badge left by an earlier attempt.
 *
 * When `baseline` is supplied it ALSO stamps `lastSyncedPmHash` from a post-push
 * readback of the PM tool's stored content (the same `fetchPmTicket` path the
 * conflict guard reads). This closes the former "push-side drift detection is a
 * v1 limitation" gap: without a baseline, `getPmSyncBaseline` returned null, so
 * the conflict guard always reported no drift and a PM-side edit was silently
 * OVERWRITTEN on the next push. The readback — not the pushed body — is hashed on
 * purpose: ADO re-renders markdown to HTML, so a pushed-body baseline would
 * false-flag every edit. A failed readback leaves the prior baseline untouched
 * rather than stamping a wrong one.
 */
export async function updateTestCaseExternalRefs(
	input: UpdateTestCaseExternalRefsInput,
): Promise<void> {
	const now = new Date();

	// Post-push drift baseline: read the PM item back and hash its STORED content
	// exactly as the conflict guard does, so the next push detects real PM edits.
	// Only stamp on a successful readback — never overwrite a good baseline (or
	// hash the pushed body) on failure.
	let pmHash: string | null = null;
	if (input.baseline?.capabilities?.taskGet) {
		try {
			const snapshot = await fetchPmTicket({
				mcpConfigId: input.baseline.mcpConfigId,
				userId: input.baseline.userId,
				organizationId: input.baseline.organizationId,
				capabilities: input.baseline.capabilities,
				externalId: input.externalId,
				containerId: input.baseline.containerId,
				containerName: input.baseline.containerName,
				additionalContext: input.baseline.additionalContext,
			});
			if (snapshot) {
				pmHash = computePmHash(snapshot.title, snapshot.description);
			}
		} catch {
			// Readback failed — keep the prior baseline (leave lastSyncedPmHash).
		}
	}

	await db.testCase.updateMany({
		where: { id: input.testCaseId, projectId: input.projectId },
		data: {
			externalId: input.externalId,
			...(input.externalUrl !== undefined
				? { externalUrl: input.externalUrl }
				: {}),
			...(input.externalMcpServerId !== undefined
				? { externalMcpServerId: input.externalMcpServerId }
				: {}),
			...(pmHash !== null ? { lastSyncedPmHash: pmHash } : {}),
			lastSyncedAt: now,
			lastPmSyncStatus: PmSyncStatus.SUCCESS,
			lastPmSyncError: null,
			lastPmSyncAttemptAt: now,
		},
	});
}

// =============================================================================
// createOrUpdateTestCaseFromPMItem — the pull/import upsert
// =============================================================================

export interface CreateOrUpdateTestCaseFromPMItemInput {
	projectId: string;
	externalId: string;
	title: string;
	description?: string | null;
	externalUrl?: string | null;
	externalMcpServerId?: string | null;
	userId: string;
	organizationId?: string;
	/** Detected PM tool slug (`capabilities.detectedType`), drives step parse-back. */
	toolKey?: string | null;
}

export interface CreateOrUpdateTestCaseFromPMItemResult {
	testCaseId: string;
	identifier: string;
	created: boolean;
	externalId: string;
	externalUrl?: string;
}

/**
 * Create or update a Fabric test case from a PM item (the pull direction).
 * Mirrors `createOrUpdateStoryFromPMItem` against `db.testCase`:
 * `findFirst({ projectId, externalId })` → update, else create as DRAFT. Steps
 * are parsed back from the body (ADO native XML or the numbered block), the
 * drift baseline (`lastSyncedPmHash`) is stamped, and a `pull` `PmSyncLog` row
 * (`entityType: "TEST_CASE"`) is recorded.
 */
export async function createOrUpdateTestCaseFromPMItem(
	input: CreateOrUpdateTestCaseFromPMItemInput,
): Promise<CreateOrUpdateTestCaseFromPMItemResult> {
	const {
		projectId,
		externalId,
		title,
		description,
		externalUrl,
		externalMcpServerId,
		userId,
		organizationId,
		toolKey,
	} = input;

	const parsed = parseTestCaseStepsFromBody(description, toolKey);
	const steps: TestCaseStepInput[] = parsed.steps.map((s) => ({
		action: s.action,
		expected: s.expected,
	}));
	const lastSyncedPmHash = computePmHash(title, description);

	const logPull = (entityId: string): Promise<void> =>
		recordPmSyncLog({
			direction: "pull",
			entityType: "TEST_CASE",
			entityId,
			title,
			pmTool: toolKey ?? "unknown",
			status: "SUCCESS",
			actorUserId: userId,
			externalId,
			externalUrl: externalUrl ?? null,
			...(organizationId
				? { organizationId, userId: null }
				: { organizationId: null, userId }),
			projectId,
		});

	const existing = await db.testCase.findFirst({
		// Ignore soft-deleted cases: a pull to a dead row must not stamp refs or
		// log SUCCESS on a hidden case (updateTestCase already no-ops on
		// `deletedAt`, but updateTestCasePmRefs/logPull would still touch it).
		where: { projectId, externalId, deletedAt: null },
		select: { id: true, identifier: true },
	});

	if (existing) {
		await updateTestCase({
			id: existing.id,
			projectId,
			data: {
				title,
				description: description ?? null,
				// Only replace steps when we recovered some — never wipe an
				// authored step list because an external body had no parseable steps.
				...(steps.length > 0 ? { steps } : {}),
			},
		});
		await updateTestCasePmRefs({
			id: existing.id,
			projectId,
			externalId,
			externalUrl: externalUrl ?? undefined,
			externalMcpServerId: externalMcpServerId ?? undefined,
			lastSyncedPmHash,
		});
		await logPull(existing.id);
		return {
			testCaseId: existing.id,
			identifier: existing.identifier,
			created: false,
			externalId,
			externalUrl: externalUrl ?? undefined,
		};
	}

	// Create the case WITH its PM refs in a single insert (createTestCase runs in
	// a transaction). A create-then-updateRefs pair could orphan an
	// `externalId`-null draft if the process died between the two writes.
	const created = await createTestCase({
		projectId,
		createdById: userId,
		title,
		description: description ?? null,
		state: "DRAFT",
		steps,
		// Tenant XOR: org context → organizationId set + userId null; personal →
		// userId set + organizationId null.
		userId: organizationId ? null : userId,
		organizationId: organizationId ?? null,
		externalId,
		externalUrl: externalUrl ?? undefined,
		externalMcpServerId: externalMcpServerId ?? undefined,
		lastSyncedPmHash,
		lastSyncedAt: new Date(),
	});
	await logPull(created.id);
	return {
		testCaseId: created.id,
		identifier: created.identifier,
		created: true,
		externalId,
		externalUrl: externalUrl ?? undefined,
	};
}
