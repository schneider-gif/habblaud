// Segredos NO CÓDIGO (arquivos que vão no pacote) e leitura do .env para "importar variáveis".
// Nunca devolve o valor do segredo: só arquivo, linha e o tipo.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ENV_KEY_RE, envKeyReserved, type EnvImport, type SegredoEncontrado } from '../../shared/publish';

const MAX_TEXT = 512 * 1024;
const MAX_FINDINGS = 50;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|svgz|mp[34]|m4a|wav|ogg|webm|mov|avi|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|woff2?|ttf|otf|eot|wasm|so|dll|exe|bin|sqlite3?|db|pyc|class|o|a)$/i;
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Cargo.lock']);
const CONFIG_EXT = /\.(json|ya?ml|toml|ini|cfg|conf|properties|xml|env\w*)$/i;
const CODE_EXT = /\.([cm]?[jt]sx?|py|php|rb|go|java|kt|cs|rs|sh)$/i;

interface Pattern {
  tipo: string;
  rotulo: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { tipo: 'stripe_live', rotulo: 'Chave secreta do Stripe (produção)', re: /\b[sr]k_live_[0-9a-zA-Z]{10,}/ },
  { tipo: 'stripe_test', rotulo: 'Chave secreta do Stripe (teste)', re: /\b[sr]k_test_[0-9a-zA-Z]{10,}/ },
  { tipo: 'aws', rotulo: 'Chave de acesso da AWS', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { tipo: 'github', rotulo: 'Token do GitHub', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { tipo: 'slack', rotulo: 'Token do Slack', re: /\bxox[bpoas]-[A-Za-z0-9-]{10,}/ },
  { tipo: 'private_key', rotulo: 'Chave privada', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { tipo: 'google', rotulo: 'Chave de API do Google', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { tipo: 'openai', rotulo: 'Chave da OpenAI', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { tipo: 'anthropic', rotulo: 'Chave da Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
];

/** `password = "..."`, `"senha": "..."`, `api_key: ...` com valor literal (não variável de ambiente nem marcador). */
const PASSWORD_RE = /\b(password|passwd|pwd|senha|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)['"]?\s*[:=]\s*(['"]?)([^\s'",;}#]{6,})\2/i;
const PLACEHOLDER_RE = /^(?:<.*>|\$\{?.*|%\(.*|\{\{.*|x{3,}|\*{3,}|changeme|change_me|your[_-].*|example.*|placeholder|password|senha|secret|null|none|true|false|undefined|process\.env.*|os\.environ.*|os\.getenv.*|env\(.*|getenv.*|config\..*|settings\..*)$/i;

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Procura segredos numa linha (sem guardar o valor). */
export function scanLine(line: string, file: string): Pattern | undefined {
  for (const p of PATTERNS) {
    // A chave da Anthropic também casa com o padrão da OpenAI: o mais específico primeiro.
    if (p.tipo === 'openai' && /\bsk-ant-/.test(line)) continue;
    if (p.re.test(line)) return p;
  }
  const isConfig = CONFIG_EXT.test(file) || /(^|\/)(config|settings)[^/]*$/i.test(file);
  const isCode = CODE_EXT.test(file);
  if (isConfig || isCode) {
    const m = PASSWORD_RE.exec(line);
    if (m) {
      const quoted = !!m[2];
      const value = m[3];
      // No código só conta valor entre aspas (senão é variável); em config, qualquer literal.
      if ((isConfig || quoted) && !PLACEHOLDER_RE.test(value) && !/[()[\]]/.test(value)) return { tipo: 'password', rotulo: 'Senha ou chave escrita no código', re: PASSWORD_RE };
    }
  }
  return undefined;
}

/** Varre os arquivos de texto pequenos do pacote atrás de segredos. */
export async function scanSecrets(dir: string, files: readonly string[]): Promise<SegredoEncontrado[]> {
  const out: SegredoEncontrado[] = [];
  for (const rel of files) {
    if (out.length >= MAX_FINDINGS) break;
    const base = rel.split('/').pop() ?? rel;
    if (BINARY_EXT.test(base) || LOCKFILES.has(base) || /\.min\.(js|css)$/.test(base) || /\.map$/.test(base)) continue;
    const full = join(dir, ...rel.split('/'));
    let buf: Buffer;
    try {
      const st = await stat(full);
      if (!st.isFile() || st.size > MAX_TEXT) continue;
      buf = await readFile(full);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < MAX_FINDINGS; i++) {
      const line = lines[i];
      if (line.length > 4000) continue;
      const p = scanLine(line, rel);
      if (p) out.push({ arquivo: rel, linha: i + 1, tipo: p.tipo, rotulo: p.rotulo });
    }
  }
  return out;
}

/** Interpreta um arquivo .env (KEY=valor, `export`, aspas, comentários). */
export function parseDotenv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = src.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let v = m[2];
    if (v.startsWith('"') || v.startsWith("'") || v.startsWith('`')) {
      const q = v[0];
      let rest = v.slice(1);
      // Valor entre aspas pode continuar nas próximas linhas.
      while (!rest.includes(q) && i + 1 < lines.length) rest += `\n${lines[++i]}`;
      const end = rest.indexOf(q);
      v = end >= 0 ? rest.slice(0, end) : rest;
      if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    out[key] = v;
  }
  return out;
}

/** Lê .env e .env.production (este vence) para o passo "variáveis". */
export async function readEnvFiles(dir: string): Promise<EnvImport> {
  const vars: Record<string, string> = {};
  const arquivos: string[] = [];
  const ignoradas = new Set<string>();
  for (const name of ['.env', '.env.production']) {
    let src: string;
    try {
      const st = await stat(join(dir, name));
      if (!st.isFile() || st.size > MAX_TEXT) continue;
      src = await readFile(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    arquivos.push(name);
    for (const [k, v] of Object.entries(parseDotenv(src))) {
      if (!ENV_KEY_RE.test(k) || envKeyReserved(k)) ignoradas.add(k);
      else vars[k] = v;
    }
  }
  return { vars, arquivos, ignoradas: [...ignoradas] };
}
