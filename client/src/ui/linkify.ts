// Links http(s) em texto (terminal da conversa e markdown das respostas): o endereço inteiro vira um <a> que abre em
// outra aba. O link pode quebrar visualmente em várias linhas (CSS), mas o href é sempre a URL completa — antes, uma
// URL longa (ex.: a de login do Claude Code) era copiada ou aberta cortada. O botão direito no link dá o "Copiar
// endereço do link" do próprio navegador.

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
/** Pontuação que costuma fechar a frase, não a URL. */
const TRAILING = /[.,;:!?…]+$/;

export type LinkPart = { text: string } | { url: string };

/** Separa texto e URLs (só http/https). Parênteses/colchetes de fechamento sem abertura na URL ficam fora dela. */
export function splitUrls(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const start = m.index ?? 0;
    url = url.replace(TRAILING, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
      while (url.endsWith(close) && count(url, close) > count(url, open)) url = url.slice(0, -1);
    }
    url = url.replace(TRAILING, '');
    if (url.length <= 'https://'.length) continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** URL segura para virar link clicável (só http/https, sem credenciais embutidas). */
export function safeHref(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username || u.password) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

export function linkElement(href: string, text: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'ui-link-url';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = text;
  a.title = `${href}\nClique para abrir em outra aba · botão direito: copiar endereço do link`;
  return a;
}

/** Nós DOM do texto com as URLs viradas links (só textContent: nada de HTML vindo do transcript). */
export function linkifyInto(parent: Node, text: string): void {
  for (const p of splitUrls(text)) {
    if ('text' in p) parent.appendChild(document.createTextNode(p.text));
    else {
      const href = safeHref(p.url);
      parent.appendChild(href ? linkElement(href, p.url) : document.createTextNode(p.url));
    }
  }
}
