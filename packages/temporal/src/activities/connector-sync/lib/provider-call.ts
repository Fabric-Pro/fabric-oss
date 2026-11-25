import { ApplicationFailure } from "@temporalio/common";
import { CONNECTOR_SYNC_PROVIDER_RETURNED_CREDENTIAL } from "../../../workflows/connector-sync/connection-failures";
import type { ConnectorCredentials } from "../providers/types";

export { CONNECTOR_SYNC_PROVIDER_RETURNED_CREDENTIAL };

const SECRET_KEY = /(?:token|apikey|password|secretaccesskey|secret)$/;

function secretValues(credentials: ConnectorCredentials): string[] {
	const secrets = new Set<string>();
	for (const [key, value] of Object.entries(credentials)) {
		if (
			!SECRET_KEY.test(key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase()) ||
			typeof value !== "string" ||
			value.length < 8
		) {
			continue;
		}
		secrets.add(value);
		for (const user of [
			credentials.user,
			credentials.username,
			credentials.email,
			// Zendesk appends this suffix to its Basic auth username.
			typeof credentials.email === "string"
				? `${credentials.email}/token`
				: undefined,
		]) {
			if (typeof user === "string" && user) {
				secrets.add(Buffer.from(`${user}:${value}`).toString("base64"));
			}
		}
	}
	return [...secrets].sort((a, b) => b.length - a.length);
}

function containsSecretInError(
	error: unknown,
	containsSecret: (value: string) => boolean,
): boolean {
	const seen = new Set<Error>();
	let cause = error;
	while (cause instanceof Error && !seen.has(cause)) {
		seen.add(cause);
		if (
			containsSecret(cause.message) ||
			containsSecret(cause.name) ||
			(cause.stack && containsSecret(cause.stack))
		) {
			return true;
		}
		cause = cause.cause;
	}
	return containsSecretInValue(cause, containsSecret);
}

function containsSecretInValue(
	value: unknown,
	containsSecret: (value: string) => boolean,
	seen = new WeakSet<object>(),
): boolean {
	if (typeof value === "string") {
		return containsSecret(value);
	}
	if (value === null || typeof value !== "object" || seen.has(value)) {
		return false;
	}
	seen.add(value);
	return Object.entries(value).some(
		([key, item]) =>
			containsSecret(key) ||
			containsSecretInValue(item, containsSecret, seen),
	);
}

export async function callConnectorProvider<T>(
	credentials: ConnectorCredentials,
	call: () => T | Promise<T>,
): Promise<T> {
	const secrets = secretValues(credentials);
	const containsSecret = (value: string) =>
		secrets.some((secret) => value.includes(secret));

	let result: T;
	try {
		result = await call();
	} catch (error) {
		if (
			error instanceof ApplicationFailure ||
			!secrets.length ||
			!containsSecretInError(error, containsSecret)
		) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			secrets.reduce(
				(redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
				message,
			),
		);
	}
	if (secrets.length && containsSecretInValue(result, containsSecret)) {
		throw ApplicationFailure.nonRetryable(
			"The resource was skipped because its content contains the connection's credential.",
			CONNECTOR_SYNC_PROVIDER_RETURNED_CREDENTIAL,
		);
	}
	return result;
}
