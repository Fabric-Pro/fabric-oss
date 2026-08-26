---
type: "manual"
---

# Fabric Augment Rules (Agents)

This directory contains specialized agent rules for Augment (Auggie CLI).

## Available Agents

| Agent | File | Purpose |
|-------|------|---------|
| `implementer` | `implementer.md` | Full-stack feature implementation |
| `spec-shaper` | `spec-shaper.md` | Requirements gathering |
| `spec-writer` | `spec-writer.md` | Writing detailed specs |
| `tasks-list-creator` | `tasks-list-creator.md` | Breaking specs into tasks |
| `backend-specialist` | `backend-specialist.md` | Backend/API development |
| `frontend-specialist` | `frontend-specialist.md` | Frontend/UI development |
| `database-specialist` | `database-specialist.md` | Database design |
| `test-specialist` | `test-specialist.md` | Testing strategies |
| `devops-specialist` | `devops-specialist.md` | CI/CD and infrastructure |
| `product-planner` | `product-planner.md` | Product vision and roadmap |
| `spec-verifier` | `spec-verifier.md` | Validating specs |
| `implementation-verifier` | `implementation-verifier.md` | Verifying implementations |
| `spec-initializer` | `spec-initializer.md` | Creating spec folders |
| `full-stack-specialist` | `full-stack-specialist.md` | End-to-end development |

## How to Use with Auggie CLI

### In Interactive Mode

Reference a rule directly in your prompt:

```
@implementer - Please implement the tasks in tasks.md
```

Or describe the agent behavior you need:

```
Act as the spec-shaper agent and help me gather requirements for a new feature
```

### Using Rules Files

Auggie CLI automatically loads rules from `.augment/rules/`. Simply reference the agent:

```
Use the backend-specialist rules to design the API
```

## Customization

You can modify these agent rules to match your team's workflow:

1. Edit any `.md` file to adjust behavior
2. Add new agents by creating new `.md` files
3. Reference your custom agents the same way

## Learn More

- [Auggie CLI Documentation](https://docs.augmentcode.com/auggie-cli/overview)
- [Rules & Guidelines](https://docs.augmentcode.com/auggie-cli/configure-auggie)

