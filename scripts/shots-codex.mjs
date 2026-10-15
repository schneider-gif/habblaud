// Prints headless (Chromium do Playwright, sem tocar no navegador do usuário) das telas do Codex e do GitHub na 0.8.0.
// Uso: node scripts/shots-codex.mjs <base-url> <pasta-saida> <cena> [--agent <id>]
// Cenas: dialogo, sem-login, terminal-login, missao0, agente, conversa, aprovacao, github, github-repos, historico, barra
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [base, outDir, scene, ...rest] = process.argv.slice(2);
const arg = (n) => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const name = arg('name') ?? scene;
const size = (arg('size') ?? '1440x900').split('x').map(Number);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('dialog', (d) => d.accept());
// primeira visita com os painéis abertos (o padrão é recolhido)
await page.addInitScript(() => {
  try {
    const k = 'habblaud:prefs';
    const p = JSON.parse(localStorage.getItem(k) || '{}');
    localStorage.setItem(k, JSON.stringify({ ...p, sidebarOpen: true, feedOpen: true, panelsChosen: true }));
  } catch {}
});
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const shot = (suffix = '') => page.screenshot({ path: join(outDir, `${name}${suffix}.png`) });
const agentId = arg('agent');

async function selectAgent(id) {
  await page.evaluate((id) => {
    const row = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (row) row.click();
  }, id);
  await page.waitForTimeout(1500);
}

switch (scene) {
  case 'dialogo': {
    await page.click('.ui-btn-new-agent');
    await page.waitForTimeout(800);
    await page.click('.ui-cust__seg [data-engine="codex"]');
    await page.fill('#ui-cust-name', 'Otto');
    await page.fill('#ui-cust-folder', 'projetos/loja');
    await page.waitForTimeout(500);
    await shot();
    break;
  }
  case 'sem-login':
  case 'agente':
  case 'barra':
    if (agentId) await selectAgent(agentId);
    await shot();
    break;
  case 'terminal-login':
    if (agentId) await selectAgent(agentId);
    await page.waitForTimeout(3000);
    await shot();
    break;
  case 'conversa': {
    if (agentId) await selectAgent(agentId);
    await page.keyboard.press('t');
    await page.waitForTimeout(2500);
    await shot();
    break;
  }
  case 'aprovacao':
    if (agentId) await selectAgent(agentId);
    await page.waitForTimeout(1500);
    await shot();
    break;
  case 'missao0': {
    await page.evaluate(() => document.querySelector('.ui-missions__min')?.click());
    await page.waitForTimeout(1200);
    await shot();
    break;
  }
  case 'github': {
    await page.evaluate(() => (document.querySelector('.ui-btn-github') ?? [...document.querySelectorAll('.ui-more-menu button')].find((b) => /GitHub/.test(b.textContent)))?.click());
    await page.waitForTimeout(2500);
    await shot();
    break;
  }
  case 'github-repos': {
    await page.evaluate(() => document.querySelector('.ui-btn-github')?.click());
    await page.waitForTimeout(2000);
    const click = (t) => page.evaluate((t) => [...document.querySelectorAll('.ui-gh button')].find((b) => b.textContent.includes(t))?.click(), t);
    await click('Listar meus repositórios');
    await page.waitForTimeout(1500);
    await click('Escolher uma pasta');
    await page.waitForTimeout(1200);
    await click('Ver meus PRs');
    await page.waitForTimeout(1500);
    await shot('-1-listas');
    await click('Clonar em ~/projetos');
    await page.waitForTimeout(2500);
    await shot('-2-clonado');
    break;
  }
  case 'historico': {
    await page.evaluate(() => { const b = document.querySelector('.ui-hist-btn'); if (b && b.closest('.ui-more-menu')) document.querySelector('.ui-more-btn')?.click(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('.ui-hist-btn')?.click());
    await page.waitForTimeout(2500);
    await shot();
    break;
  }
  default:
    console.error('cena desconhecida');
}
if (problems.length) console.log(problems.slice(0, 8).join('\n'));
await browser.close();
