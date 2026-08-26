/**
 * JWT authentication for Fabric Sandbox Worker
 * Validates requests from Fabric's Temporal workers
 */

import * as jose from "jose";
import type { Env, FabricJwtPayload } from "./types";

export interface AuthResult {
	userId: string;
	organizationId?: string;
}

/**
 * Verify JWT token from Authorization header
 */
export async function verifyAuth(
	request: Request,
	env: Env,
): Promise<AuthResult | null> {
	const authHeader = request.headers.get("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return null;
	}

	const token = authHeader.slice(7);

	try {
		const secret = new TextEncoder().encode(env.SANDBOX_AUTH_SECRET);
		const { payload } = await jose.jwtVerify(token, secret, {
			algorithms: ["HS256"],
		});

		const fabricPayload = payload as unknown as FabricJwtPayload;

		if (!fabricPayload.sub) {
			return null;
		}

		return {
			userId: fabricPayload.sub,
			organizationId: fabricPayload.org,
		};
	} catch (error) {
		console.error("JWT verification failed:", error);
		return null;
	}
}
