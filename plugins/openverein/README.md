# OpenVerein for Claude Code

This plugin connects Claude Code to an OpenVerein club over MCP. You sign in once in the browser (OAuth), and the agent then sees and does exactly what you can in the club administration or the member portal, never more.

- Install: `/plugin install openverein --marketplace krautdawg/openverein` (Claude Code 2.1.275 or later), then `/mcp` → openverein → sign in. Details: [Mit Claude Code verbinden](../../README.md#mit-claude-code-verbinden).
- Your club's address: the environment variable `OPENVEREIN_URL` (default `https://klub2.ki-klub-werder.de`, the public demo).

## Privacy

The plugin contains no code that runs on your machine and stores no data or token in any file. It tells Claude Code one address: `$OPENVEREIN_URL/mcp`. Claude Code keeps the OAuth sign-in in its own credential store. Everything the agent reads or changes goes only to that club instance. The club runs it and is responsible for the data (its own privacy policy applies). On the instance, every agent call is logged for its owner, and the owner can revoke access at any time under Agenten.
