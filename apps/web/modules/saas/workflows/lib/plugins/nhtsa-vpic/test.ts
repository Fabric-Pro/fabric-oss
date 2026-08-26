/**
 * NHTSA VPIC Integration Test
 * Tests reachability of the public NHTSA VPIC API.
 */

import type { TestConnectionResult } from "../types";

export async function testNhtsaVpicConnection(
	_credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const response = await fetch(
			"https://vpic.nhtsa.dot.gov/api/vehicles/GetAllMakes?format=json",
		);
		if (response.ok) {
			return {
				success: true,
				message: "NHTSA VPIC API is reachable",
			};
		}
		return {
			success: false,
			error: `NHTSA API returned status ${response.status}`,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to NHTSA API",
		};
	}
}
