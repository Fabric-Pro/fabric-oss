import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
it("passes the server retention switch through Turbo's dev environment", () => {
	const config = readFileSync(resolve(root, "turbo.json"), "utf8");
	const list =
		config.match(/"globalPassThroughEnv"\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
	expect([...list.matchAll(/"([^"]+)"/g)].map((match) => match[1])).toContain(
		"ADVISOR_HISTORY_RETENTION",
	);
});
it("routes root environment entries into Aspire's web resource", () => {
	const appHost = readFileSync(
		resolve(root, "aspire/Fabric.AppHost/Program.cs"),
		"utf8",
	);
	expect(appHost).toContain('Path.Combine(repoRoot, ".env.local")');
	expect(appHost).toContain("envVars[key] = value;");
	const web = appHost.slice(appHost.indexOf('builder.AddNextJsApp("web"'));
	const start = web.indexOf("foreach (var (key, value) in envVars)");
	const end = web.indexOf("if (devTunnelId is { Length: > 0 })");
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const forwarding = web.slice(start, end);
	expect(forwarding).toContain("web = web.WithEnvironment(key, value);");
	expect(forwarding).not.toContain("ADVISOR_HISTORY_RETENTION");
});

it("omits the retired result-read setting from server configuration", () => {
	for (const file of ["turbo.json", ".env.example"]) {
		expect(readFileSync(resolve(root, file), "utf8")).not.toContain(
			"ADVISOR_RESULT_READS",
		);
	}
});
