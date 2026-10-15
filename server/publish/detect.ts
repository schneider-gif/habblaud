// Detecção do tipo de projeto (static/vite/next/node/python/dockerfile) a partir dos arquivos da pasta, com os
// comandos sugeridos (editáveis no wizard). Só lê arquivos pequenos da raiz e de poucos lugares conhecidos.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deteccao, SiteConfig, Tipo } from '../../shared/publish';

const MAX_READ = 256 * 1024;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readSmall(p: string): Promise<string | undefined> {
  try {
    const s = await stat(p);
    if (!s.isFile() || s.size > MAX_READ) return undefined;
    return await readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

interface Pkg {
  main?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

export interface PackageManager {
  name: 'npm' | 'pnpm' | 'yarn';
  install: string;
  run: (script: string) => string;
}

/** Gerenciador de pacotes pelo lockfile. */
export async function packageManager(dir: string): Promise<PackageManager> {
  if (await exists(join(dir, 'pnpm-lock.yaml'))) return { name: 'pnpm', install: 'pnpm install --frozen-lockfile', run: (s) => (s === 'start' ? 'pnpm start' : `pnpm run ${s}`) };
  if (await exists(join(dir, 'yarn.lock'))) return { name: 'yarn', install: 'yarn install --frozen-lockfile', run: (s) => (s === 'start' ? 'yarn start' : `yarn ${s}`) };
  if (await exists(join(dir, 'package-lock.json'))) return { name: 'npm', install: 'npm ci', run: (s) => (s === 'start' ? 'npm start' : `npm run ${s}`) };
  return { name: 'npm', install: 'npm install', run: (s) => (s === 'start' ? 'npm start' : `npm run ${s}`) };
}

/** Porta que um arquivo de servidor Node escuta (process.env.PORT || N, listen(N), PORT = N). */
export function findNodePort(src: string): { porta?: number; usaEnv: boolean } {
  const usaEnv = /process\.env\.PORT\b|process\.env\[['"]PORT['"]\]/.test(src);
  const pats = [
    /process\.env\.PORT\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/,
    /process\.env\[['"]PORT['"]\]\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/,
    /\bPORT\s*=\s*['"]?(\d{2,5})\b/,
    /\.listen\(\s*['"]?(\d{2,5})\b/,
    /\bport\s*:\s*(\d{2,5})\b/,
  ];
  for (const re of pats) {
    const m = re.exec(src);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n < 65536) return { porta: n, usaEnv };
    }
  }
  return { usaEnv };
}

/** Arquivo de entrada do app Node (main, `node X` no start, ou nomes comuns). */
async function nodeEntry(dir: string, pkg: Pkg): Promise<string | undefined> {
  const cands: string[] = [];
  const start = typeof pkg.scripts?.start === 'string' ? pkg.scripts.start : '';
  const m = /\b(?:node|nodemon|tsx|ts-node|bun)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:[cm]?[jt]s))/.exec(start);
  if (m) cands.push(m[1]);
  if (typeof pkg.main === 'string') cands.push(pkg.main);
  cands.push('server.js', 'index.js', 'app.js', 'main.js', 'server.mjs', 'index.mjs', 'src/server.js', 'src/index.js', 'src/app.js', 'server/index.js', 'src/server.ts', 'src/index.ts', 'server.ts', 'index.ts');
  for (const c of cands) {
    const p = join(dir, c.replace(/^\.\//, ''));
    if (await exists(p)) return c.replace(/^\.\//, '');
  }
  return undefined;
}

const PY_FILES = ['main.py', 'app.py', 'server.py', 'wsgi.py', 'asgi.py', 'app/main.py', 'app/__init__.py', 'src/main.py', 'src/app.py', 'api/main.py'];

function pyModule(file: string): string {
  return file
    .replace(/\.py$/, '')
    .replace(/\/__init__$/, '')
    .replace(/\//g, '.');
}

async function detectPython(dir: string, avisos: string[]): Promise<{ config: SiteConfig; motivo: string }> {
  const req = await readSmall(join(dir, 'requirements.txt'));
  const pyproject = await readSmall(join(dir, 'pyproject.toml'));
  const deps = `${req ?? ''}\n${pyproject ?? ''}`.toLowerCase();
  const has = (name: string) => new RegExp(`(^|[\\s"'\\[,])${name}([\\s<>=~!;\\[,"']|$)`, 'm').test(deps);
  const base = req !== undefined ? 'pip install -r requirements.txt' : 'pip install .';
  const extra: string[] = [];
  let start = '';
  let motivo = req !== undefined ? 'Encontramos requirements.txt (Python).' : 'Encontramos pyproject.toml (Python).';

  if (has('django') || (await exists(join(dir, 'manage.py')))) {
    let proj: string | undefined;
    const manage = await readSmall(join(dir, 'manage.py'));
    const m = manage && /DJANGO_SETTINGS_MODULE['"]\s*,\s*['"]([\w.]+)\.settings['"]/.exec(manage);
    if (m) proj = m[1];
    if (!has('gunicorn')) extra.push('gunicorn');
    start = `gunicorn -b 0.0.0.0:$PORT ${proj ?? 'projeto'}.wsgi`;
    motivo = 'Projeto Django (manage.py): vamos rodar com o gunicorn.';
    if (!proj) avisos.push('Não achamos o nome do projeto Django: troque "projeto" no comando de início pelo nome da pasta que tem o settings.py.');
  } else if (has('fastapi')) {
    const found = await findPyApp(dir, /(\w+)\s*=\s*FastAPI\s*\(/);
    if (!has('uvicorn')) extra.push('uvicorn');
    start = `uvicorn ${found?.mod ?? 'main'}:${found?.name ?? 'app'} --host 0.0.0.0 --port $PORT`;
    motivo = 'Projeto FastAPI: vamos rodar com o uvicorn.';
    if (!found) avisos.push('Não achamos onde o app FastAPI é criado: confira o comando de início (arquivo:variável).');
  } else if (has('flask')) {
    const found = await findPyApp(dir, /(\w+)\s*=\s*Flask\s*\(/);
    if (!has('gunicorn')) extra.push('gunicorn');
    start = `gunicorn -b 0.0.0.0:$PORT ${found?.mod ?? 'app'}:${found?.name ?? 'app'}`;
    motivo = 'Projeto Flask: vamos rodar com o gunicorn.';
    if (!found) avisos.push('Não achamos onde o app Flask é criado: confira o comando de início (arquivo:variável).');
  } else {
    const entry = await firstExisting(dir, ['main.py', 'app.py', 'server.py']);
    start = entry ? `python ${entry}` : 'python main.py';
    avisos.push('Seu app Python precisa escutar na porta da variável PORT (0.0.0.0). Confira o comando de início.');
  }
  const install = extra.length ? `${base} && pip install ${extra.join(' ')}` : base;
  return { config: { install, start, porta: 8000 }, motivo };
}

async function firstExisting(dir: string, names: string[]): Promise<string | undefined> {
  for (const n of names) if (await exists(join(dir, n))) return n;
  return undefined;
}

async function findPyApp(dir: string, re: RegExp): Promise<{ mod: string; name: string } | undefined> {
  for (const f of PY_FILES) {
    const src = await readSmall(join(dir, f));
    const m = src && re.exec(src);
    if (m) return { mod: pyModule(f), name: m[1] };
  }
  return undefined;
}

/** EXPOSE do Dockerfile (primeira porta). */
export function dockerExpose(src: string): number | undefined {
  const m = /^\s*EXPOSE\s+(\d{2,5})/im.exec(src);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 && n < 65536 ? n : undefined;
}

async function viteOutDir(dir: string): Promise<string> {
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
    const src = await readSmall(join(dir, f));
    const m = src && /outDir\s*:\s*['"]([^'"]+)['"]/.exec(src);
    if (m) return m[1].replace(/^\.\//, '');
  }
  return 'dist';
}

/** Detecta o tipo e sugere a configuração. */
export async function detectProject(dir: string): Promise<Deteccao> {
  const avisos: string[] = [];
  const pkgSrc = await readSmall(join(dir, 'package.json'));
  let pkg: Pkg | undefined;
  if (pkgSrc !== undefined) {
    try {
      pkg = JSON.parse(pkgSrc) as Pkg;
    } catch {
      avisos.push('O package.json está com erro de formatação (JSON inválido).');
    }
  }
  const dockerSrc = await readSmall(join(dir, 'Dockerfile'));
  const hasPython = (await exists(join(dir, 'requirements.txt'))) || (await exists(join(dir, 'pyproject.toml')));
  const done = (tipo: Tipo, config: SiteConfig, motivo: string): Deteccao => {
    if (dockerSrc !== undefined && tipo !== 'dockerfile') avisos.push('Também há um Dockerfile: se preferir usá-lo, escolha o tipo "Dockerfile".');
    return { tipo, config, motivo, avisos };
  };

  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const scripts = pkg.scripts ?? {};
    const pm = await packageManager(dir);
    const hasScript = (s: string) => typeof scripts[s] === 'string';
    if ('next' in deps) {
      if (!hasScript('build')) avisos.push('O package.json não tem o script "build" (o Next precisa de "next build").');
      return done('next', { install: pm.install, build: pm.run('build'), start: hasScript('start') ? pm.run('start') : 'npx next start -p $PORT', porta: 3000 }, 'Encontramos o Next.js no package.json.');
    }
    if ('vite' in deps) {
      const saida = await viteOutDir(dir);
      return done('vite', { install: pm.install, build: hasScript('build') ? pm.run('build') : 'npx vite build', porta: 8080, saida, spa: true }, `Encontramos o Vite no package.json: o site é gerado na pasta "${saida}".`);
    }
    if ('react-scripts' in deps) {
      return done('vite', { install: pm.install, build: pm.run('build'), porta: 8080, saida: 'build', spa: true }, 'Projeto Create React App: o site é gerado na pasta "build".');
    }
    if (hasScript('start') || typeof pkg.main === 'string' || (await nodeEntry(dir, pkg))) {
      const entry = await nodeEntry(dir, pkg);
      let porta = 3000;
      let motivo = 'App Node.js (package.json).';
      if (entry) {
        const src = (await readSmall(join(dir, entry))) ?? '';
        const found = findNodePort(src);
        if (found.porta) {
          porta = found.porta;
          motivo = `App Node.js: ${entry} escuta na porta ${porta}.`;
        }
        if (src && !found.usaEnv) avisos.push(`Dica: faça o app escutar em process.env.PORT (hoje ${entry} não lê a variável PORT).`);
      }
      const start = hasScript('start') ? pm.run('start') : `node ${entry ?? (typeof pkg.main === 'string' ? pkg.main : 'index.js')}`;
      return done('node', { install: pm.install, build: hasScript('build') ? pm.run('build') : undefined, start, porta }, motivo);
    }
    if (hasScript('build') && (await exists(join(dir, 'index.html')))) {
      return done('vite', { install: pm.install, build: pm.run('build'), porta: 8080, saida: 'dist', spa: true }, 'Site com etapa de build (package.json + index.html). Confira a pasta de saída.');
    }
  }
  if (hasPython) {
    const py = await detectPython(dir, avisos);
    return done('python', py.config, py.motivo);
  }
  if (dockerSrc !== undefined) {
    const porta = dockerExpose(dockerSrc);
    if (!porta) avisos.push('O Dockerfile não tem EXPOSE: confira a porta que o app escuta.');
    return { tipo: 'dockerfile', config: { porta: porta ?? 3000 }, motivo: porta ? `Encontramos um Dockerfile (porta ${porta} do EXPOSE).` : 'Encontramos um Dockerfile.', avisos };
  }
  for (const saida of ['.', 'public', 'dist', 'build', 'site', 'docs']) {
    if (await exists(join(dir, saida, 'index.html'))) {
      return done('static', { porta: 8080, saida, spa: false }, saida === '.' ? 'Site estático: encontramos o index.html.' : `Site estático: encontramos o index.html na pasta "${saida}".`);
    }
  }
  avisos.push('Não reconhecemos o tipo do projeto. Escolha o tipo e confira os comandos.');
  return { tipo: 'static', config: { porta: 8080, saida: '.', spa: false }, motivo: 'Não achamos index.html, package.json, requirements.txt nem Dockerfile.', avisos };
}
