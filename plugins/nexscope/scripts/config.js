import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR, CONFIG_PATH, ensureDataDir, writeJsonAtomic, readJsonOrNull,
} from './state.js';
import { userErr } from './log.js';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(__filename), '..');
const EXAMPLE_PATH = path.join(PLUGIN_ROOT, 'config.example.json');

const PLACEHOLDER = 'REPLACE_ME';

const DEFAULTS = {
  mode: 'manual',
  hopLimit: 3,
  peerIndexMap: {},
};

const ENV_MAP = {
  relayUrl:    'NEXSCOPE_RELAY_URL',
  token:       'NEXSCOPE_TOKEN',
  defaultName: 'NEXSCOPE_DEFAULT_NAME',
  mode:        'NEXSCOPE_MODE',
  hopLimit:    'NEXSCOPE_HOP_LIMIT',
};

export class ConfigError extends Error {
  constructor(message, { code = 'config_error' } = {}) {
    super(message);
    this.code = code;
  }
}

function initConfigFile() {
  ensureDataDir();
  if (!fs.existsSync(EXAMPLE_PATH)) {
    throw new ConfigError(`missing template: ${EXAMPLE_PATH}`, { code: 'missing_example' });
  }
  const tpl = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, tpl, { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}

// Load raw JSON; if missing, init from example and throw ConfigError so caller exits with help.
function loadRawConfig() {
  const existing = readJsonOrNull(CONFIG_PATH);
  if (existing) return existing;
  initConfigFile();
  throw new ConfigError(
    `Initialized ${CONFIG_PATH}\nFill in relayUrl, token, and defaultName (replace the ${PLACEHOLDER} placeholders), then rerun.`,
    { code: 'config_initialized' },
  );
}

function applyEnvOverrides(cfg) {
  for (const [k, env] of Object.entries(ENV_MAP)) {
    const v = process.env[env];
    if (v != null && v !== '') {
      cfg[k] = k === 'hopLimit' ? parseInt(v, 10) : v;
    }
  }
  return cfg;
}

function validate(cfg) {
  const missing = [];
  for (const k of ['relayUrl', 'token']) {
    if (!cfg[k] || cfg[k] === PLACEHOLDER || String(cfg[k]).includes(PLACEHOLDER)) {
      missing.push(k);
    }
  }
  if (missing.length) {
    throw new ConfigError(
      `Missing config (or unreplaced placeholders): ${missing.join(', ')}\nEdit ${CONFIG_PATH} or override via env (NEXSCOPE_RELAY_URL / NEXSCOPE_TOKEN / etc.).`,
      { code: 'config_missing' },
    );
  }
  if (!/^wss?:\/\//.test(cfg.relayUrl)) {
    throw new ConfigError(`relayUrl must start with ws:// or wss://, got "${cfg.relayUrl}"`, { code: 'bad_relay_url' });
  }
  if (cfg.mode && !['manual', 'auto'].includes(cfg.mode)) {
    throw new ConfigError(`mode must be manual or auto, got "${cfg.mode}"`, { code: 'bad_mode' });
  }
  if (cfg.hopLimit != null && (!Number.isInteger(cfg.hopLimit) || cfg.hopLimit < 1)) {
    throw new ConfigError(`hopLimit must be a positive integer, got "${cfg.hopLimit}"`, { code: 'bad_hop_limit' });
  }
}

export function loadConfig() {
  ensureDataDir();
  const raw = loadRawConfig();
  const cfg = { ...DEFAULTS, ...raw };
  applyEnvOverrides(cfg);
  validate(cfg);
  // Normalize
  cfg.hopLimit = cfg.hopLimit ?? DEFAULTS.hopLimit;
  cfg.mode = cfg.mode ?? DEFAULTS.mode;
  cfg.peerIndexMap = cfg.peerIndexMap && typeof cfg.peerIndexMap === 'object' ? cfg.peerIndexMap : {};
  return cfg;
}

// Lenient variant used by hooks: never throws; returns null if not usable.
// Hooks should be silent when plugin isn't configured.
export function loadConfigOrNull() {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

export function persistConfigField(key, value) {
  const raw = readJsonOrNull(CONFIG_PATH) ?? {};
  raw[key] = value;
  writeJsonAtomic(CONFIG_PATH, raw, 0o600);
}

export function pluginRoot() {
  return PLUGIN_ROOT;
}

// CLI self-check: `node scripts/config.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const cfg = loadConfig();
    const safe = { ...cfg, token: cfg.token ? '***' : null };
    process.stdout.write(JSON.stringify(safe, null, 2) + '\n');
  } catch (e) {
    userErr(e.message);
    process.exit(1);
  }
}
