// Carteiro das mensagens entre agentes (hb-msg, ver mod/habblaud/mensagens). A CLI só grava na caixa do
// destinatário; quem avisa é o servidor, que já acompanha o status de cada agente: a cada poucos segundos olha as
// caixas com mensagens novas e, quando o destinatário está livre (idle há um instante) e roda no tmux, digita no
// pane dele um aviso com a mensagem e o comando para responder. Ocupado = espera; fora do escritório = a mensagem
// fica na caixa (ele lê com `hb-msg ler`). Cada mensagem nova também vira um aviso no feed ("📨 Flavia → Bruno").
import type { AgentInfo } from '../../shared/types';
import { LIMITES, mover, pendentes, textoDoAviso, type Mensagem } from '../../mod/habblaud/mensagens/caixa.mjs';
import { errMsg, log } from '../log';

/** Status em que o agente aceita um prompt novo: livre (ou livre com shell em segundo plano). */
const LIVRE = new Set(['idle', 'shell']);

export interface CarteiroDeps {
  /** Raiz das caixas (raizPadrao). */
  raiz: string;
  /** Agentes do escritório agora (Office.list()). */
  agentes: () => AgentInfo[];
  /** Digita no pane do agente (AgentInput.available/send). */
  disponivel: (id: string) => Promise<boolean>;
  digitar: (id: string, texto: string) => Promise<void>;
  /** Mensagem nova vista pela primeira vez (aviso no feed). */
  aoChegar?: (m: Mensagem, de: AgentInfo | undefined, para: AgentInfo | undefined) => void;
  /** Livre há pelo menos isto antes de receber o aviso (evita digitar entre um passo e outro do turno). */
  folgaMs?: number;
  intervaloMs?: number;
  now?: () => number;
}

export class Carteiro {
  private vistas = new Set<string>();
  private primeira = true;
  private rodando = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: CarteiroDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervaloMs ?? 2000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Uma volta: avisos no feed das mensagens novas e entrega para quem está livre. Devolve os ids avisados. */
  async tick(): Promise<string[]> {
    if (this.rodando) return [];
    this.rodando = true;
    const entregues: string[] = [];
    try {
      const caixas = pendentes(this.deps.raiz);
      const principais = this.deps.agentes().filter((a) => a.kind === 'main' && a.status !== 'offline' && a.status !== 'done' && !a.id.startsWith('demo:'));
      const porSid = new Map(principais.map((a) => [a.sessionId, a]));
      // feed: só mensagens que chegaram com o servidor no ar (as que já estavam na caixa no boot, não)
      const atuais = new Set<string>();
      for (const msgs of caixas.values()) for (const m of msgs) atuais.add(m.id);
      for (const msgs of caixas.values())
        for (const m of msgs) {
          if (this.vistas.has(m.id)) continue;
          this.vistas.add(m.id);
          if (!this.primeira) this.deps.aoChegar?.(m, porSid.get(m.de.sid), porSid.get(m.para.sid));
        }
      for (const id of this.vistas) if (!atuais.has(id)) this.vistas.delete(id);
      this.primeira = false;

      const folga = this.deps.folgaMs ?? 1500;
      for (const [sid, msgs] of caixas) {
        const ag = porSid.get(sid);
        if (!ag || !LIVRE.has(ag.status) || this.now() - ag.statusSince < folga) continue;
        if (!(await this.deps.disponivel(ag.id))) continue;
        const aviso = textoDoAviso(msgs, LIMITES);
        // o rename é a posse: se o agente leu (hb-msg ler) no meio, a mensagem não sai de novo no aviso
        const tomadas: Array<{ id: string; para: 'lidas' | 'avisadas' }> = [];
        for (const id of aviso.incluidas) {
          const para = aviso.inteiras.includes(id) ? 'lidas' : 'avisadas';
          if (mover(this.deps.raiz, sid, id, 'novas', para)) tomadas.push({ id, para });
        }
        if (!tomadas.length) continue;
        const texto = tomadas.length === aviso.incluidas.length ? aviso.texto : textoDoAviso(msgs.filter((m) => tomadas.some((t) => t.id === m.id)), LIMITES).texto;
        try {
          await this.deps.digitar(ag.id, texto);
          entregues.push(...tomadas.map((t) => t.id));
        } catch (err) {
          // não deu para digitar: devolve para novas e tenta na próxima volta
          for (const t of tomadas) mover(this.deps.raiz, sid, t.id, t.para, 'novas');
          log.warnOnce(`carteiro:${ag.id}:${errMsg(err)}`, `Mensagem para ${ag.name} não entregue no terminal: ${errMsg(err)}`);
        }
      }
    } catch (err) {
      log.warnOnce(`carteiro:${errMsg(err)}`, `Falha no carteiro das mensagens: ${errMsg(err)}`);
    } finally {
      this.rodando = false;
    }
    return entregues;
  }
}
