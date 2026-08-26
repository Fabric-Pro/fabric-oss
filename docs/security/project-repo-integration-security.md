# Security Model: Project Repository Integrations

## Token Lifecycle

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Token Lifecycle                                    │
│                                                                          │
│  1. ENCRYPT                                                              │
│     Owner completes OAuth or enters PAT                                  │
│     → encryptApiKey(token) using AES-256-GCM                            │
│     → Key derived from BETTER_AUTH_SECRET via scrypt                     │
│     → Format: iv:authTag:encryptedData (all hex)                        │
│                                                                          │
│  2. STORE                                                                │
│     encryptedAccessToken, encryptedRefreshToken, encryptedPat            │
│     → Stored in project_repository_integration table                     │
│     → Never returned to frontend (select block excludes these fields)    │
│                                                                          │
│  3. DECRYPT (server-side only)                                           │
│     → Temporal activities: health check, code analysis                   │
│     → API procedures: PAT validation (before storing)                    │
│     → decryptApiKey(encrypted) → plaintext token                        │
│     → Plaintext token NEVER persisted, logged, or returned via API      │
│                                                                          │
│  4. REFRESH (GitHub OAuth only)                                          │
│     → Health check detects expiring token (< 5 min remaining)           │
│     → Calls GitHub token endpoint with refresh_token                     │
│     → New token encrypted and stored via optimistic locking              │
│     → Only one concurrent refresh succeeds (updatedAt lock)              │
│                                                                          │
│  5. EXPIRE                                                               │
│     → Health check detects 401/403 AND refresh fails                    │
│     → Status set to TOKEN_EXPIRED                                       │
│     → All members see degraded banner                                    │
│     → Audit log entry: repo_integration_token_expired                   │
│     → Owner must re-authenticate to restore                             │
│                                                                          │
│  6. REVOKE (manual or automatic)                                        │
│     → Owner disconnects: record deleted, token destroyed                │
│     → Owner removed from project: status → DISCONNECTED                 │
│     → Previously extracted ProjectContext entries remain (historical)     │
└──────────────────────────────────────────────────────────────────────────┘
```

## Access Control Matrix

| Action | OWNER | EDITOR | VIEWER | Non-member |
|--------|-------|--------|--------|------------|
| Configure/add integration | Yes | No | No | No |
| Remove/update integration | Yes | No | No | No |
| Use repo context (LLM queries) | Yes | Yes | Yes | No |
| Trigger fresh repo scan | Yes | Yes | Yes | No |
| View integration status | Yes | Yes | Yes | No |
| See degraded status banner | Yes | Yes | Yes | No |
| Re-authenticate expired token | Yes | No | No | No |

**Enforcement points:**
- Configuration: `getProjectRole() === "owner"`
- Usage: `hasProjectAccess(projectId, userId, organizationId)`
- Credential decryption: only in Temporal activities and server-side API procedures

## Multi-Tenant Isolation (3 Layers)

### Layer 1: Project Membership

```
hasProjectAccess(projectId, userId, organizationId)
├─ Org project: verifies org membership + project member/owner
└─ Personal project: verifies owner or accepted member
```

Every API procedure calls this before any integration operation. Non-members receive HTTP 403.

### Layer 2: Integration → Project Binding

```
ProjectRepositoryIntegration.projectId = Project.id
├─ Integration belongs to exactly ONE project
├─ Cannot be queried without projectId in the WHERE clause
├─ Cascade delete when project is deleted
└─ Unique constraint: [projectId, provider, repositoryOwner, repositoryName]
```

All query functions require `projectId` as a mandatory parameter. There is no API to list integrations across projects.

### Layer 3: Token Never Leaves Server

```
Frontend receives: status, repo name, provider, configuredBy
Frontend NEVER receives: encryptedAccessToken, encryptedRefreshToken, encryptedPat
```

The `listProjectRepoIntegrations` function uses a Prisma `select` block that explicitly includes only safe fields. Encrypted fields are not in the select and therefore cannot appear in the response.

## What a Compromised Project-Level Token Can Do

| Can | Cannot |
|-----|--------|
| Read repository contents (files, branches, commits) | Push code or create branches |
| List repositories accessible to the token owner | Create/merge pull requests |
| Search code within accessible repos | Delete repositories |
| Read commit history and diffs | Modify repository settings |
| Read issue/PR metadata (if repo scope includes it) | Access other users' tokens |
| | Access repos not visible to the token owner |
| | Access integrations from other projects |

**Blast radius:** Limited to read access on repos the original token owner authorized. The token's scope is set during OAuth consent (typically `repo` + `read:user` for GitHub). Write operations are not exposed via any tool handler in the project integration path.

## Incident Response: Revoking a Compromised Integration

### Immediate Steps

1. **Disconnect the integration** via project settings (OWNER) or directly:
   ```sql
   DELETE FROM project_repository_integration
   WHERE id = '<integration-id>';
   ```

2. **Revoke the OAuth token** at the provider:
   - GitHub: Settings → Applications → Authorized OAuth Apps → Revoke
   - Azure DevOps: User Settings → Personal Access Tokens → Revoke

3. **Check audit logs** for unauthorized access:
   ```sql
   SELECT * FROM project_activity
   WHERE "projectId" = '<project-id>'
   AND "activityType" IN (
     'repo_context_accessed',
     'repo_scan_triggered',
     'repo_integration_configured'
   )
   ORDER BY "createdAt" DESC;
   ```

### Post-Incident

4. **Rotate the GitHub OAuth App secret** if the app credentials themselves are compromised (not just a user token):
   - Update `FABRIC_GITHUB_CLIENT_SECRET` in all environments
   - All existing refresh tokens become invalid
   - All project integrations using GitHub OAuth will need re-authentication

5. **Review project membership** to ensure no unauthorized members were added

6. **Re-configure the integration** with fresh credentials after the compromised token is revoked
