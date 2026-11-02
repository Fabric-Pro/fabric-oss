import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

interface WindowsPathSecurity {
	owner: string;
	currentUser: string;
	protected: boolean;
	isDirectory: boolean;
	rules: {
		identity: string;
		type: string;
		rights: string;
		inherited: boolean;
		inheritance: string;
	}[];
}

export function readWindowsPathSecurity(target: string): WindowsPathSecurity {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot) {
		throw new Error("Windows system directory is unavailable");
	}
	const output = execFileSync(
		join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`
$ErrorActionPreference = 'Stop'
$attributes = [IO.File]::GetAttributes($env:FABRIC_TEST_PRIVATE_PATH)
$directory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
$acl = if ($directory) { [IO.Directory]::GetAccessControl($env:FABRIC_TEST_PRIVATE_PATH) } else { [IO.File]::GetAccessControl($env:FABRIC_TEST_PRIVATE_PATH) }
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inherited = $_.IsInherited; inheritance = $_.InheritanceFlags.ToString() }
})
@{ owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected = $acl.AreAccessRulesProtected; isDirectory = $directory; rules = $rules } | ConvertTo-Json -Depth 4 -Compress
`,
		],
		{
			windowsHide: true,
			timeout: 10_000,
			encoding: "utf8",
			env: {
				...process.env,
				FABRIC_TEST_PRIVATE_PATH: target,
			},
		},
	);
	const security: WindowsPathSecurity = JSON.parse(output);
	return security;
}

export function expectPrivateCodeIndexPath(
	target: string,
	mode: 0o600 | 0o700,
) {
	if (process.platform !== "win32") {
		expect(statSync(target).mode & 0o777).toBe(mode);
		return;
	}
	const security = readWindowsPathSecurity(target);
	expect(security.owner).toBe(security.currentUser);
	expect(security.protected).toBe(true);
	expect(security.isDirectory).toBe(mode === 0o700);
	expect(security.rules.map((rule) => rule.identity).sort()).toEqual(
		[...new Set([security.currentUser, "S-1-5-18"])].sort(),
	);
	for (const rule of security.rules) {
		expect(rule.type).toBe("Allow");
		expect(rule.rights).toBe("FullControl");
		expect(rule.inherited).toBe(false);
		expect(rule.inheritance).toBe(
			mode === 0o700 ? "ContainerInherit, ObjectInherit" : "None",
		);
	}
}
