# Access Review Procedure — TEMPLATE (self-hosted Fabric)

> Fabric-authored base template. Complete every **[CUSTOMER: …]** placeholder,
> get management approval, and retain each signed review as SOC 2 evidence
> (CC6.1/CC6.2/CC6.3). This is the single most commonly-missing SOC 2 control —
> run it on a defined cadence with a named reviewer and a recorded decision.

| | |
|---|---|
| Owner | **[CUSTOMER: access-review owner]** |
| Cadence | Quarterly (recommended) |
| Approver | **[CUSTOMER: management]** |

## 1. Scope — what to review each cycle
1. **Fabric application roles** — org owner/admin/member/viewer per organization,
   and any global admins (`adminProcedure` allowlist). Export member lists from the
   in-app admin/User-Activity views.
2. **AWS IAM** — human users, roles, and policies on the account hosting Fabric.
3. **EKS RBAC** — cluster roles/bindings and who has `kubectl` access.
4. **Secrets Manager / KMS** — who can read secrets and use the CMKs.
5. **CI/CD** — who can trigger deploys / has OIDC-federated access.

## 2. Procedure
1. **Generate the current-state list** for each scope above. For AWS RBAC, an
   export of role assignments (principal, role, scope) is the review worksheet.
2. **Review each entry** — mark **KEEP** or **REVOKE** with a justification;
   confirm each maps to a current employee/workload with a business need
   (least privilege).
3. **Reconcile against HR** — remove access for anyone who has left. **[CUSTOMER]**
4. **Remediate** — revoke the REVOKE entries; open tickets for any that need change.
5. **Sign off** — the named reviewer signs and dates the completed worksheet.

## 3. Evidence to retain
The completed, **signed** review worksheet per cycle (with KEEP/REVOKE decisions
and justifications) and evidence that REVOKE items were actioned.

## 4. Recommended hardening (referenced from the gap analysis)
- Adopt just-in-time elevation for standing admin/owner access.
- Enforce org-wide MFA (Fabric ships the toggle).
- Restrict the EKS control-plane endpoint to an operator CIDR allowlist (G6).
