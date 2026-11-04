/** Server-created identity, never fields copied from an untrusted invocation body. */
export interface HarnessIdentity {
	organizationId: string;
	actorId: string;
	projectId: string | null;
}
export interface HarnessFiniteRelease {
	kind: "harness_finite";
	artifact: {
		digest: string;
		repository: { url: string; revision: string };
		packages: {
			sdk: {
				name: "@fabric-harness/sdk";
				version: string;
				entrypoint: "strict";
			};
			node: { name: "@fabric-harness/node"; version: string };
			client?: { name: "@fabric-harness/client"; version: string };
		};
		buildManifestVersion: 2;
	};
	entrypoint: { module: string; export: string; identity: string };
	protocol: { generation: string; interface: "finite_job" };
	schemas: {
		input: { path: string; digest: string };
		output: { path: string; digest: string };
	};
}
export type HarnessOperation = "start" | "status" | "events" | "cancel";
export interface HarnessAdmissionKey {
	organizationId: string;
	operationId: string;
}
export interface HarnessFiniteReceipt {
	runId: string;
	status: HarnessRunStatus;
}
export type HarnessRunStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "aborted";
export interface HarnessAdmissionIntent extends HarnessAdmissionKey {
	identity: HarnessIdentity;
	targetBindingId: string;
	release: HarnessFiniteRelease;
	releaseFingerprint: string;
	payloadHash: string;
	idempotencyKey: string;
}
export interface HarnessAdmission {
	intent: HarnessAdmissionIntent;
	state: "starting" | "accepted" | "uncertain" | "not_started";
	receipt?: HarnessFiniteReceipt;
}
/** Atomic durable claim and immutable-intent conflict enforcement are mandatory. */
export interface HarnessAdmissionStore {
	claim(
		intent: HarnessAdmissionIntent,
	): Promise<{ created: boolean; admission: HarnessAdmission }>;
	read(key: HarnessAdmissionKey): Promise<HarnessAdmission | null>;
	recordAccepted(
		key: HarnessAdmissionKey,
		receipt: HarnessFiniteReceipt,
	): Promise<void>;
	markUncertain(key: HarnessAdmissionKey): Promise<void>;
	/** Record a locally failed/aborted attempt that never dispatched an HTTP mutation. */
	markNotStarted(key: HarnessAdmissionKey): Promise<void>;
}
/**
 * Returned ONLY by a trusted server-side registry of operator-qualified targets.
 * The attestation reference must evidence independently verified deployed artifact,
 * exact selected entrypoint/schemas, identity enforcement and read-only recovery.
 * Comparing a caller's digest to itself is never qualification.
 */
export interface QualifiedHarnessTarget {
	bindingId: string;
	baseUrl: string;
	organizationId: string;
	actorIds: readonly string[];
	projectIds: readonly (string | null)[];
	qualification: {
		authority: "operator";
		attestationReference: string;
		releaseFingerprint: string;
		expiresAt: number;
		clientVersion: "6.3.0";
		identityPolicy: "fabric-broker-organization-actor-project-v1";
		effectPolicy: "read_only" | "effectful";
		readOnlyRecovery: boolean;
		finiteJobs: boolean;
		status: boolean;
		events: boolean;
		cancel: boolean;
	};
}
export interface HarnessAdapterOptions {
	resolveQualifiedTarget(input: {
		bindingId: string;
		identity: HarnessIdentity;
		releaseFingerprint: string;
		signal: AbortSignal;
	}): Promise<QualifiedHarnessTarget | null>;
	/** Recheck current membership/project permission and operation grant on EVERY call. */
	authorizeOperation(input: {
		identity: HarnessIdentity;
		target: QualifiedHarnessTarget;
		operation: HarnessOperation;
		signal: AbortSignal;
	}): Promise<boolean>;
	/** Scoped, rotating broker credentials; target must verify the signed identity assertion. */
	brokerCredentials(input: {
		identity: HarnessIdentity;
		targetBindingId: string;
		operation: HarnessOperation;
		runId?: string;
		signal: AbortSignal;
	}): Promise<{ authorization: string; identityAssertion: string }>;
	/** Validate against independently verified schemas identified by the release pins. */
	validateInput(input: {
		release: HarnessFiniteRelease;
		payload: unknown;
		signal: AbortSignal;
	}): Promise<boolean>;
	validateOutput(input: {
		release: HarnessFiniteRelease;
		output: unknown;
		signal: AbortSignal;
	}): Promise<boolean>;
	admissions: HarnessAdmissionStore;
	limits?: {
		timeoutMs?: number;
		maxPayloadBytes?: number;
		maxResponseBytes?: number;
		maxEvents?: number;
	};
	/** HTTP is restricted to numeric loopback addresses for local packed-client tests. */
	allowLoopbackHttpForTests?: boolean;
}
export interface HarnessStartInput {
	identity: HarnessIdentity;
	operationId: string;
	targetBindingId: string;
	release: HarnessFiniteRelease;
	payload: unknown;
	signal?: AbortSignal;
}
export interface HarnessRunInput {
	identity: HarnessIdentity;
	operationId: string;
	signal?: AbortSignal;
}
export interface HarnessRunProjection extends HarnessFiniteReceipt {
	job: string;
	output?: unknown;
	error?: { type: "job_failed"; message: string };
}
