import { describe, expect, it } from "vitest";
import {
	projectReportDiagnostics,
	reportConnectionDiagnosticsSchema,
} from "../prisma/queries/lib/report-public-diagnostics";

describe("public report connection diagnostics", () => {
	it("projects useful safe counts and fixed codes without forwarding messages, IDs, names or URLs", () => {
		const hostile = {
			configId: "example-private-config",
			serverName: "https://private.example.com",
			provider: "github",
			outcome: "unreachable",
			toolCount: 12,
			readOnlyToolCount: 7,
			errorMessage:
				"Bearer example-private-token https://private.example.com",
			nested: { secret: "example-secret" },
		};
		const result = projectReportDiagnostics([hostile]);
		expect(result).toEqual([
			{
				providerType: "github",
				displayLabel: "Source 1",
				status: "unreachable",
				reasonCode: "NETWORK_UNAVAILABLE",
				toolCount: 12,
				readOnlyToolCount: 7,
			},
		]);
		expect(reportConnectionDiagnosticsSchema.parse(result)).toEqual(result);
		expect(JSON.stringify(result)).not.toMatch(
			/private|Bearer|https|secret|configId|serverName/,
		);
	});
	it.each([
		{
			provider: "https://private.example.com",
			outcome: "connected",
			toolCount: 2,
			readOnlyToolCount: 1,
		},
		{
			provider: "github",
			outcome: "https://private.example.com",
			toolCount: 2,
			readOnlyToolCount: 1,
		},
		{
			provider: "github",
			outcome: "connected",
			toolCount: 1e9,
			readOnlyToolCount: 1,
		},
		{
			provider: "github",
			outcome: "connected",
			toolCount: 2,
			readOnlyToolCount: 3,
		},
		{
			provider: "github",
			outcome: "connected",
			toolCount: "2",
			readOnlyToolCount: 1,
		},
		"Bearer example-token",
	])("does not forward hostile metadata %j", (raw) => {
		const result = projectReportDiagnostics([raw]);
		expect(() =>
			reportConnectionDiagnosticsSchema.parse(result),
		).not.toThrow();
		expect(JSON.stringify(result)).not.toMatch(
			/private|https|Bearer|example-token/,
		);
		if (
			typeof raw !== "object" ||
			raw.outcome !== "connected" ||
			typeof raw.toolCount !== "number" ||
			raw.toolCount > 10000 ||
			raw.readOnlyToolCount > raw.toolCount
		) {
			expect(result?.[0]).toMatchObject({
				status: "unavailable",
				reasonCode: "INVALID_DIAGNOSTIC",
				toolCount: null,
				readOnlyToolCount: null,
			});
		} else {
			expect(result?.[0]?.providerType).toBe("other");
		}
	});
	it("bounds arbitrary arrays and marks omissions instead of inventing zero counts", () => {
		const result = projectReportDiagnostics(
			Array.from({ length: 1000 }, () => ({
				provider: "github",
				outcome: "connected",
				toolCount: 1,
				readOnlyToolCount: 1,
			})),
		);
		expect(result).toHaveLength(20);
		expect(result?.at(-1)).toMatchObject({
			status: "unavailable",
			reasonCode: "DIAGNOSTICS_TRUNCATED",
			toolCount: null,
		});
		expect(projectReportDiagnostics(null)).toBeNull();
		expect(projectReportDiagnostics({ error: "secret" })).toEqual([
			{
				providerType: "other",
				displayLabel: "Source details",
				status: "unavailable",
				reasonCode: "INVALID_DIAGNOSTIC",
				toolCount: null,
				readOnlyToolCount: null,
			},
		]);
	});
	it("strictly rejects raw or unexpected fields in the public contract", () => {
		expect(() =>
			reportConnectionDiagnosticsSchema.parse([
				{
					providerType: "github",
					displayLabel: "Source 1",
					status: "connected",
					reasonCode: "AVAILABLE",
					toolCount: 1,
					readOnlyToolCount: 1,
					errorMessage: "unsafe",
				},
			]),
		).toThrow();
	});
});
