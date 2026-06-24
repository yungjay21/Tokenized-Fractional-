import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';
import { readFileSync, writeFileSync, existsSync, accessSync, constants } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:5173', 'http://localhost:4173'];

// Read at request time so tests can set env vars before the first request
function getDataFile() {
  return join(__dirname, process.env.DATA_FILE || 'data.json');
}

function loadData() {
  const file = getDataFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    console.error('Corrupted data file, starting fresh');
    return {};
  }
}

function saveData(data) {
  writeFileSync(getDataFile(), JSON.stringify(data, null, 2), 'utf-8');
}

function validateContractId(id) {
  return typeof id === 'string' && id.length >= 50 && id.startsWith('C');
}

function validateRwaBody(body) {
  const required = ['title', 'location', 'description', 'assetType'];
  const missing = required.filter(f => !body[f]);
  if (missing.length > 0) {
    return `Missing required fields: ${missing.join(', ')}`;
  }
  return null;
}

function adminAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const expected = process.env.ADMIN_API_KEY || 'dev-key-change-in-production';
  if (!apiKey || apiKey !== expected) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }
  next();
}

const app = express();

app.use(helmet());
app.use(cors({ origin: CORS_ORIGINS, methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'x-api-key'] }));
app.use(express.json({ limit: '10kb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', apiLimiter);

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests, please try again later' },
});

// ── Health check helpers ──────────────────────────────────────────────────────
async function checkRedis() {
  if (!process.env.REDIS_URL) return { status: 'not_configured' };
  const client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.ping();
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', message: err.message };
  } finally {
    client.disconnect();
  }
}

function checkStorage() {
  const file = getDataFile();
  try {
    // Check the directory is readable/writable (file may not exist yet)
    const dir = dirname(file);
    accessSync(dir, constants.R_OK | constants.W_OK);
    return { status: 'ok', path: file };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

app.get('/health', async (_req, res) => {
  const [storage, redis] = await Promise.all([
    Promise.resolve(checkStorage()),
    checkRedis(),
  ]);

  const allOk = storage.status === 'ok' &&
    (redis.status === 'ok' || redis.status === 'not_configured');

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    dependencies: { storage, redis },
  });
});

app.get('/api/rwa', (_req, res) => {
  const data = loadData();
  const assets = Object.entries(data).map(([contractId, meta]) => ({
    contractId,
    ...meta,
  }));
  res.json(assets);
});

app.get('/api/rwa/:contractId', (req, res) => {
  const { contractId } = req.params;
  const data = loadData();
  const asset = data[contractId];

  if (!asset) {
    return res.status(404).json({ error: 'Asset metadata not found' });
  }

  res.json({ contractId, ...asset });
});

app.post('/api/rwa', adminAuth, writeLimiter, (req, res) => {
  const { contractId, ...metadata } = req.body;

  if (!contractId || !validateContractId(contractId)) {
    return res.status(400).json({ error: 'Invalid contract ID. Must start with C and be at least 50 characters.' });
  }

  const validationError = validateRwaBody(metadata);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const data = loadData();
  data[contractId] = {
    id: metadata.id || contractId,
    title: metadata.title,
    location: metadata.location,
    description: metadata.description,
    assetType: metadata.assetType,
    imageUrl: metadata.imageUrl || '',
    totalValuation: metadata.totalValuation || '',
    documents: Array.isArray(metadata.documents) ? metadata.documents : [],
    createdAt: metadata.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveData(data);

  res.status(201).json({ contractId, ...data[contractId] });
});

app.delete('/api/rwa/:contractId', adminAuth, writeLimiter, (req, res) => {
  const { contractId } = req.params;
  const data = loadData();

  if (!data[contractId]) {
    return res.status(404).json({ error: 'Asset metadata not found' });
  }

  delete data[contractId];
  saveData(data);

  res.json({ message: 'Asset metadata deleted', contractId });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export { app, validateContractId, validateRwaBody };

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`RWA Off-chain Metadata Backend running at http://localhost:${PORT}`);
  });
}
