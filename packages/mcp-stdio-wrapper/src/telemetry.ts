// Preload before node:http is imported by the Hono server.
import { initializeHttpService } from "@repo/observability/http-server";

initializeHttpService({
	serviceName: process.env.OTEL_SERVICE_NAME || "mcp-stdio-wrapper",
	metricExportInterval: 60_000,
	verboseInstrumentation: false,
});
