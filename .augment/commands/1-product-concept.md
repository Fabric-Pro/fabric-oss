# Step 1: Product Concept

> **Usage**: Reference with `.augment/commands/1-product-concept.md` or copy into chat

---

## Workflow Instructions

This begins a multi-step process for planning and documenting the mission and roadmap for the current product.

The FIRST STEP is to confirm the product details by gathering the following information:

### Gather Product Information

1. **Product Name**: What is this product called?
2. **Problem Statement**: What problem does this product solve?
3. **Target Users**: Who are the primary users?
4. **Key Features**: What are the main capabilities?
5. **Success Metrics**: How will we measure success?
6. **Constraints**: Any technical or business constraints?

Then WAIT for user input to provide these details.

---

## Display Confirmation and Next Step

Once you've gathered all of the necessary information, output the following message:

```
✅ I have all the info I need to help you plan this product.

NEXT STEP 👉 Run .augment/commands/2-create-mission.md
```

---

## User Standards & Preferences Compliance

When planning the product's tech stack, mission statement and roadmap, use the user's standards and preferences for context and baseline assumptions, as documented in:
- `fabric/standards/` (if exists)
- `fabric/product/` (if exists)

