/**
 * Internal S2 adapter boundary, not a Portal DTO or an authorization grant.
 * Callers resolve and authorize a watched source server-side before building
 * this envelope. Current source access must be repeated before reading evidence.
 * No provider I/O, persistence, cursor advancement or scheduling happens here.
 */
import { createHash } from "node:crypto";

export type DeliverySignalCaptureProvider =
	| "SLACK"
	| "TEAMS"
	| "JIRA"
	| "AZURE_DEVOPS"
	| "FIZZY";

export interface DeliverySignalCaptureSource {
	organizationId: string;
	projectId: string;
	bindingId: string;
	audienceId: string;
	audienceRevision: number;
	provider: DeliverySignalCaptureProvider;
	installationId: string;
	containerId: string;
}
export type DeliverySignalCaptureRevision = {
	/** Opaque revisions (including ETags) must never be ordered lexically. */
	kind: "INTEGER" | "DECIMAL" | "UTC_TIME" | "OPAQUE";
	value: string;
};
export interface DeliverySignalCapture {
	schemaVersion: 1;
	adapterVersion: string;
	source: DeliverySignalCaptureSource;
	externalItemId: string;
	revision: DeliverySignalCaptureRevision;
	change: "UPSERT" | "DELETE";
	occurredAt: string;
	observedAt: string;
	/** Untrusted display text, never instructions, policy or execution authority. */
	untrustedSummary: string;
	/** References an immutable, source-protected snapshot; never an external URL. */
	evidenceRef: string | null;
	evidenceDigest: string | null;
}
export interface PreparedDeliverySignalCapture extends DeliverySignalCapture {
	sourceKey: string;
	receiptKey: string;
}
export class DeliverySignalCaptureError extends Error {
	readonly code = "INVALID_DELIVERY_SIGNAL_CAPTURE";
	constructor() {
		// Never reflect provider payloads, identifiers, cursor values or secrets.
		super(
			"The source capture does not match the supported adapter contract.",
		);
		this.name = "DeliverySignalCaptureError";
	}
}
function invalid(): never {
	throw new DeliverySignalCaptureError();
}
function record(input: unknown, keys: readonly string[]) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		invalid();
	}
	const value = input as Record<string, unknown>;
	if (
		Object.keys(value).length !== keys.length ||
		Object.keys(value).some((key) => !keys.includes(key)) ||
		keys.some((key) => !Object.hasOwn(value, key))
	) {
		invalid();
	}
	return value;
}
function identifier(input: unknown, maximum = 200): string {
	if (
		typeof input !== "string" ||
		!input ||
		input.trim() !== input ||
		input.length > maximum ||
		/\p{Cc}/u.test(input)
	) {
		invalid();
	}
	return input;
}
function time(input: unknown): string {
	const value = identifier(input, 24);
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) {
		invalid();
	}
	return value;
}
function hash(value: readonly unknown[]): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function source(input: unknown): DeliverySignalCaptureSource {
	const value = record(input, [
		"organizationId",
		"projectId",
		"bindingId",
		"audienceId",
		"audienceRevision",
		"provider",
		"installationId",
		"containerId",
	]);
	if (
		!Number.isSafeInteger(value.audienceRevision) ||
		(value.audienceRevision as number) < 1 ||
		!["SLACK", "TEAMS", "JIRA", "AZURE_DEVOPS", "FIZZY"].includes(
			value.provider as string,
		)
	) {
		invalid();
	}
	return {
		organizationId: identifier(value.organizationId),
		projectId: identifier(value.projectId),
		bindingId: identifier(value.bindingId),
		audienceId: identifier(value.audienceId),
		audienceRevision: value.audienceRevision as number,
		provider: value.provider as DeliverySignalCaptureProvider,
		installationId: identifier(value.installationId),
		containerId: identifier(value.containerId),
	};
}
/** Canonical revision identity shared by receipts and immutable evidence digests. */
export function normalizeDeliverySignalCaptureRevision(
	input: unknown,
): DeliverySignalCaptureRevision {
	const raw = record(input, ["kind", "value"]);
	const value = identifier(raw.value, 512);
	switch (raw.kind) {
		case "INTEGER":
			if (!/^(0|[1-9]\d{0,63})$/.test(value)) {
				invalid();
			}
			return { kind: "INTEGER", value };
		case "DECIMAL": {
			if (!/^(0|[1-9]\d{0,19})(\.\d{1,9})?$/.test(value)) {
				invalid();
			}
			const [whole, fraction] = value.split(".");
			const significant = fraction?.replace(/0+$/, "");
			return {
				kind: "DECIMAL",
				value: significant ? `${whole}.${significant}` : whole,
			};
		}
		case "UTC_TIME":
			return { kind: "UTC_TIME", value: time(value) };
		case "OPAQUE":
			return { kind: "OPAQUE", value };
		default:
			return invalid();
	}
}

/** Validate a provider-selected envelope; never accepts a raw provider payload. */
export function prepareDeliverySignalCapture(
	input: unknown,
): PreparedDeliverySignalCapture {
	const value = record(input, [
		"schemaVersion",
		"adapterVersion",
		"source",
		"externalItemId",
		"revision",
		"change",
		"occurredAt",
		"observedAt",
		"untrustedSummary",
		"evidenceRef",
		"evidenceDigest",
	]);
	if (
		value.schemaVersion !== 1 ||
		!["UPSERT", "DELETE"].includes(value.change as string)
	) {
		invalid();
	}
	const scope = source(value.source);
	const version = normalizeDeliverySignalCaptureRevision(value.revision);
	const externalItemId = identifier(value.externalItemId);
	if (
		typeof value.untrustedSummary !== "string" ||
		value.untrustedSummary.length > 480 ||
		Array.from(value.untrustedSummary).length > 240 ||
		/\p{Cc}/u.test(value.untrustedSummary)
	) {
		invalid();
	}
	if (value.change === "DELETE") {
		if (
			value.evidenceRef !== null ||
			value.evidenceDigest !== null ||
			value.untrustedSummary !== ""
		) {
			invalid();
		}
	} else if (
		typeof value.evidenceRef !== "string" ||
		!/^[-\w]{1,200}$/.test(value.evidenceRef) ||
		typeof value.evidenceDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.evidenceDigest)
	) {
		invalid();
	}
	const sourceKey = hash([
		1,
		scope.organizationId,
		scope.projectId,
		scope.bindingId,
		scope.audienceId,
		scope.audienceRevision,
		scope.provider,
		scope.installationId,
		scope.containerId,
	]);
	return {
		schemaVersion: 1,
		adapterVersion: identifier(value.adapterVersion, 64),
		source: scope,
		externalItemId,
		revision: version,
		change: value.change as "UPSERT" | "DELETE",
		occurredAt: time(value.occurredAt),
		observedAt: time(value.observedAt),
		untrustedSummary: value.untrustedSummary,
		evidenceRef: value.evidenceRef as string | null,
		evidenceDigest: value.evidenceDigest as string | null,
		sourceKey,
		// Retry time, adapter upgrades and summary wording cannot make a
		// second receipt for the same source audience/item/revision.
		receiptKey: hash([
			1,
			sourceKey,
			externalItemId,
			version.kind,
			version.value,
		]),
	};
}

/** A data comparison only. Persistence must retain conflicts and reauthorize reads. */
export function compareDeliverySignalCapture(
	current: PreparedDeliverySignalCapture,
	incoming: PreparedDeliverySignalCapture,
):
	| "UNRELATED"
	| "DUPLICATE"
	| "REVISION_CONFLICT"
	| "NEWER"
	| "OLDER"
	| "RECONCILE" {
	if (
		current.sourceKey !== incoming.sourceKey ||
		current.externalItemId !== incoming.externalItemId
	) {
		return "UNRELATED";
	}
	if (current.receiptKey === incoming.receiptKey) {
		return current.change === incoming.change &&
			current.evidenceDigest === incoming.evidenceDigest
			? "DUPLICATE"
			: "REVISION_CONFLICT";
	}
	if (
		current.revision.kind !== incoming.revision.kind ||
		current.revision.kind === "OPAQUE"
	) {
		return "RECONCILE";
	}
	const orderValue = (item: DeliverySignalCaptureRevision) => {
		if (item.kind === "UTC_TIME") {
			return BigInt(Date.parse(item.value));
		}
		if (item.kind === "INTEGER") {
			return BigInt(item.value);
		}
		const [whole, fraction = ""] = item.value.split(".");
		return (
			BigInt(whole) * BigInt(1_000_000_000) +
			BigInt(fraction.padEnd(9, "0"))
		);
	};
	return orderValue(incoming.revision) > orderValue(current.revision)
		? "NEWER"
		: "OLDER";
}
