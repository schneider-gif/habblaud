// Catálogo das missões do quadro do escritório (pt-BR; en/es podem entrar depois em `text`).
// Cada missão diz um OBJETIVO, nunca um pedido pronto: o exemplo fica escondido atrás de um botão no quadro.
// Ordem fixa: só a primeira não concluída fica liberada.
import type { MissionId, MissionLevel } from '../../shared/missions';

export type { MissionId } from '../../shared/missions';

export interface MissionText {
  title: string;
  /** Por que vale a pena, em 1 linha. */
  why: string;
  /** O que precisa existir no fim. */
  goal: string;
  /** Um pedido de exemplo (semi-escondido). */
  example: string;
}

export interface Mission {
  id: MissionId;
  number: number;
  coins: number;
  xp: number;
  /** Pasta em ~/projetos onde o "Começar" abre o agente; null = o próprio HOME (Missão 0, sem projeto). */
  project: string | null;
  /** Ativa sozinha, sem "Começar" (a detecção roda desde o primeiro momento). */
  auto?: boolean;
  text: { pt: MissionText } & Partial<Record<'en' | 'es', MissionText>>;
}

/** Pasta dos projetos, dentro do HOME. */
export const PROJECTS_DIRNAME = 'projetos';
/** Slug de projeto (~/projetos/<slug>). */
export const PROJECT_SLUG_RE = /^[a-z0-9-]{2,40}$/;

export const MISSIONS: readonly Mission[] = [
  {
    // Preparação, não criatividade: aqui os passos podem ser concretos.
    id: 'conta-claude',
    number: 0,
    coins: 50,
    xp: 50,
    project: null,
    auto: true,
    text: {
      pt: {
        title: 'Conecte sua conta do Claude ou da OpenAI (Codex)',
        why: 'Sem isso os agentes não conseguem trabalhar. Qualquer uma das duas serve.',
        goal: '1) Clique em Fazer login agora (Claude) ou Conectar a OpenAI (Codex), ou abra o Terminal na barra de cima do escritório (no VS Code: menu Terminal › Novo terminal). 2) Claude: rode claude e escolha a sua conta Claude Pro/Max (abre um link no navegador) ou uma chave de API da Anthropic. Codex: rode codex e escolha Sign in with Device Code (abre um link e mostra um código) para usar o seu ChatGPT Plus/Pro, ou uma chave de API da OpenAI. 3) Volte aqui: o quadro confere sozinho. Você usa a sua própria conta ou chave; o uso é cobrado direto pela Anthropic ou pela OpenAI. Não somos afiliados.',
        example: 'No terminal: claude → "Claude account with subscription" e abra o link. Ou: codex → "Sign in with Device Code", abra o link e digite o código.',
      },
    },
  },
  {
    id: 'primeiro-site',
    number: 1,
    coins: 100,
    xp: 100,
    project: 'meu-site',
    text: {
      pt: {
        title: 'Seu primeiro site',
        why: 'Veja um agente criar algo de verdade para você, do zero.',
        goal: 'Peça a um agente um site de uma página sobre algo que você conhece bem. A missão termina quando o agente entregar e existir um index.html na pasta meu-site.',
        example: 'Crie um site de uma página para a minha padaria, com cardápio, horário e um botão de WhatsApp. Deixe bonito no celular.',
      },
    },
  },
  {
    id: 'peca-melhoria',
    number: 2,
    coins: 100,
    xp: 100,
    project: 'meu-site',
    text: {
      pt: {
        title: 'Peça uma melhoria',
        why: 'O agente continua de onde parou: é só falar com ele pelo escritório.',
        goal: 'Abra o terminal do agente do seu site aqui no escritório e mande uma mensagem pedindo uma mudança. Vale qualquer melhoria; a missão termina quando ele acabar.',
        example: 'Troque as cores para tons de verde e acrescente uma seção de depoimentos de clientes.',
      },
    },
  },
  {
    id: 'jogo-pixel',
    number: 3,
    coins: 150,
    xp: 150,
    project: 'jogo-pixel',
    text: {
      pt: {
        title: 'Um jogo em pixel art',
        why: 'Jogos mostram o que dá para criar quando você só descreve a ideia.',
        goal: 'Invente um joguinho que roda no navegador, com gráficos em pixel art desenhados num <canvas>. A missão termina quando o jogo existir na pasta jogo-pixel.',
        example: 'Faça um jogo em que um gatinho pula plataformas e coleta peixes, com placar e fases cada vez mais rápidas.',
      },
    },
  },
  {
    id: 'leve-github',
    number: 4,
    coins: 200,
    xp: 200,
    project: 'meu-site',
    text: {
      pt: {
        title: 'Leve para o GitHub',
        why: 'No GitHub o seu trabalho fica guardado, com histórico, e dá para mostrar a qualquer pessoa.',
        goal: 'Publique um dos seus projetos de ~/projetos num repositório seu no GitHub: o projeto precisa ter um remoto do github.com e um push feito.',
        example: 'Crie um repositório no meu GitHub para este projeto, faça o primeiro commit e envie (push).',
      },
    },
  },
  {
    id: 'api-banco',
    number: 5,
    coins: 250,
    xp: 250,
    project: 'minha-api',
    text: {
      pt: {
        title: 'Uma API com banco',
        why: 'Quase todo sistema de verdade é uma API guardando dados num banco.',
        goal: 'Crie na pasta minha-api um servidor com rotas que guarde dados num banco de dados (SQLite já basta). Peça ao agente para testar uma rota de verdade e escolher uma porta livre.',
        example: 'Crie uma API de lista de tarefas com SQLite: criar, listar e marcar como feita. Escolha uma porta livre e me mostre um teste com curl.',
      },
    },
  },
];

const BY_ID = new Map<string, Mission>(MISSIONS.map((m) => [m.id, m]));

export function missionById(id: unknown): Mission | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}

/** Níveis do escritório por XP acumulado nas missões. */
export const LEVELS: readonly { xp: number; name: string }[] = [
  { xp: 0, name: 'Estagiário' },
  { xp: 100, name: 'Assistente' },
  { xp: 250, name: 'Júnior' },
  { xp: 450, name: 'Pleno' },
  { xp: 700, name: 'Sênior' },
  { xp: 1000, name: 'Lenda do escritório' },
];

export function levelFor(xp: number): MissionLevel {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1].xp) i++;
  return { level: i + 1, name: LEVELS[i].name, floor: LEVELS[i].xp, ...(i + 1 < LEVELS.length ? { next: LEVELS[i + 1].xp } : {}) };
}
