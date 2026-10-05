# Using Open WebUI with the NOAI gateway

**Status: not tested.** Docker and Python are not installed on the machine this was written on, so this has not been run. The gateway side is tested with an OpenAI-style client; the steps below are what Open WebUI's own documentation describes for any OpenAI-compatible provider. Try it on a spare machine before showing anyone.

If you only need a chat page, the gateway already serves one at `/chat`. Use Open WebUI only if the company wants its extras (saved chats, many users, a polished look).

## Steps

1. On the machine that runs the gateway, add a person for the web UI to act as, and keep the token:
   `npm run staff -- add webui`
2. Start the gateway so the web UI machine can reach it: set `NOAI_GATEWAY_HOST=0.0.0.0` (or the machine's own address) and `npm run gateway`. Anyone who can reach that port and has a token can use it, so keep it on the company network.
3. Start Open WebUI (its own instructions: `docker run -d -p 3000:8080 ghcr.io/open-webui/open-webui:main`).
4. In Open WebUI: Admin Settings, Connections, OpenAI, add a connection:
   - URL: `http://<gateway machine>:7794/v1`
   - API key: the token from step 1
5. Pick a model from the list and send a message with a fake name and phone number. Open the gateway receipts page (`/admin`) and check the call shows the hidden values and the redacted text.

## Things to know

- Open WebUI sends every message as the one `webui` person. The receipts page will say `webui`, not the individual staff member. For per-person receipts, give each person the gateway token directly, or use the built-in `/chat` page.
- Open WebUI can send images, files and tool calls. The gateway refuses those on purpose, because it cannot hide what is inside them. Turn those features off in Open WebUI, or staff will see errors.
- Open WebUI also makes small background calls (chat titles, tags). They go through the gateway too, hidden and receipted like any other.
- The gateway still cannot make the ChatGPT or Copilot apps use it. Only tools that let you set a base URL work.
