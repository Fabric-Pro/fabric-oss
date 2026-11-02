import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const WINDOWS_PRIVATE_PATH = `
$ErrorActionPreference = 'Stop'
$target = $env:FABRIC_PRIVATE_PATH
$directory = $env:FABRIC_PRIVATE_PATH_KIND -eq 'directory'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$principals = @($user.Value, 'S-1-5-18') | Select-Object -Unique
$acl = if ($directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
foreach ($principal in $principals) {
  $sid = New-Object Security.Principal.SecurityIdentifier($principal)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
if ($directory) {
  if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) {
    throw 'Private directory target already exists'
  }
  [void][IO.Directory]::CreateDirectory($target, $acl)
} else {
  if ([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Private file cannot be a reparse point'
  }
  [IO.File]::SetAccessControl($target, $acl)
}
$attributes = [IO.File]::GetAttributes($target)
$isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or $isDirectory -ne $directory) {
  throw 'Private artifact has an unexpected file type'
}
$actual = if ($directory) { [IO.Directory]::GetAccessControl($target) } else { [IO.File]::GetAccessControl($target) }
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value -or $rules.Count -ne $principals.Count) {
  throw 'Private artifact ACL was not applied'
}
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.IdentityReference.Value -notin $principals -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inheritance) {
    throw 'Private artifact ACL is broader than its owner and SYSTEM'
  }
}
`;

function protectPath(target: string, kind: "directory" | "file"): void {
	if (process.platform !== "win32") {
		fs.chmodSync(target, kind === "directory" ? 0o700 : 0o600);
		return;
	}
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot) {
		throw new Error("Windows system directory is unavailable");
	}
	const result = spawnSync(
		path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
		["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PRIVATE_PATH],
		{
			windowsHide: true,
			timeout: 10_000,
			encoding: "utf8",
			env: {
				...process.env,
				FABRIC_PRIVATE_PATH: target,
				FABRIC_PRIVATE_PATH_KIND: kind,
			},
		},
	);
	if (result.error || result.status !== 0) {
		throw new Error(
			`Cannot secure private code-index ${kind} (exit ${result.status}): ${result.stderr?.trim().slice(0, 2_000) ?? ""}`,
			{ cause: result.error },
		);
	}
}

/** Restrict an empty new directory before repository or manifest data enters it. */
export function createPrivateCodeIndexDirectory(prefix: string): string {
	if (process.platform === "win32") {
		const directory = `${prefix}${randomUUID()}`;
		// CreateDirectory applies the DACL at creation. If the child fails, it
		// cannot safely tell us whether the path was created or already existed.
		protectPath(directory, "directory");
		return directory;
	}
	const directory = fs.mkdtempSync(prefix);
	try {
		protectPath(directory, "directory");
		return directory;
	} catch (error) {
		fs.rmdirSync(directory);
		throw error;
	}
}

/** Protect the file itself so moving it to a legacy temp parent keeps its ACL. */
export function writePrivateCodeIndexFile(target: string, data: string): void {
	fs.writeFileSync(target, data, { flag: "wx", mode: 0o600 });
	protectPath(target, "file");
}
