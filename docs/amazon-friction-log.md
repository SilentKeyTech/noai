# Friction log: Alexa+ track, Amazon Developer Hackathon

Written 30 Sep 2026 while building NOAI's self-hosted MCP server (`src/mcp.ts`, `src/mcp-serve.ts`) for the Alexa+ track. Each entry: task, steps, expected, actual, severity, workaround, suggestion.

## 1. Testing the server against Alexa+ itself

- **Task:** connect NOAI's self-hosted MCP server to Alexa+ and test the spoken path end to end.
- **Steps:** read the hackathon Resources page; followed its Alexa+ links to the MCP Streamable HTTP transport specification (2025-11-25) and the Agent Skills documentation.
- **Expected:** a guide to registering a self-hosted MCP server with Alexa+, or a console or simulator where Alexa+ acts as the MCP client.
- **Actual:** neither was linked. We found no route from the resources to point Alexa+ at our server.
- **Severity:** high. It blocks verifying the track's core path.
- **Workaround:** tested with the official MCP Inspector CLI and a simulated voice assistant (a standard MCP client) against the real server. The submission and video say plainly that the assistant is simulated.
- **Suggestion:** publish a "bring your own MCP server" guide for Alexa+, plus a test console that calls a builder's endpoint the way Alexa+ would.

## 2. Authentication for a self-hosted endpoint

- **Task:** choose how the endpoint authenticates Alexa+.
- **Steps:** searched the track resources for the authentication Alexa+ uses with self-hosted MCP servers.
- **Expected:** a statement of the supported method: OAuth 2.1 as described in the MCP specification, a bearer token, or something else, with any redirect URIs.
- **Actual:** not stated.
- **Severity:** medium. It decides the security design on day one.
- **Workaround:** a static bearer token compared in constant time, an Origin check against DNS rebinding, and binding to 127.0.0.1 by default. OAuth 2.1 is on our roadmap.
- **Suggestion:** document the supported authentication and the exact values Alexa+ sends.

## 3. How Alexa+ presents tool results

- **Task:** design tool results that keep private values private when spoken.
- **Steps:** looked for guidance on how Alexa+ renders a tool result: the text content, the structuredContent, or both, and how it reads unusual tokens.
- **Expected:** documentation on result rendering and text-to-speech behaviour.
- **Actual:** none found.
- **Severity:** medium. It matters most for privacy-focused tools.
- **Workaround:** `ask_noai` returns both text content and structuredContent, removes citations like `[P1]` that make no sense spoken, and its tool description tells the assistant to say "your saved number" for placeholders such as `[PHONE_1]` rather than guess.
- **Suggestion:** document which parts of a tool result Alexa+ reads out and how it handles bracketed placeholders.
