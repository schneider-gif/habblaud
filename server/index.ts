// Servidor do Habblaud: observa as sessões abertas do Claude Code (todas as contas),
// mantém o modelo do escritório e transmite via SSE. Sem dependências de runtime.
//   npm run dev    -> tsx server/index.ts --dev (Vite em middleware mode, HMR no mesmo servidor)
//   npm start      -> node dist/server/index.js (serve dist/client)
import http from 'node:http';
import { basename, join, resolve } from 'node:path';
import { AccountsService } from './accounts/service';
import { loadConfig, shellOffReason, terminalOffReason } from './config';
import { createApiHandler, readJson, sendJson } from './http/app';
import { createRequestGuard } from './http/guard';
import { Hub } from './http/sse';
import { createStaticHandler } from './http/static';
import { TerminalStreams } from './http/terminal';
import { createTimelineHandler } from './http/timeline';
import { TIMELINE_DIR, TimelineRecorder } from './history/timeline';
import { DayStatsService } from './history/daystats';
import { describeStateMigration, legacyEnvWarning, migrateLegacyStateDir } from './legacy';
import { errMsg, log } from './log';
import { NameStore } from './model/names';
import { Office } from './model/office';
import { openMainAgent, SessionHistory } from './sources/history';
import { createPermissionRoutes } from './permissions/http';
import { PermissionRegistry } from './permissions/registry';
import { DialogWatcher } from './questions/dialogs';
import { QuestionService } from './questions/service';
import { ClaudeWatcher } from './sources/watcher';
import { createBuildReader } from './build';
import { UpdateChecker } from './updates/checker';
import { AnnouncementPoller } from './announce/poller';
import { createAgentInput } from './input/tmux';
import { StateStore } from './model/state';
import { expandHome } from './accounts/detect';
import { PROJECTS_DIRNAME } from './missions/catalog';
import { MissionsEngine } from './missions/engine';
import { MissionsStore } from './missions/store';
import { claudeAuth } from './missions/auth';
import { createShellRoutes } from './shell/http';
import { ShellService } from './shell/service';
import { SetupWatcher } from './shell/setup';
import { CodexWatcher } from './codex/watcher';
import { codexAccountName, codexAccounts, codexAuth, discoverCodexDirs, isCodexAccount } from './codex/detect';
import { withCodexPermissions } from './codex/approvals';
import { GithubService } from './github/service';
import { createGithubRoutes, githubOffReason } from './github/http';
import { userInfo } from 'node:os';
import { readFile } from 'node:fs/promises';

const config = loadConfig();
const startedAt = Date.now();

// Nome antigo (CodeTown, até a 0.3.2): leva ~/.codetown para ~/.habblaud antes de ler qualquer estado e avisa
// das variáveis CODETOWN_* que não valem mais. No Docker, quem migra é o docker:up.
if (!config.inDocker) {
  const r = migrateLegacyStateDir(config.home);
  const msg = describeStateMigration(r);
  if (msg) (r.error ? log.warn : log.info)(msg);
}
const legacyEnv = legacyEnvWarning(Object.keys(process.env));
if (legacyEnv) log.warn(legacyEnv);

const names = new NameStore(join(config.dataDir, 'names.json'));
names.load();
const state = new StateStore(join(config.dataDir, 'state.json'));
state.load();

// Office, contas e watcher se referenciam (avisos de mudança / fontes): ligação tardia.
const late: { office?: Office; watcher?: ClaudeWatcher; permissions?: PermissionRegistry; codex?: CodexWatcher; questions?: QuestionService; dialogs?: DialogWatcher } = {};
// Terminal embutido (shell de verdade; server/shell): permitido pela config e com tmux + script(1) na máquina.
// O serviço existe com a trava do terminal no Linux (também acha os agentes em configuração); o shell em si só com config.shell.
const shellService = config.terminal && process.platform === 'linux' ? new ShellService({ home: config.home, shell: safeShell() }) : undefined;
const shellState: { reason?: string } = { reason: config.shell ? 'conferindo o tmux e o script…' : shellOffReason(process.env, config.host, config.inDocker) ?? 'indisponível' };
function safeShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}
// Versão nova: consulta a release mais recente no GitHub a cada 6 h (HABBLAUD_UPDATE_CHECK=0 desliga).
const updates = new UpdateChecker({
  current: config.version,
  repo: config.repo,
  enabled: config.updateCheck,
  file: join(config.dataDir, 'updates.json'),
  onChange: () => late.office?.markDirty(),
});
updates.load();
// Aviso global da plataforma (ex.: Habblaude): JSON central lido a cada 10 min. Sem HABBLAUD_ANNOUNCE_URL = desligado.
const announce = new AnnouncementPoller(process.env.HABBLAUD_ANNOUNCE_URL?.trim() || undefined, () => late.office?.markDirty());
const accounts = new AccountsService({
  dirs: config.claudeDirs,
  home: config.home,
  env: process.env,
  usageDir: config.usageDir,
  onChange: () => late.office?.markDirty(),
});
// Codex CLI (OpenAI): pastas ~/.codex (e CODEX_HOME, ~/.codex-*). A pasta nasce na primeira execução do codex, que
// pode ser depois de o Habblaud subir: redescobre a cada 15 s. HABBLAUD_CODEX=0 desliga a fonte.
let codexDirs = discoverCodexDirs(process.env, config.home);
const codexOff = process.env.HABBLAUD_CODEX?.trim() && /^(0|false|off|no|nao|não)$/i.test(process.env.HABBLAUD_CODEX.trim());
/** Onde procurar o login da OpenAI mesmo antes de a pasta existir (Missão 0, agentes em configuração). */
const codexAuthDirs = () => (codexDirs.length ? codexDirs : [resolve(process.env.CODEX_HOME?.trim() || join(config.home, '.codex'))]);
const codexRediscover = setInterval(() => {
  const next = discoverCodexDirs(process.env, config.home);
  if (next.join('|') !== codexDirs.join('|')) {
    codexDirs = next;
    late.office?.markDirty();
  }
}, 15_000);
codexRediscover.unref?.();
const office = new Office({
  names,
  version: config.version,
  // No modo dev o Vite serve o cliente direto do código-fonte: não há build para comparar.
  build: config.dev ? undefined : createBuildReader(config.rootDir),
  startedAt,
  accounts: (sessions) => [...accounts.list(sessions), ...codexAccounts(codexDirs, sessions)],
  sources: () => [...(late.watcher?.sources() ?? []), ...(late.codex?.sources() ?? [])],
  accountName: (id) => (isCodexAccount(id) ? codexAccountName(id) : accounts.find(id)?.detected.name),
  terminal: config.terminal,
  demoLocked: config.demoLocked,
  permissions: () => {
    const m = new Map(late.permissions?.snapshot() ?? new Map());
    // No snapshot vai sem `input` (como os pedidos do Claude): o comando completo sai por GET /api/permissions/:id.
    for (const a of late.codex?.approvals() ?? []) if (!m.has(a.agentId)) m.set(a.agentId, { ...a.info, input: undefined });
    return m;
  },
  questions: () => late.questions?.get() ?? new Map(),
  dialogs: () => late.dialogs?.get() ?? new Map(),
  updates: () => updates.status(),
  announcement: () => announce.get(),
  shell: () => shellState.reason === undefined && !late.office?.isDemo(),
  github: () => githubOffReason(process.env, shellState.reason) === undefined && !late.office?.isDemo(),
  links: config.links,
});
// Ponte (ex.: Mac -> esta VM): config dirs espelhados, vivos pelo batimento e sem receber mensagens.
const remoteDirs = new Set((process.env.HABBLAUD_REMOTE_DIRS ?? '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => resolve(expandHome(p, config.home))));
const watcher = new ClaudeWatcher({ accounts, office, inDocker: config.inDocker, remoteDirs });
late.office = office;
late.watcher = watcher;
const hub = new Hub(office);
// "Meu dia": amostra o escritório a cada segundo e persiste em <dataDir>/stats/ (ver history/daystats.ts).
const stats = new DayStatsService({ dir: join(config.dataDir, 'stats'), snapshot: () => hub.current() });
stats.load();
// Terminal somente leitura: só existe com bind local (ver terminalOffReason em config.ts).
const terminals = config.terminal
  ? new TerminalStreams({ office, transcriptPathOf: (id) => watcher.transcriptPathOf(id) ?? late.codex?.transcriptPathOf(id) })
  : undefined;
// Histórico do terminal (sessões recentes, abertas ou encerradas): mesma trava. Inclui as conversas do Codex.
const history = config.terminal
  ? new SessionHistory({
      accounts: () => [...accounts.entries(), ...codexDirs.map((d) => ({ id: basename(d), dir: d }))],
      openAgentOf: (acc, sid) => openMainAgent(office.list(), acc, sid),
    })
  : undefined;
// Linha do tempo do timelapse: grava cada snapshot novo (com throttle) em <dataDir>/timeline.
const timelineDir = join(config.dataDir, TIMELINE_DIR);
const timeline = config.timeline ? new TimelineRecorder({ dir: timelineDir }) : undefined;
if (timeline) hub.onSnapshot((snap) => timeline.ingest(snap));
// Responder pelo escritório (hook PermissionRequest): age sobre as sessões, então segue a mesma trava.
const permissions = config.terminal
  ? new PermissionRegistry({
      office,
      viewers: () => hub.localSize,
      transcriptPathOf: (id) => watcher.transcriptPathOf(id),
      demoDecide: (id, d) => office.decideDemoPermission(id, d),
      demoDetail: (id) => office.demoPermission(id),
    })
  : undefined;
late.permissions = permissions;
// Quadro de missões: estado em <dataDir>/missions.json; projetos em ~/projetos. Começar uma missão abre agentes,
// então segue a mesma trava (bind local); a conferência de arquivos/git roda a cada 30 s só com missão ativa.
const missionsStore = config.terminal ? new MissionsStore(join(config.dataDir, 'missions.json')) : undefined;
missionsStore?.load();
const missions = missionsStore
  ? new MissionsEngine({
      store: missionsStore,
      projectsDir: join(config.home, PROJECTS_DIRNAME),
      home: config.home,
      configDirs: () => accounts.entries().map((a) => a.dir),
      codexDirs: codexAuthDirs,
    })
  : undefined;
if (missions) hub.onSnapshot((snap) => missions.ingest(snap));
// Mandar mensagens e abrir agentes (tmux): só no Linux, que tem /proc.
const input = process.platform === 'linux' ? createAgentInput({ remoteAccounts: new Set([...remoteDirs].map((d) => basename(d))) }) : undefined;
// Perguntas com opções (AskUserQuestion): lidas do transcript e respondidas pelo chat dirigindo o diálogo no tmux.
const questions = config.terminal
  ? new QuestionService({ office, transcriptPathOf: (id) => watcher.transcriptPathOf(id), input: input && { screen: (id) => input.screen(id), driveKeys: (id, k) => input.driveKeys(id, k), typeText: (id, t) => input.typeText(id, t) } })
  : undefined;
late.questions = questions;
// Telas de seleção que o Habblaud não conhece (ex.: "Teach auto mode"): trecho do terminal com ↑ ↓ Enter Esc no escritório.
const dialogs =
  config.terminal && input
    ? new DialogWatcher({
        office,
        input: { screen: (id) => input.screen(id), navKeys: (id, k) => input.navKeys(id, k) },
        covered: (id) => !!questions?.pendingOf(id) || !!late.permissions?.snapshot().has(id) || !!late.codex?.approvals().some((a) => a.agentId === id),
      })
    : undefined;
late.dialogs = dialogs;
// Fonte "codex": conversas abertas do Codex CLI; a tela do tmux diz quando ele pede aprovação ou login.
const codexWatcher = codexOff
  ? undefined
  : new CodexWatcher({
      dirs: () => codexDirs,
      office,
      screen: input && config.terminal ? (pid) => input.screen(`.codex:${pid}`) : undefined,
    });
late.codex = codexWatcher;
/** Sessões tmux agente-* abertas pelo escritório para o Codex (agente-codex-*) ou para o Claude (o resto). */
const isCodexSession = (s: { session: string }) => s.session.startsWith('agente-codex-');
// Agentes abertos pelo escritório parados na primeira execução do Claude (tema/login): bonecos provisórios.
const setupWatcher = shellService
  ? new SetupWatcher({
      list: async () => (await shellService.agentSessions()).filter((s) => !isCodexSession(s)),
      connected: async () => (await claudeAuth({ home: config.home, configDirs: accounts.entries().map((a) => a.dir), env: process.env })).connected,
      ready: async () => {
        try {
          const j = JSON.parse(await readFile(join(config.home, '.claude.json'), 'utf8')) as { hasCompletedOnboarding?: unknown };
          return j.hasCompletedOnboarding === true;
        } catch {
          return false;
        }
      },
      hasAgentPid: (pid) => office.list().some((a) => a.kind === 'main' && a.status !== 'offline' && a.id.endsWith(`:${pid}`)),
      apply: (list) => office.setSetupAgents(list),
      account: '.claude',
      // Login feito num agente: os outros parados no onboarding são reabertos na mesma pasta (mesmo nome/boneco).
      restart: input
        ? async (s) => {
            const r = await input.spawn(s.cwd);
            if (r.pid) office.movePendingProfile(`.claude:${s.pid}`, `.claude:${r.pid}`);
            await shellService.killAgentSession(s.session);
            log.info(`Agente reaberto depois do login: ${s.session} -> ${r.session} (${r.cwd}).`);
          }
        : undefined,
    })
  : undefined;
// O mesmo para o Codex: "+ Novo agente" com Codex sem login aparece na hora como "conectar sua conta OpenAI" e, depois
// do login num deles, os outros parados no login são reabertos.
const codexSetupWatcher =
  shellService && codexWatcher
    ? new SetupWatcher({
        list: async () => (await shellService.agentSessions()).filter(isCodexSession),
        connected: async () => (await codexAuth(codexAuthDirs())).connected,
        hasAgentPid: (pid) => office.list().some((a) => a.kind === 'main' && a.status !== 'offline' && a.id.endsWith(`:${pid}`)),
        apply: (list) => office.setSetupAgents(list, 'codex'),
        account: '.codex',
        engine: 'codex',
        restart: input
          ? async (s) => {
              const r = await input.spawn(s.cwd, { engine: 'codex' });
              if (r.pid) office.movePendingProfile(`.codex:${s.pid}`, `.codex:${r.pid}`);
              await shellService.killAgentSession(s.session);
              log.info(`Agente do Codex reaberto depois do login: ${s.session} -> ${r.session} (${r.cwd}).`);
            }
          : undefined,
      })
    : undefined;
// Painel do GitHub: gh no shell do usuário (login no terminal embutido), mesma trava do terminal embutido.
const githubService = shellService ? new GithubService({ home: config.home, projectsDir: join(config.home, PROJECTS_DIRNAME) }) : undefined;
const githubRoutes = createGithubRoutes({
  service: githubService,
  offReason: () => githubOffReason(process.env, office.isDemo() ? 'modo demonstração ligado' : shellState.reason),
  allowedHosts: config.allowedHosts,
  sendJson,
  readJson,
  onChange: () => void missions?.evaluate(),
});
const shellRoutes = createShellRoutes({
  service: shellService,
  offReason: () => shellState.reason,
  isDemo: () => office.isDemo(),
  allowedHosts: config.allowedHosts,
  sendJson,
  readJson,
});

if (config.demo) office.setDemo(true);
watcher.start();
codexWatcher?.start();
accounts.start();
hub.start();
if (timeline) {
  timeline.start();
  timeline.ingest(hub.current());
}
permissions?.start();
questions?.start();
dialogs?.start();
missions?.startTimer();
// Missão 0 (conta do Claude): confere já no boot e, depois, a cada minuto (aviso "sua conta saiu" no quadro).
void missions?.evaluate();
missions?.watchAuth();
setupWatcher?.start();
codexSetupWatcher?.start();
if (config.shell && shellService)
  void shellService.probe().then((why) => {
    shellState.reason = why;
    office.markDirty();
    log.info(why ? `   Terminal embutido: desligado (${why}).` : '   Terminal embutido: ligado (abas = sessões tmux terminal-N).');
  });
stats.start();
updates.start();
announce.start();
const ticker = setInterval(() => {
  try {
    office.tick();
  } catch (err) {
    log.warnOnce(`tick:${errMsg(err)}`, `Falha no relógio do escritório: ${errMsg(err)}`);
  }
}, 250);

const api = createApiHandler({
  office,
  hub,
  accounts,
  sources: () => [...watcher.sources(), ...(codexWatcher?.sources() ?? [])],
  version: config.version,
  inDocker: config.inDocker,
  terminal: config.terminal,
  terminals,
  sessions: history,
  timeline: createTimelineHandler({ dir: timelineDir, recording: !!timeline }),
  // Pedidos do Codex (ids "codex-...") respondidos com teclas no tmux; o resto vai para o registro do hook do Claude.
  permissions:
    config.terminal && codexWatcher && input
      ? withCodexPermissions(
          { watcher: codexWatcher, sendKeys: (id, keys) => input.sendKeys(id, keys), sendText: (id, text) => input.send(id, text) },
          permissions ? createPermissionRoutes(permissions) : undefined,
        )
      : permissions
        ? createPermissionRoutes(permissions)
        : undefined,
  input: input && (setupWatcher || codexSetupWatcher) ? { ...input, spawn: async (...a: Parameters<typeof input.spawn>) => {
    const r = await input.spawn(...a);
    void setupWatcher?.scan();
    void codexSetupWatcher?.scan();
    return r;
  } } : input,
  questions,
  dialogs,
  missions,
  github: githubRoutes,
  shell: shellRoutes.api,
  shellAvailable: () => shellState.reason === undefined && !office.isDemo(),
  state,
  stats,
  updates,
});

const server = http.createServer();
let closeVite: (() => Promise<void>) | undefined;

function parseUrl(req: http.IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

/** Quem atende o que não é /api: o Vite (dev) ou os arquivos de dist/client (produção). */
let fallback: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;
if (config.dev) {
  // Import dinâmico: o bundle de produção nunca carrega o Vite.
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(config.rootDir, 'vite.config.ts'),
    server: { middlewareMode: true, ws: { server } },
    appType: 'spa',
  });
  closeVite = () => vite.close();
  fallback = (req, res) => vite.middlewares(req, res);
} else {
  const serveStatic = createStaticHandler(join(config.rootDir, 'dist', 'client'));
  fallback = (req, res, url) => serveStatic(req, res, url.pathname);
}

// Host/Origin/Content-Type: barra DNS rebinding e CSRF antes de qualquer rota (inclusive o Vite).
const guard = createRequestGuard({ allowedHosts: config.allowedHosts });

server.on('request', (req, res) => {
  const url = parseUrl(req);
  try {
    if (guard(req, res)) return;
    if (!api(req, res, url)) fallback(req, res, url);
  } catch (err) {
    log.warn(`Erro ao responder ${req.method} ${url.pathname}: ${errMsg(err)}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'erro interno' });
    else res.destroy();
  }
});

// WebSocket do terminal embutido (/api/shell/ws): Host, Origin e a trava conferidos em shell/http.ts. Outros upgrades
// são do Vite (HMR) no modo dev; em produção não há nenhum.
server.on('upgrade', (req, socket, head) => {
  try {
    if (shellRoutes.upgrade(req, socket, head)) return;
  } catch (err) {
    log.warn(`Erro no upgrade ${req.url}: ${errMsg(err)}`);
    socket.destroy();
    return;
  }
  if (!config.dev) socket.destroy();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') log.error(`A porta ${config.port} já está em uso (defina HABBLAUD_PORT para usar outra).`);
  else log.error(`Erro no servidor HTTP: ${errMsg(err)}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  log.info(`🏢 Habblaud ${config.version}${config.dev ? ' (dev)' : ''}${config.inDocker ? ' (docker)' : ''} em http://${host}:${config.port}`);
  const list = accounts.entries();
  if (!list.length) log.warn('Nenhuma pasta do Claude Code encontrada (defina HABBLAUD_CLAUDE_DIRS).');
  for (const a of list) {
    const src = watcher.sources().find((s) => s.label === a.id);
    const usage = accounts.usageView(a.id).status;
    log.info(`   Conta ${a.detected.short} (${a.id}): ${src?.sessions ?? 0} sessão(ões) aberta(s) · uso: ${usage} · ${a.dir}`);
  }
  if (codexOff) log.info('   Codex: desligado (HABBLAUD_CODEX).');
  else if (!codexDirs.length) log.info('   Codex: nenhuma pasta ~/.codex ainda (aparece quando o codex rodar pela primeira vez).');
  for (const d of codexDirs) {
    log.info(`   ${codexAccountName(basename(d))} (Codex, ${basename(d)}): ${late.codex?.sessionsByAccount().get(basename(d)) ?? 0} conversa(s) aberta(s) · ${d}`);
  }
  if (office.isDemo()) log.info('   Modo demonstração ligado (agentes simulados misturados aos reais).');
  if (!config.shell) log.info(`   Terminal embutido: desligado (${shellState.reason}).`);
  if (config.terminal) log.info('   Terminal somente leitura: ligado (acesso só local).');
  else log.info(`   Terminal somente leitura: desligado (${terminalOffReason(process.env, config.host, config.inDocker)}).`);
  log.info(timeline ? `   Linha do tempo (timelapse): gravando em ${timelineDir}.` : '   Linha do tempo (timelapse): gravação desligada (HABBLAUD_TIMELINE).');
  log.info(`   Missões: ${missions ? 'ligadas (projetos em ~/projetos)' : 'desligadas (mesma trava do terminal)'}.`);
  log.info(`   Responder pelo escritório: ${config.terminal ? 'ligado (precisa do mod: npm run mod:install; ou do hook antigo: npm run hooks:install)' : 'desligado (mesma trava do terminal)'}.`);
  log.info(
    updates.enabled
      ? `   Versão nova: verificando as releases de github.com/${config.repo} a cada 6 h.`
      : `   Versão nova: verificação desligada (${config.repo ? 'HABBLAUD_UPDATE_CHECK' : 'package.json sem repositório no GitHub'}).`,
  );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Encerrando (${signal})…`);
  clearInterval(ticker);
  stats.stop();
  watcher.stop();
  accounts.stop();
  hub.stop();
  terminals?.stop();
  timeline?.stop();
  permissions?.stop();
  questions?.stop();
  dialogs?.stop();
  missions?.stop();
  setupWatcher?.stop();
  codexSetupWatcher?.stop();
  codexWatcher?.stop();
  clearInterval(codexRediscover);
  missionsStore?.flush();
  updates.stop();
  announce.stop();
  names.flush();
  state.flush();
  void closeVite?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
