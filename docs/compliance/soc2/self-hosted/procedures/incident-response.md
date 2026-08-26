# Incident Response Procedure — TEMPLATE (self-hosted Fabric)

> **How to use:** this is a Fabric-authored base template with product-specific
> context pre-filled. Replace every **[CUSTOMER: …]** placeholder, have management
> approve it, and retain the signed version + each incident record as SOC 2
> evidence (CC7.3/CC7.4). Review at least annually and after any real incident.

| | |
|---|---|
| Owner | **[CUSTOMER: named incident manager]** |
| Approver | **[CUSTOMER: management]** |
| Version / date | v0.1 (template) / **[CUSTOMER: date]** |
| Review cadence | Annual + post-incident |

## 1. Purpose & scope
Defines how the customer detects, triages, contains, eradicates, recovers from,
and reviews security/availability incidents affecting its self-hosted Fabric
deployment.

## 2. Roles
- **Incident Manager** — coordinates response, owns communications. **[CUSTOMER]**
- **Technical responders** — EKS/RDS/app on-call. **[CUSTOMER]**
- **Fabric technical contact** — for product-level questions/vulnerabilities. **[CUSTOMER: contact from deployment hand-off]**

## 3. Severity classification
| Sev | Definition | Target response |
|---|---|---|
| SEV1 | Confirmed breach, data exposure, or full outage | Immediate |
| SEV2 | Partial outage, suspected compromise, or a high-severity vuln in a running component | < 1 hour |
| SEV3 | Degraded service or a medium-severity finding | Next business day |

## 4. Detection sources (Fabric-specific)
- Application **audit log** (`AuditLog`) — authentication failures, role changes,
  admin actions; exportable/queryable.
- Fluent Bit / OpenTelemetry streams routed to **[CUSTOMER: SIEM]**.
- AWS GuardDuty / CloudTrail / RDS + EKS logs. **[CUSTOMER: enable + alert]**
- Fabric release security advisories. **[CUSTOMER: subscribe]**

## 5. Procedure
1. **Detect & record** — open an incident ticket; capture time, source, severity.
2. **Triage** — classify severity; assign Incident Manager + responders.
3. **Contain** — e.g. revoke sessions/keys, scale down an affected component,
   restrict network policy, rotate the relevant Secrets Manager secret + KMS grant.
4. **Eradicate** — apply the fix (patch, config change, credential rotation); if a
   Fabric vulnerability, coordinate with the Fabric contact and upgrade the release.
5. **Recover** — restore service from a known-good state; if data integrity is in
   question, restore RDS from a point-in-time backup and re-verify audit-log seals.
6. **Communicate** — notify stakeholders/customers/regulators per **[CUSTOMER: policy]**.
7. **Post-incident review** — within **[CUSTOMER: N]** days, document root cause,
   timeline, corrective actions, and owners. Retain the record.

## 6. Evidence to retain (for the auditor)
Incident ticket, timeline, severity, containment/eradication actions, restore
evidence, and the post-incident review with sign-off.

## 7. Tabletop
Run and retain at least one IR **tabletop exercise** per audit period. **[CUSTOMER]**
