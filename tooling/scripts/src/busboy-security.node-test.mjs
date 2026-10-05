import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Inspect the installed production transitive consumer. A direct dependency
// here could hide its disappearance from the production chain; knip.json
// permits this intentional inspection only in the tooling/scripts workspace.
const consumerPackage = fileURLToPath(
	new URL(
		"../../../node_modules/.pnpm/@whatwg-node+node-fetch@0.8.2/node_modules/@whatwg-node/node-fetch/package.json",
		import.meta.url,
	),
);
const consumerRequire = createRequire(consumerPackage);

test("node-fetch resolves the reviewed Busboy security release", () => {
	assert.equal(
		consumerRequire("@fastify/busboy/package.json").version,
		"3.2.1",
	);
});

test("ordinary multipart fields and files remain compatible through node-fetch", async () => {
	const { Request, FormData, File } = consumerRequire(
		"@whatwg-node/node-fetch",
	);
	const body = new FormData();
	body.set("field", "example value");
	body.set(
		"upload",
		new File(["example file"], "example.txt", { type: "text/plain" }),
	);
	const request = new Request("https://example.com/upload", {
		method: "POST",
		body,
	});
	// Serialize first so formData exercises Busboy instead of returning the
	// already constructed FormData supplied to the first Request.
	const parsed = await new Request("https://example.com/upload", {
		method: "POST",
		headers: { "content-type": request.headers.get("content-type") },
		body: await request.arrayBuffer(),
	}).formData();
	assert.equal(parsed.get("field"), "example value");
	const upload = parsed.get("upload");
	assert.equal(upload.name, "example.txt");
	assert.equal(upload.type, "text/plain");
	assert.equal(await upload.text(), "example file");
});
