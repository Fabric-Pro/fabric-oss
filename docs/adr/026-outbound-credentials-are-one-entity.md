# ADR-026: Outbound credentials are one entity, referenced by consumers

Fabric stores each grant or key it uses to reach an external system once, and
every feature that needs it holds a reference, not a copy.

- **Audience**: Engineering
- **Owner**: Engineering team
- **Status**: Accepted
- **Date**: 2026-10-31
- **Deciders**: Engineering team
- **Supersedes in part**: ADR-004 (per-integration token columns on
  `ProjectRepositoryIntegration`); extends ADR-014

## Context

Outbound secrets live in at least twelve places. A person can hold
three live GitHub grants at once: the account-level `WorkflowIntegration`, one
per repository integration connected by OAuth, and an MCP configuration. Each
copy expires, refreshes and fails on its own. A feature reading the stale copy
fails while a fresh copy sits next to it, and the person cannot tell which
"Reconnect" button fixes what. Every grant is also a person's: it re-consents
when a scope is added, appears as that person at the provider, and dies when
they leave.

## Decision

1. **One `Credential` row per grant or key**, owned by a member or by the
   organization (`organizationId` required, ADR-018). A member's credential is
   private until its owner shares it with the organization.
2. **Consumers reference it** through a nullable `credentialId`, added one
   consumer at a time (expand), with legacy columns read as a fallback until a
   release shows no legacy reads (contract).
3. **One resolver and one refresher** (`@repo/integrations/credential-manager`):
   tenant, sharing and requirement checks on every call, including background
   activities; refresh under a per-credential advisory lock with a generation
   fence.
4. **Application authorization is the default.** An app installation (GitHub
   App), group access token, service principal or service account ranks above
   a person's OAuth grant, which ranks above a token. A person's credential
   remains the fallback, and the only choice when a feature must act as that
   person.
5. **App webhooks are configured on the App**, never registered on a customer
   repository, so ADR-011 ("Fabric never creates a webhook registration on
   GitHub") still holds. They accelerate; polling remains correct without them
   (ADR-010).
6. **Secrets never leave the server.** Metadata reads never select the secret
   column; there is no reveal action; audit metadata names provider, kind,
   label and scopes only.

## Consequences

- Reconnecting a credential once fixes every feature that uses it, and adding
  a scope upgrades the same row instead of creating a second grant.
- Deleting a credential in use is refused until its consumers move, which
  makes the dependency visible.
- During migration two paths exist per consumer (`credentialId` first, legacy
  columns second). Each phase must keep both correct until the contract
  phase removes the legacy one.
- A shared credential's rate limit and lifetime are shared by every consumer;
  the picker therefore prefers organization-owned app credentials.
