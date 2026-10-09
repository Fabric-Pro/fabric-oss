/**
 * The impersonation marker on the signed tenant headers the ai-config routes
 * read (Fizzy #2770 D7).
 *
 * The marker is a field of the signed payload, so the HMAC covers it: it
 * cannot be added, stripped or flipped in transit. Compatibility runs both
 * ways because the signature scheme itself is unchanged (`verifyTenantContext`
 * is the same code an older verifier runs): an older signer's payload has no
 * field and verifies as not impersonated, and a newer signer's payload
 * verifies on an older verifier, which simply ignores the field.
 */

import {
	signTenantContext,
	verifySignedTenantRequest,
	verifyTenantContext,
} from "@repo/agent-runtime";
import { runWithAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentModelAsync } from "../src/services/langchain-models";

const SECRET = "test-agent-service-secret-0123456789abcdef";

function headersFrom(signed: ReturnType<typeof signTenantContext>) {
	return {
		"X-Service-Token": SECRET,
		"X-Tenant-Payload": signed.payload,
		"X-Tenant-Signature": signed.signature,
		"X-Tenant-Timestamp": String(signed.timestamp),
	};
}

function payloadOf(headers: Record<string, string>) {
	return JSON.parse(
		Buffer.from(headers["X-Tenant-Payload"] ?? "", "base64").toString(),
	) as Record<string, unknown>;
}

beforeEach(() => {
	vi.stubEnv("AGENT_SERVICE_SECRET", SECRET);
	vi.stubEnv("FABRIC_API_URL", "https://app.example.com");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("signed tenant context — compatibility", () => {
	it("an older signer's payload (no marker) verifies as not impersonated", () => {
		const signed = signTenantContext(
			{ userId: "user-1", organizationId: "org-1" },
			SECRET,
		);
		expect(verifySignedTenantRequest(headersFrom(signed))).toEqual({
			ok: true,
			userId: "user-1",
			organizationId: "org-1",
			impersonated: false,
		});
	});

	it("a newer signer's marked payload still verifies on the unchanged scheme", () => {
		const signed = signTenantContext(
			{ userId: "user-1", organizationId: "org-1", impersonated: true },
			SECRET,
		);
		// The older verifier's code path: HMAC over the payload, extra fields kept.
		expect(verifyTenantContext(signed, SECRET)).toMatchObject({
			userId: "user-1",
			impersonated: true,
		});
		expect(verifySignedTenantRequest(headersFrom(signed))).toMatchObject({
			ok: true,
			impersonated: true,
		});
	});

	it("rejects a payload whose marker was stripped in transit", () => {
		const signed = signTenantContext(
			{ userId: "user-1", organizationId: "org-1", impersonated: true },
			SECRET,
		);
		const stripped = {
			...JSON.parse(Buffer.from(signed.payload, "base64").toString()),
		};
		delete stripped.impersonated;
		const tampered = {
			...signed,
			payload: Buffer.from(JSON.stringify(stripped)).toString("base64"),
		};
		expect(verifySignedTenantRequest(headersFrom(tampered))).toMatchObject({
			ok: false,
			status: 401,
		});
	});
});

describe("agents asking the ai-config route", () => {
	function captureAiConfigRequest() {
		const requests: Record<string, string>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (
					_url: string,
					init: { headers: Record<string, string> },
				) => {
					requests.push(init.headers);
					return new Response(
						JSON.stringify({
							provider: "OPENAI_DIRECT",
							apiKey: "sk-example",
							model: "gpt-4o-mini",
							gatewayUrl: null,
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					);
				},
			),
		);
		return requests;
	}
	const config = {
		configurable: {
			tenant_user_id: "user-1",
			tenant_organization_id: "org-1",
		},
	};

	it("marks the request when an admin started this run as the member", async () => {
		const requests = captureAiConfigRequest();
		await runWithAiInteractiveContext(
			{ userId: "user-1", impersonated: true },
			() => getAgentModelAsync(config),
		);
		expect(payloadOf(requests[0] ?? {})).toMatchObject({
			userId: "user-1",
			impersonated: true,
		});
		expect(verifySignedTenantRequest(requests[0] ?? {})).toMatchObject({
			ok: true,
			impersonated: true,
		});
	});

	it("sends the same payload shape as before otherwise", async () => {
		const requests = captureAiConfigRequest();
		await getAgentModelAsync(config);
		const payload = payloadOf(requests[0] ?? {});
		expect(payload).not.toHaveProperty("impersonated");
		expect(verifySignedTenantRequest(requests[0] ?? {})).toMatchObject({
			ok: true,
			impersonated: false,
		});
	});

	it("does not mark a run for one member with another's impersonation", async () => {
		const requests = captureAiConfigRequest();
		await runWithAiInteractiveContext(
			{ userId: "someone-else", impersonated: true },
			() => getAgentModelAsync(config),
		);
		expect(payloadOf(requests[0] ?? {})).not.toHaveProperty("impersonated");
	});
});
