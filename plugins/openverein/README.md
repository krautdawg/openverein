# OpenVerein for Claude Code

This plugin connects Claude Code to an OpenVerein club over MCP. You sign in once in the browser (OAuth), and the agent then sees and does exactly what you can in the club administration or the member portal, never more.

- Install: `/plugin install openverein --marketplace krautdawg/openverein` (Claude Code 2.1.275 or later). Then enter your club's address when asked, and sign in under `/mcp` → openverein. Details: [Mit Claude Code verbinden](../../README.md#mit-claude-code-verbinden).
- The club's address is a required plugin option (`club_url`) with no default, so the plugin never connects to a club you didn't choose. Change it with `/plugin configure openverein@openverein`.

## Privacy

The plugin contains no code that runs on your machine and stores no data or token in any file. It tells Claude Code one address, the one you entered: `<club_url>/mcp`. Claude Code keeps the OAuth sign-in in its own credential store. Everything the agent reads or changes goes only to that club instance. The club runs it and is responsible for the data (its own privacy policy applies). On the instance, every read or write the agent makes is logged for its owner, and the owner can revoke access at any time under Agenten.
