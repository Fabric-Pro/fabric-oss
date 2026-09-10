import { createRequire, syncBuiltinESMExports } from "node:module";
import {
	initObservability,
	isObservabilityInitialized,
	type ObservabilityConfig,
	shutdownObservability,
} from "./init";

/** Preload before importing an ESM HTTP application. */
export function initializeHttpService(config: ObservabilityConfig): void {
	initObservability({ ...config, registerShutdownHooks: false });
	if (isObservabilityInitialized()) {
		// ESM imports of Node builtins bypass OTel's CommonJS require hook.
		// Trigger its HTTP patches, then expose them to named ESM imports too.
		const require = createRequire(import.meta.url);
		require("node:http");
		require("node:https");
		syncBuiltinESMExports();
	}
}

interface HttpServer {
	close(callback: (error?: Error) => void): unknown;
	closeIdleConnections?: () => void;
}

/** Drain in-flight requests before disposing resources and exporting final spans. */
export async function shutdownHttpServer(
	server: HttpServer,
	cleanup: () => Promise<void> = async () => {},
): Promise<void> {
	try {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			server.closeIdleConnections?.();
		});
		await cleanup();
	} finally {
		await shutdownObservability();
	}
}

/** Own the service signal handlers; initialize OTel with registerShutdownHooks:false. */
export function registerHttpServerShutdown(
	server: HttpServer,
	cleanup?: () => Promise<void>,
): void {
	let stopping = false;
	const shutdown = () => {
		if (stopping) {
			return;
		}
		stopping = true;
		// Streaming requests must not hold a terminating replica indefinitely.
		const deadline = setTimeout(() => process.exit(1), 15_000);
		deadline.unref();
		void shutdownHttpServer(server, cleanup).then(
			() => {
				clearTimeout(deadline);
				process.exit(0);
			},
			() => {
				clearTimeout(deadline);
				console.error("[Shutdown] Failed to drain service resources");
				process.exit(1);
			},
		);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
