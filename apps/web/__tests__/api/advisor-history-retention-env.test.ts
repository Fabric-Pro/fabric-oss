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
	const web = appHost.slice(appHost.indexOf('builder.AddExecutable("web"'));
	const forwarding = web.slice(
		web.indexOf("foreach (var (key, value) in envVars)"),
		web.indexOf("if (devTunnelUrl is not null)"),
	);
	expect(forwarding).toContain("web = web.WithEnvironment(key, value);");
	expect(forwarding).not.toContain("ADVISOR_HISTORY_RETENTION");
});
