---
name: deploy-errors
when: A deploy, drop, or extension install fails and you need to map the symptom to a fix.
summary: Symptom, cause, and fix for the common deploy and install errors — SCOPE_INVALID, the anonymous cap, EDIT_REJECTED, owner_token, and the helper-app and permission-prompt cases.
---

# Troubleshooting: deploy errors

Match the symptom to the row, apply the fix, and stop. Do not retry permutations.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `SCOPE_INVALID` on deploy | Known platform issue, not your request | Deploy from a terminal with `grid plug <path>` or `cloudgrid plug <path>`. Do not retry flag or path permutations. If no terminal is available, tell the user it is a known issue that needs the CLI. |
| `429` anonymous cap reached | Anonymous deploy quota is exhausted | Stop. Do not log in to work around it and do not retry today. Tell the user the cap is reached; they can try later or sign in for a higher limit as a deliberate choice. |
| `409 EDIT_REJECTED` on re-plug | The target entity is archived or expired | Do not silently create a new entity — that mints a new URL and orphans the shared one. Ask the user before creating a fresh entity. |
| `401` on an anonymous edit | Missing or stale `owner_token` | Re-plug with the `owner_token` from the last deploy of that entity. Each anonymous edit returns a fresh token — store the new one and use it next time. |
| "Unable to find helper app" | Fixed in `.mcpb` >= 0.7.1 | Reinstall the extension to pick up the fixed helper. |
| Desktop / ChatGPT re-prompts for permission on every call | Normal client UX, not an error | This is expected client behavior. Click Allow. Nothing is wrong with the deploy. |

For the reasoning behind the deploy-error cases, see the `publish-fallbacks`
rule.
