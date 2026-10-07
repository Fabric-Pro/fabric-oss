import { openAPI } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { expect, it } from "vitest";

it("generates the auth schema with the explicit endpoint options used by the API", async () => {
	const { auth } = await getTestInstance({ plugins: [openAPI()] });
	const schema = await auth.api.generateOpenAPISchema({});
	expect(schema.openapi).toBe("3.1.1");
	expect(schema.paths["/get-session"].get).toBeDefined();
});
