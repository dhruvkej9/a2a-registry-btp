# A2A Agent Registry — SAP BTP Cloud Foundry POC

The [awslabs/a2a-agent-registry-on-aws](https://github.com/awslabs/a2a-agent-registry-on-aws) web UI, backed by a **single Node.js file** — no AWS account needed.

## What this is

| awslabs original | this repo |
|---|---|
| AWS Lambda functions | one Express `server.js` |
| Bedrock (Titan embeddings) | skipped — keyword/skill search |
| S3 Vectors | BTP Object Store (S3-compatible) or local JSON file |
| Cognito auth | skipped — UI patched to load without login |

The React UI (Cloudscape design) is the original, unmodified except for the auth-bypass patch, pre-built into `public/`.

## Deploy to SAP BTP CF

```bash
# 1. Clone
git clone https://github.com/dhruvkej9/a2a-registry-btp && cd a2a-registry-btp

# 2. Edit manifest.yml:
#    - services: your Object Store instance name
#    - REGISTRY_BUCKET / REGISTRY_FOLDER as you like
cf push
```

That's it. UI at the app URL, API on the same URL (`/agents`).

**Storage:** when an Object Store instance is bound, `registry.json` is stored at `s3://<REGISTRY_BUCKET>/<REGISTRY_FOLDER>/registry.json` (bucket/folder auto-created on first save). Without a binding, it falls back to `data/registry.json` on disk.

## Local dev

```bash
npm install
npm start          # http://localhost:3001
```

## API

Same contract as the original:

- `GET /agents?limit=&offset=` → `{ agents, pagination }`
- `POST /agents` (AgentCard JSON) → `{ agent_id, message }`
- `GET /agents/search?text=&skills=&top_k=` → `[ { agent_id, agent_card, ... } ]`
- `GET /agents/:id` → `{ agent }`
- `PUT /agents/:id` → partial update
- `DELETE /agents/:id`
- `POST /agents/:id/health`

## Registering agents

UI → **Register Agent** → paste AgentCard JSON (or use **Load Sample**). Required fields: `name`, `description`, `version`, `url`, `protocolVersion`, `capabilities`, `defaultInputModes/OutputModes`, `skills[]`.

## Rebuilding the UI (optional)

Only needed if you want to change the UI. `public/` already ships pre-built:

```bash
git clone https://github.com/awslabs/a2a-agent-registry-on-aws
cd a2a-agent-registry-on-aws/web-ui
# auth bypass: in src/components/ProtectedRoute.tsx replace the useEffect body with setIsAuthenticated(true)
REACT_APP_API_GATEWAY_URL= npm run build
cp -r build/* <this-repo>/public/
```

## Skipped (POC scope)

Semantic search (needs Bedrock/AI-CORE embeddings), auth (XSUAA/Cognito). Add when it matters.
