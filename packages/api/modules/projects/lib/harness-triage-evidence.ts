/** Server-only adapter: shares the canonical Portal/API/CLI/MCP evidence command. */

import { timingSafeEqual } from "node:crypto";
import type {
	SignalEvidencePin,
	SignalTriagerHost,
} from "@repo/agent-runtime/harness/triage";
import {
	getOwnedDeliverySourceObservation,
	getOwnedDeliverySourceWatch,
} from "@repo/database";
import {
	type DeliverySignalActor,
	requireDeliverySignalScopes,
} from "./delivery-signals";
import {
	getDeliverySourceEvidence,
	requirePrivateDeliverySourceEvidenceAccess,
} from "./delivery-source-commands";

export class TriageEvidenceUnavailableError extends Error {
	constructor() {
		super("Selected private triage evidence is unavailable.");
		this.name = "TriageEvidenceUnavailableError";
	}
}
const unavailable = (): never => {
	throw new TriageEvidenceUnavailableError();
};
export type TriageEvidenceCredential =
	| { kind: "SESSION" }
	| { kind: "API_KEY"; scopes: readonly string[] };
function digestMatches(a: string, b: string) {
	return (
		/^[a-f0-9]{64}$/.test(a) &&
		/^[a-f0-9]{64}$/.test(b) &&
		timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
	);
}
/** Actor/project/credential are captured from an authenticated, server-resolved invocation, never the job payload. */
export async function createPrivateTriageEvidenceReader(
	actor: DeliverySignalActor,
	projectId: string,
	credential: TriageEvidenceCredential,
): Promise<SignalTriagerHost["readEvidence"]> {
	// No absent/unknown discriminator may silently turn a key into a session.
	if (!credential || !["SESSION", "API_KEY"].includes(credential.kind)) {
		return unavailable();
	}
	if (
		credential.kind === "API_KEY" &&
		(!Array.isArray(credential.scopes) ||
			!credential.scopes.every((scope) => typeof scope === "string"))
	) {
		return unavailable();
	}
	const boundCredential = structuredClone(credential);
	const checkScopes = () => {
		if (boundCredential.kind === "API_KEY") {
			requireDeliverySignalScopes(boundCredential.scopes, true);
		}
	};
	checkScopes();
	const scope = await requirePrivateDeliverySourceEvidenceAccess(
		actor,
		projectId,
	);
	const boundActor: DeliverySignalActor = {
		userId: scope.userId,
		organizationBinding: { organizationId: scope.organizationId },
		boundProjectId: scope.projectId,
	};
	async function pinned(pin: SignalEvidencePin, signal: AbortSignal) {
		signal.throwIfAborted();
		checkScopes();
		await requirePrivateDeliverySourceEvidenceAccess(
			boundActor,
			scope.projectId,
		);
		const [observation, watch] = await Promise.all([
			getOwnedDeliverySourceObservation(scope, {
				watchId: pin.watchId,
				observationId: pin.observationId,
			}),
			getOwnedDeliverySourceWatch(scope, pin.watchId),
		]);
		signal.throwIfAborted();
		if (
			!observation ||
			!watch ||
			observation.hasConflict ||
			observation.grantId !== pin.grantId ||
			watch.grantRevision !== pin.grantRevision ||
			!digestMatches(observation.evidenceDigest, pin.evidenceDigest) ||
			observation.expiresAt.getTime() <= Date.now()
		) {
			return unavailable();
		}
		return { expiresAt: observation.expiresAt.toISOString() };
	}
	return async (authority, selectedPin, signal) => {
		const pin = { ...selectedPin };
		if (
			authority.organizationId !== scope.organizationId ||
			authority.actorId !== scope.userId ||
			authority.projectId !== scope.projectId
		) {
			return unavailable();
		}
		const selected = authority.evidence.find(
			(p) => p.observationId === pin.observationId,
		);
		if (
			!selected ||
			selected.watchId !== pin.watchId ||
			selected.grantId !== pin.grantId ||
			selected.grantRevision !== pin.grantRevision ||
			!digestMatches(selected.evidenceDigest, pin.evidenceDigest)
		) {
			return unavailable();
		}
		await pinned(pin, signal);
		const evidence = await getDeliverySourceEvidence(
			boundActor,
			{
				projectId: scope.projectId,
				watchId: pin.watchId,
				observationId: pin.observationId,
			},
			signal,
		);
		const latest = await pinned(pin, signal);
		return {
			pin: { ...pin },
			text: evidence.text,
			expiresAt: latest.expiresAt,
		};
	};
}
