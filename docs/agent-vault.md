# Agent vault: connect Claude Code in five minutes (Windows)

The agent vault holds your API keys and small credential files, such as an Android upload keystore. Claude Code (or any MCP client) can use them, but never sees them:

1. The agent writes a placeholder such as `{{secret:github_token}}` where the key belongs.
2. NOAI swaps in the real value at the moment the request leaves, in `src/gate.ts`, the only file in NOAI that can reach the network. It does this only for the hosts and the part of the request you allowed.
3. Before the agent sees the response, NOAI blanks out any vault secret it finds in it, so an API that echoes your key back shows the placeholder.
4. Every use, sent or refused, gets an Ed25519-signed receipt on the same hash chain as NOAI's other receipts. You can check the chain offline. Receipts name the secret, the host, the time and the client. They never hold the value.

It all runs on your own PC. There is no account and no cloud service, and the vault itself works offline. Only the requests you ask for go out, to the hosts you allowed.

## What you need

- Windows 10 or 11, Node.js 22.18 or newer (`node --version`).
- This repository, with `npm install` run once. NOAI needs no native binaries, so it works with Smart App Control turned on.
- Claude Code (`claude --version`).

All the commands below are typed in PowerShell, in the repository folder.

## 1. Make the vault (1 minute)

```powershell
npm run vault -- init
```

It asks for a passphrase twice and does not show what you type. It prints a **device key** fingerprint, such as `bf45d217e0f0aaa2`. Write it down; you will use it to check your receipts.

The vault is the file `.noai\vault.json`. Without the passphrase, it shows only how many secrets it holds and when each was added. Names, hosts and values are all sealed. Set `NOAI_HOME` to keep it somewhere else.

## 2. Add a secret (1 minute)

```powershell
npm run vault -- add github_token --host api.github.com
```

It asks for the value and does not show it. The value never goes on the command line, so it never lands in PowerShell's history.

- `--host` is required and must be exact. You can repeat it. Wildcards are not allowed.
- By default a secret may only go in a request **header**. Add `--in url` for APIs that want the key in the query string, or `--in body` only if you really need it (see "Limits").
- For a file, use `--file`:

```powershell
npm run vault -- add play_upload_keystore --file .\upload-keystore.jks --host signing.example.test --in body
```

The agent uses a file as `{{secret:play_upload_keystore:base64}}`. To check the sealed copy before you delete the original file, run `npm run vault -- export play_upload_keystore .\check.jks`.

`npm run vault -- list` shows names, hosts and sizes, never values. To delete a secret, run `npm run vault -- remove github_token`.

## 3. Start the vault for agents (30 seconds)

Open a **separate** PowerShell window, which you leave open while the agent works:

```powershell
npm run vault -- serve
```

It asks for the passphrase, then prints something like:

```
NOAI agent vault on http://127.0.0.1:7792/mcp, 1 secret(s), receipts in C:\...\.noai
Connect Claude Code once, from any terminal:
  claude mcp add --transport http noai-vault http://127.0.0.1:7792/mcp --header "Authorization: Bearer noai_..."
```

The server only listens on this PC (127.0.0.1). Pressing Ctrl+C locks the vault again.

Start the vault yourself, in your own window. Do not let the agent start it: whoever starts the vault has to type the passphrase.

## 4. Connect Claude Code (30 seconds)

Copy the `claude mcp add ...` line the server printed and run it once in any terminal. Then check it:

```powershell
claude mcp list
```

`noai-vault` should be listed as connected. You only do this once. The bearer token is sealed in the vault and stays the same each time you start the server. To change it, run `npm run vault -- token --rotate` and connect again.

## 5. Try it (1 minute)

In Claude Code, ask:

> Use noai-vault to list my secrets, then call https://api.github.com/user with my github_token and tell me my login.

Claude Code calls `list_secrets` and sees `{{secret:github_token}}`. It then calls `http_request` with the header `Authorization: Bearer {{secret:github_token}}`. GitHub receives the real token, but Claude Code only gets the response, with any echo of the token blanked out.

To see the refusal, ask it to send the same token to any other site. The answer is `Refused: github_token may only be sent to api.github.com, not to ... Nothing was sent.`

## 6. Check what happened

```powershell
npm run vault -- receipts
npm run vault -- verify --expect bf45d217e0f0aaa2
```

Example output from a real run on 1 Oct 2026, using a test token against the public echo service httpbin.org:

```
2026-10-01 15:01:26  claude-code  demo_token  GET httpbin.org/headers  sent, HTTP 200, 1 echo(es) blanked
2026-10-01 15:01:26  claude-code  demo_token  GET example.org/steal  REFUSED: demo_token may only be sent to httpbin.org, not to example.org.
VALID: All 2 disclosures are intact, signed and in order.
2 of them are secret uses: 1 sent, 1 refused, 0 failed.
Every receipt is signed by the expected key bf45d217e0f0aaa2.
```

`verify` needs only `receipts.jsonl` and `ledger.jsonl`, with no vault, passphrase or network, so you can hand those two files to someone else to check. Use `--dir` to point it at a copy. It exits with code 1 if the chain is broken or signed by a different key.

## The three MCP tools

| Tool | What it does | Returns a value? |
|---|---|---|
| `list_secrets` | Names, placeholders, allowed hosts and allowed places | Never |
| `http_request` | One HTTPS request with placeholders, which NOAI fills in on the way out | No. Secrets in the response are blanked |
| `verify_disclosures` | Checks the whole receipt chain | No |

`npm run vault -- serve` offers these three tools only. To serve the private-notes tools as well, run `npm run mcp` with `NOAI_MCP_TOOLS=all` and `NOAI_MCP_TOKEN` set.

## Limits, stated plainly

- **This is not a wall between programs.** Claude Code runs as your Windows user. An agent that can run any shell command as you could in principle attack the vault process, or a file you exported. The vault means the key is never in the agent's context, its logs, or its model provider's servers. Keep Claude Code's permission prompts on, and never give an agent the passphrase.
- **An allowed host can still be misused.** If a secret may go in the body of requests to a host that stores what it receives (for example a gist or an issue), an agent could store the secret there. That is why the default is header only. Allow `body` only for hosts and secrets that need it.
- **Blanking echoes catches the usual forms**: the value as it is, base64, URL-encoded and hex. A response that returns the secret changed some other way is not caught. The host and placement rules are the main protection.
- **Redirects are not followed**, so a secret is never carried to a second host. The agent sees the 3xx response and can decide what to do next.
- **A receipt is a signed statement by your device.** It proves what your device sent and refused, and that nothing was edited or removed afterwards. It cannot prove what the remote API did with the request.
- **Memory.** After each request, NOAI wipes the buffers that held the value. Text strings made from the value cannot be wiped in JavaScript, and stay in the server's memory until it is reused.
- **Files** are only used inside HTTPS requests, as base64. NOAI does not yet hand a keystore to a local tool such as Gradle.
- **No independent security review yet.**
