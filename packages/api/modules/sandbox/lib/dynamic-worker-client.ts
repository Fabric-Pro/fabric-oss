import { SignJWT } from "jose";
import { ExecutionResultSchema, type Language } from "../types";

const EXECUTE_ENDPOINT = "/execute";

interface ExecuteDynamicWorkerCodeInput {
	userId: string;
	organizationId?: string;
	code: string;
	language: Language;
	timeout: number;
}

interface DynamicWorkerResponse {
	success: boolean;
	data?: unknown;
	error?: {
		code?: string;
		message?: string;
	};
}

function getSandboxWorkerConfig(): { baseUrl: string; authSecret: string } {
	const baseUrl = process.env.SANDBOX_WORKER_URL;
	const authSecret = process.env.SANDBOX_AUTH_SECRET;

	if (!baseUrl) {
		throw new Error("SANDBOX_WORKER_URL environment variable is required");
	}

	if (!authSecret) {
		throw new Error("SANDBOX_AUTH_SECRET environment variable is required");
	}

	return { baseUrl: baseUrl.replace(/\/$/, ""), authSecret };
}

async function createAuthToken(
	authSecret: string,
	userId: string,
	organizationId?: string,
): Promise<string> {
	const secret = new TextEncoder().encode(authSecret);

	return new SignJWT({
		sub: userId,
		org: organizationId,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(secret);
}

export async function executeDynamicWorkerCode(
	input: ExecuteDynamicWorkerCodeInput,
) {
	const { baseUrl, authSecret } = getSandboxWorkerConfig();
	const token = await createAuthToken(
		authSecret,
		input.userId,
		input.organizationId,
	);

	const response = await fetch(`${baseUrl}${EXECUTE_ENDPOINT}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			code: input.code,
			language: input.language,
			timeout: input.timeout,
		}),
	});

	const payload = (await response.json()) as DynamicWorkerResponse;

	if (!response.ok || !payload.success) {
		throw new Error(
			payload.error?.message || "Dynamic Worker code execution failed",
		);
	}

	return ExecutionResultSchema.parse(payload.data);
}
