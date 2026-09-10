/*
 * A2A Agent Registry — single-file POC backend for SAP BTP Cloud Foundry
 * Replaces the entire awslabs/a2a-agent-registry-on-aws backend:
 *   Lambda  -> this Express server
 *   Bedrock -> skipped (search is keyword/skill-based, POC)
 *   S3 Vectors -> BTP Object Store (S3-compatible) via aws-sdk v3
 *
 * Storage: one JSON document (agent cards) in the Object Store bucket.
 * Falls back to local file ./data/registry.json when no VCAP_SERVICES
 * object store binding exists (local dev / testing).
 *
 * API (exact contract of the original web-ui AgentRegistryClient.ts):
 *   GET    /agents?limit=&offset=        -> { agents: [...], pagination: {limit, offset, total, has_more} }
 *   POST   /agents                       -> { agent_id, message }
 *   GET    /agents/search?text=&skills=&top_k= -> [ { agent_id, agent_card, similarity_score, matched_skills } ]
 *   GET    /agents/:id                   -> { agent: card }
 *   PUT    /agents/:id                   -> { agent_id, message }
 *   DELETE /agents/:id                   -> { message }
 *   POST   /agents/:id/health            -> { message, timestamp }
 *   GET    /healthz                      -> { status: "ok" }
 *
 * The web-ui builds with REACT_APP_API_GATEWAY_URL=http://localhost:3001
 * (no identity pool id) and consumes this API as-is.
 */
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- CORS (POC: open; tighten before any real use) ----------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------- Storage: BTP Object Store (S3) or local JSON file ----------
const BUCKET = process.env.REGISTRY_BUCKET || 'agent-registry';
const KEY = 'registry.json';

let s3 = null;
try {
  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
  const osBinding = (vcap['objectstore'] || vcap['s3'] || [])[0];
  if (osBinding) {
    const c = osBinding.credentials;
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      region: c.region || 'us-east-1',
      endpoint: c.endpoint || c.host || (c.s3_endpoint), // BTP OS provides endpoint in creds
      forcePathStyle: true,
      credentials: {
        accessKeyId: c.access_key_id || c.aws_access_key_id || c.username,
        secretAccessKey: c.secret_access_key || c.aws_secret_access_key || c.password,
      },
    });
    console.log('[registry] using BTP Object Store bucket:', BUCKET);
  }
} catch (e) {
  console.warn('[registry] VCAP parse failed, falling back to local file:', e.message);
}

const LOCAL_FILE = path.join(__dirname, 'data', 'registry.json');
let cache = null; // { agents: {id: {card, created_at, updated_at, last_online}} }

function loadSync() {
  if (cache) return cache;
  cache = { agents: {} };
  return cache;
}

async function load() {
  if (cache) return cache;
  if (s3) {
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
      cache = JSON.parse(await r.Body.transformToString());
    } catch (e) {
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
        cache = { agents: {} };
        await save();
      } else throw e;
    }
  } else {
    try {
      cache = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
    } catch {
      cache = { agents: {} };
    }
  }
  return cache;
}

async function save() {
  const body = JSON.stringify(cache);
  if (s3) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: KEY, Body: body, ContentType: 'application/json' }));
  } else {
    fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_FILE, body);
  }
}

// ---------- API ----------
const err = (res, code, error_code, message, details) =>
  res.status(code).json({ error: error_code, message, ...(details ? { details } : {}) });

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Browser page navigation to /agents → serve the SPA, not the API list
app.get('/agents', (req, res, next) => {
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

// List
app.get('/agents', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const db = await load();
  const all = Object.entries(db.agents)
    .map(([id, rec]) => ({ ...rec.card, agent_id: id, updated_at: rec.updated_at }))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json({
    agents: all.slice(offset, offset + limit),
    pagination: { limit, offset, total: all.length, has_more: offset + limit < all.length },
  });
});

// Create
app.post('/agents', async (req, res) => {
  const card = req.body;
  if (!card || typeof card !== 'object') return err(res, 400, 'VALIDATION_ERROR', 'Request body must be an agent card JSON');
  if (!card.name) return err(res, 400, 'VALIDATION_ERROR', 'Agent card must have a name');
  const db = await load();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.agents[id] = { card, created_at: now, updated_at: now, last_online: now };
  await save();
  res.status(201).json({ agent_id: id, message: 'Agent registered successfully' });
});

// Search (keyword over name/description/skills — Bedrock-free)
app.get('/agents/search', async (req, res) => {
  const text = (req.query.text || '').toString().toLowerCase();
  const skills = (req.query.skills || '').toString().split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const topK = Math.min(parseInt(req.query.top_k) || 10, 30);
  if (!text && skills.length === 0) return err(res, 400, 'VALIDATION_ERROR', 'Either text or skills must be provided');

  const db = await load();
  const results = [];
  for (const [id, rec] of Object.entries(db.agents)) {
    const c = rec.card;
    const haystack = [c.name, c.description, ...(c.skills || []).map(s => `${s.name || ''} ${s.description || ''} ${(s.tags || []).join(' ')}`)]
      .join(' ').toLowerCase();
    let matched = [];
    if (text && !haystack.includes(text)) {
      // every word of the query must appear somewhere (lazy AND search)
      const words = text.split(/\s+/).filter(Boolean);
      if (!words.every(w => haystack.includes(w))) continue;
    }
    if (skills.length) {
      const agentSkills = (c.skills || []).map(s => (s.name || '').toLowerCase());
      matched = skills.filter(s => agentSkills.some(a => a.includes(s)));
      if (matched.length === 0) continue;
    }
    results.push({
      agent_id: id,
      agent_card: c,
      similarity_score: 1.0,
      matched_skills: matched,
    });
    if (results.length >= topK) break;
  }
  res.json(results);
});

// Get one
app.get('/agents/:id', async (req, res) => {
  const db = await load();
  const rec = db.agents[req.params.id];
  if (!rec) return err(res, 404, 'AGENT_NOT_FOUND', `Agent with ID ${req.params.id} not found`);
  res.json({ agent: rec.card });
});

// Update (partial)
app.put('/agents/:id', async (req, res) => {
  const db = await load();
  const rec = db.agents[req.params.id];
  if (!rec) return err(res, 404, 'AGENT_NOT_FOUND', `Agent with ID ${req.params.id} not found`);
  rec.card = { ...rec.card, ...req.body };
  rec.updated_at = new Date().toISOString();
  await save();
  res.json({ agent_id: req.params.id, message: 'Agent updated successfully' });
});

// Delete
app.delete('/agents/:id', async (req, res) => {
  const db = await load();
  if (!db.agents[req.params.id]) return err(res, 404, 'AGENT_NOT_FOUND', `Agent with ID ${req.params.id} not found`);
  delete db.agents[req.params.id];
  await save();
  res.json({ message: 'Agent deleted successfully' });
});

// Health heartbeat
app.post('/agents/:id/health', async (req, res) => {
  const db = await load();
  const rec = db.agents[req.params.id];
  if (!rec) return err(res, 404, 'AGENT_NOT_FOUND', `Agent with ID ${req.params.id} not found`);
  rec.last_online = new Date().toISOString();
  await save();
  res.json({ message: 'Health updated successfully', timestamp: rec.last_online });
});

// ---------- Static UI (optional): put the built web-ui in ./public ----------
// SPA fallback: hash-less client routes (/register, /agents) must serve index.html.
// GET /agents (API list) is registered above, so it wins over this fallback for
// browser navigation only if Accept header is not HTML — differentiate:
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(?!agents|healthz).*/, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[registry] listening on :${PORT}`));

module.exports = app;
