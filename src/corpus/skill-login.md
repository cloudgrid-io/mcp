---
version: 0.2.0
name: login
description: |
  Sign in to CloudGrid, with or without the CLI. Use when the user wants to log in,
  sign in, authenticate, connect their account, or claim an anonymous drop they made
  earlier. Uses CloudGrid's existing OAuth. No new account needed.
argument-hint: ""
allowed-tools: Bash
---

# CloudGrid Login

Get the user a CloudGrid identity token. This is the step that turns an anonymous
user into an owned one — and the step that lets them claim earlier anonymous drops.

There are two paths. Pick the first that fits.

## Path 1 — the CLI is installed

If `cloudgrid` is on `$PATH`, this is the simplest and safest:

```
cloudgrid login
```

It opens the browser, handles the OAuth flow, and stores the token. Stop here.

## Path 2 — no CLI (the CLI-free flow)

Reproduce the same OAuth flow by hand. It writes the same credentials file the CLI
uses (`~/.cloudgrid/credentials`), so the two share one identity.

1. Make a session code and give the user the sign-in URL:

   ```
   CODE=$(uuidgen | tr 'A-Z' 'a-z')
   echo "Open this and sign in with Google: https://api.cloudgrid.io/auth/login?code=$CODE"
   ```

   Show the user the URL. Wait for them to say they finished.

2. Poll for the token (the window is 5 minutes; it is single-use):

   ```
   curl -sS "https://api.cloudgrid.io/auth/status?code=$CODE"
   ```

   - `{"status":"pending"}` or `404` — not done yet. Ask the user to finish, retry.
   - `{"status":"authenticated","jwt":"..."}` — capture the `jwt`. Continue.
   - `{"status":"expired"}` — the window closed. Start over from step 1.

3. Save the token in the CLI's format, readable only by the user:

   ```
   umask 077 && mkdir -p ~/.cloudgrid
   # JWT holds the token captured above
   PAYLOAD=$(printf '%s' "$JWT" | cut -d. -f2 | tr '_-' '/+')
   EMAIL=$(printf '%s==' "$PAYLOAD" | base64 -d 2>/dev/null | (jq -r .email 2>/dev/null || true))
   UID=$(printf '%s==' "$PAYLOAD" | base64 -d 2>/dev/null | (jq -r .sub 2>/dev/null || true))
   printf '{"jwt":"%s","issued_at":"%s","email":"%s","user_id":"%s"}\n' \
     "$JWT" "$(date -u +%FT%TZ)" "$EMAIL" "$UID" > ~/.cloudgrid/credentials
   chmod 600 ~/.cloudgrid/credentials
   ```

   If `jq` is not available, leave `email` and `user_id` empty — only the `jwt`
   matters; the server reads identity from the token itself.

## UX rules

- Be concise. The user does one thing: open a link and sign in.
- Detect the user's language from their first message and reply in it.
- Never write the token anywhere except `~/.cloudgrid/credentials`. Never print it.

## After login

Confirm the user is signed in (`cloudgrid whoami` if the CLI is present). If they
made an anonymous drop earlier, this is the moment to offer to claim it.

## Notes

- Enterprise single sign-on is not supported in this flow yet; those users sign in
  through the Console for now.
- The MCP server exposes the same flow as `grid_login` and
  `grid_login_status`, which handle the polling and the credentials write for
  you.
