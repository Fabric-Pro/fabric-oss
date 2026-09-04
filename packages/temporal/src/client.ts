/**
 * Temporal client singleton
 * Provides connection to Temporal Server for starting workflows and querying status
 */

import * as tls from "node:tls";
import { Client, Connection, ScheduleClient } from "@temporalio/client";
import { makeCorrelationClientInterceptor } from "./lib/correlation-interceptor";
import type { TemporalConfig } from "./types";

let client: Client | null = null;
let scheduleClient: ScheduleClient | null = null;
let connection: Connection | null = null;

/**
 * Get Temporal configuration from environment variables
 */
export function getTemporalConfig(): TemporalConfig {
	const address = process.env.TEMPORAL_ADDRESS || "localhost:7233";
	const namespace = process.env.TEMPORAL_NAMESPACE || "default";
	const apiKey = process.env.TEMPORAL_CLOUD_API_KEY;
	const tls = process.env.TEMPORAL_TLS === "true" || !!apiKey;

	return {
		address,
		namespace,
		apiKey,
		tls,
	};
}

/**
 * SOC 2 CC6.7 (encryption in transit): FAIL-CLOSED in production — refuse a
 * plaintext Temporal connection. Staging and production use Temporal Cloud,
 * where the API-key branch enables TLS, so this only fires on a
 * misconfiguration that would silently downgrade the control channel.
 * Emergency escape hatch: TEMPORAL_ALLOW_INSECURE=true.
 *
 * Shared by the client `Connection` (this file) and the worker's
 * `NativeConnection` (worker.ts) so both channels fail closed the same way.
 */
export function assertInsecureConnectionAllowed(logPrefix: string): void {
	if (
		process.env.NODE_ENV === "production" &&
		process.env.TEMPORAL_ALLOW_INSECURE !== "true"
	) {
		throw new Error(
			`${logPrefix} Refusing to start in production without a TLS/authenticated ` +
				"connection. Set TEMPORAL_CLOUD_API_KEY (Temporal Cloud), mTLS certs, " +
				"or TEMPORAL_TLS=true. Set TEMPORAL_ALLOW_INSECURE=true to override in " +
				"an emergency (SOC 2 CC6.7).",
		);
	}
}

/**
 * Create a Temporal connection with the repo-wide connection policy:
 * Temporal Cloud API key, mTLS, plain TLS, or — outside production only —
 * an insecure local connection.
 *
 * Every `@temporalio/client` connection in the repo must come from here (or
 * from the singleton accessors below) so TLS, auth and the production
 * fail-closed guard cannot be bypassed by one caller. Enforced by
 * `__tests__/temporal-connection-policy.test.ts`.
 */
export async function createConnection(): Promise<Connection> {
	const config = getTemporalConfig();

	const connectionOptions: Parameters<typeof Connection.connect>[0] = {
		address: config.address,
	};

	// Configure authentication for Temporal Cloud
	if (config.apiKey) {
		// API Key authentication (recommended for Temporal Cloud)
		connectionOptions.apiKey = config.apiKey;
		// Get system root CA certificates for TLS verification
		// The native Rust core doesn't have access to system CAs, so we must provide them
		const rootCerts = tls.rootCertificates.join("\n");
		connectionOptions.tls = {
			serverRootCACertificate: Buffer.from(rootCerts),
		};
		connectionOptions.metadata = {
			"temporal-namespace": config.namespace,
		};
		console.log(
			"[Temporal] Using API Key authentication for Temporal Cloud",
		);
	} else if (
		config.tls &&
		process.env.TEMPORAL_CLIENT_CERT &&
		process.env.TEMPORAL_CLIENT_KEY
	) {
		// mTLS authentication (alternative method using client certificates)
		connectionOptions.tls = {
			clientCertPair: {
				crt: Buffer.from(process.env.TEMPORAL_CLIENT_CERT),
				key: Buffer.from(process.env.TEMPORAL_CLIENT_KEY),
			},
		};
		connectionOptions.metadata = {
			"temporal-namespace": config.namespace,
		};
		console.log("[Temporal] Using mTLS certificate authentication");
	} else if (config.tls) {
		// TLS enabled but no authentication (useful for self-hosted with TLS)
		connectionOptions.tls = true;
		console.log("[Temporal] Using TLS without authentication");
	} else {
		assertInsecureConnectionAllowed("[Temporal]");
		console.log("[Temporal] Using insecure connection (local development)");
	}

	return await Connection.connect(connectionOptions);
}

/**
 * Get or create Temporal client singleton
 *
 * @returns Temporal client instance
 * @throws Error if connection fails
 */
export async function getTemporalClient(): Promise<Client> {
	if (client) {
		return client;
	}

	try {
		const config = getTemporalConfig();

		// Create connection if not exists
		if (!connection) {
			connection = await createConnection();
		}

		// Create client. The correlation interceptor reads the active
		// request's correlation ID from AsyncLocalStorage and stamps it
		// onto every workflow execution's headers — covers all current
		// AND all future workflow.start callsites with zero per-callsite
		// work. See lib/correlation-interceptor.ts.
		client = new Client({
			connection,
			namespace: config.namespace,
			interceptors: {
				workflow: [makeCorrelationClientInterceptor()],
			},
		});

		console.log(
			`[Temporal] Connected to ${config.address} (namespace: ${config.namespace})`,
		);

		return client;
	} catch (error) {
		console.error("[Temporal] Failed to create client:", error);
		throw new Error(
			`Failed to connect to Temporal Server: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Get or create Temporal schedule client singleton
 *
 * Used for managing Temporal Schedules (cron-like triggers)
 *
 * @returns Temporal ScheduleClient instance
 * @throws Error if connection fails
 */
export async function getScheduleClient(): Promise<ScheduleClient> {
	if (scheduleClient) {
		return scheduleClient;
	}

	try {
		const config = getTemporalConfig();

		// Create connection if not exists
		if (!connection) {
			connection = await createConnection();
		}

		// Create schedule client
		scheduleClient = new ScheduleClient({
			connection,
			namespace: config.namespace,
		});

		console.log("[Temporal] Schedule client created");

		return scheduleClient;
	} catch (error) {
		console.error("[Temporal] Failed to create schedule client:", error);
		throw new Error(
			`Failed to create Temporal schedule client: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Close Temporal connection
 * Should be called on application shutdown
 */
export async function closeTemporalConnection(): Promise<void> {
	if (connection) {
		await connection.close();
		connection = null;
		client = null;
		scheduleClient = null;
		console.log("[Temporal] Connection closed");
	}
}

/**
 * Check if Temporal is available
 *
 * @returns true if Temporal client can be created
 */
export async function isTemporalAvailable(): Promise<boolean> {
	try {
		await getTemporalClient();
		return true;
	} catch {
		return false;
	}
}
