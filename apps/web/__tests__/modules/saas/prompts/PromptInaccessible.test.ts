import { ORPCError } from "@orpc/client";
import { isPromptInaccessible } from "@saas/prompts/lib/prompt-inaccessible";
import { describe, expect, it } from "vitest";

describe("isPromptInaccessible", () => {
	it("keeps proxy HTML and explicitly marked empty 403/404 responses retryable", () => {
		// Arrange
		const proxyErrors = [
			Object.assign(new ORPCError("FORBIDDEN"), {
				data: { responseText: "<html>proxy denied</html>" },
			}),
			Object.assign(new ORPCError("NOT_FOUND"), {
				data: { responseText: "<html>proxy missing</html>" },
			}),
			Object.assign(new ORPCError("NOT_FOUND"), {
				data: { isNonOrpcResponse: true, responseText: "" },
			}),
		];

		// Act
		const inaccessible = proxyErrors.map(isPromptInaccessible);

		// Assert
		expect(inaccessible).toEqual([false, false, false]);
	});

	it("keeps genuine oRPC NOT_FOUND and FORBIDDEN access failures inaccessible", () => {
		// Arrange
		const apiErrors = [
			new ORPCError("NOT_FOUND"),
			new ORPCError("FORBIDDEN"),
		];

		// Act
		const inaccessible = apiErrors.map(isPromptInaccessible);

		// Assert
		expect(inaccessible).toEqual([true, true]);
	});
});
