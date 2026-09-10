// Preload before the HTTP server and provider libraries so OTel can instrument them.
import { initializeHttpService } from "@repo/observability/http-server";

initializeHttpService({
	serviceName: process.env.OTEL_SERVICE_NAME || "weave-shuttle",
	metricExportInterval: 60_000,
	verboseInstrumentation: false,
});
