# NOAI gateway in front of vLLM on an AMD GPU

**Status: not tested end to end.** The gateway side is tested against stand-in and Fireworks upstreams. The AMD GPU and vLLM steps follow AMD's and vLLM's own documentation and have not been run by us yet. The Dockerfile has not been built (no Docker on the author's machine).

The gateway forwards to any OpenAI-compatible URL, so pointing it at vLLM is settings only. Private details are hidden before the request leaves the gateway and restored in the reply.

## Shape

staff browser or tool -> NOAI gateway (hides private details) -> vLLM on an AMD GPU Droplet -> reply -> gateway restores the details

Run the gateway on the same Droplet as vLLM, or on a separate machine. If they share a machine, vLLM listens on 127.0.0.1 only, so nothing reaches the model without passing through NOAI.

## Steps

1. On AMD Developer Cloud, create a GPU Droplet (billed hourly; delete it when done).
2. Start vLLM with an open model, following AMD's ROCm vLLM guide, bound to 127.0.0.1:8000, with an API key of your choosing.
3. Add a person and keep the token: `npm run staff -- add demo --admin`
4. Start the gateway:
   ```
   NOAI_PASSPHRASE=... \
   NOAI_GATEWAY_UPSTREAM=http://127.0.0.1:8000/v1 \
   NOAI_GATEWAY_KEY=<the vLLM key> \
   NOAI_MODEL=<the model name vLLM serves> \
   NOAI_GATEWAY_MODELS=<the same name> \
   npm run gateway
   ```
   Or build the image: `docker build -t noai-gateway .` and pass the same values with `-e`, with a volume on `/data`.
5. Open `/chat`, send a message with a fake name and phone number, then open `/admin` and check the receipt shows what was hidden.

## Do not claim

Anonymous, unique, or compliant. The gateway hides the kinds of detail it can recognise; it cannot promise it caught everything.
