import { describe, expect, it } from "vitest";
import {
	buildFabricServiceHeaders,
	FABRIC_SERVICE_HEADERS,
	readFabricServiceActor,
} from "../fabric-mcp-service-headers";

const actor = {
	userId: "user-1",
	organizationId: "org-1",
	actingGrant: "grant.example",
	projectId: "project-1",
};

describe("acting surface header", () => {
	it("carries a Parlume turn's surface from the worker to the gateway", () => {
		const headers = new Headers(
			buildFabricServiceHeaders("service-secret", {
				...actor,
				surface: "parlume",
			}),
		);

		expect(headers.get(FABRIC_SERVICE_HEADERS.surface)).toBe("parlume");
		expect(readFabricServiceActor(headers)).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			surface: "parlume",
		});
	});

	it("drops a surface the gateway does not know", () => {
		const headers = new Headers(
			buildFabricServiceHeaders("service-secret", actor),
		);
		headers.set(FABRIC_SERVICE_HEADERS.surface, "meeting");

		expect(readFabricServiceActor(headers)?.surface).toBeUndefined();
	});
});
