const fs = require('fs');
const path = require('path');

function parseEnvValue(raw) {
  const value = raw.trim();
  if (!value) return '';

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    if (quote === '"') {
      return inner
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    return inner;
  }

  return value;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = normalized.slice(0, eqIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    process.env[key] = parseEnvValue(normalized.slice(eqIndex + 1));
  }
}

module.exports = function loadEnv() {
  const repoRoot = path.join(__dirname, '..');
  const cwdEnv = path.join(process.cwd(), '.env');
  const repoEnv = path.join(repoRoot, '.env');

  loadEnvFile(cwdEnv);
  if (repoEnv !== cwdEnv) {
    loadEnvFile(repoEnv);
  }
};
