/**
 * GHSA-hgpx-52j8-8gq2: the registered undici instrumentation must not export
 * query values or URL credentials from outgoing fetch() calls. This builds the
 * instrumentation with the real auto-instrumentations factory and the exact
 * options initObservability registers, then fetches a local server.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAutoInstrumentationOptions } from "../lib/init";

const exporter = new InMemorySpanExporter();
let server: Server;
let origin: string;
let instrumentations: ReturnType<typeof getNodeAutoInstrumentations>;

beforeAll(async () => {
	server = createServer((_request, response) => response.end("ok"));
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const previous = process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
	process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = "undici";
	try {
		instrumentations = getNodeAutoInstrumentations(
			getAutoInstrumentationOptions(false),
		);
	} finally {
		if (previous === undefined) {
			delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
		} else {
			process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = previous;
		}
	}
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	for (const instrumentation of instrumentations) {
		instrumentation.setTracerProvider(provider);
		instrumentation.enable();
	}
});

afterAll(async () => {
	for (const instrumentation of instrumentations ?? []) {
		instrumentation.disable();
	}
	await new Promise((resolve) => server?.close(resolve));
});

describe("registered undici instrumentation", () => {
	it("is the only instrumentation built for this test", () => {
		expect(
			instrumentations.map(
				(instrumentation) => instrumentation.instrumentationName,
			),
		).toEqual(["@opentelemetry/instrumentation-undici"]);
	});

	it("exports outgoing fetch spans without query values", async () => {
		exporter.reset();
		const response = await fetch(
			`${origin}/object?sig=SYNTHETIC_SECRET&X-Amz-Signature=SYNTHETIC&name=a`,
		);
		await response.text();
		const spans = exporter
			.getFinishedSpans()
			.filter((span) =>
				span.instrumentationScope.name.includes("undici"),
			);
		expect(spans).toHaveLength(1);
		const [span] = spans;
		expect(span.attributes["url.full"]).toBe(
			`${origin}/object?sig=REDACTED&X-Amz-Signature=REDACTED&name=REDACTED`,
		);
		expect(span.attributes["url.query"]).toBe(
			"?sig=REDACTED&X-Amz-Signature=REDACTED&name=REDACTED",
		);
		expect(span.attributes["url.path"]).toBe("/object");
		expect(JSON.stringify(span.attributes)).not.toContain("SYNTHETIC");
		expect(span.name).not.toContain("SYNTHETIC");
	});
});
