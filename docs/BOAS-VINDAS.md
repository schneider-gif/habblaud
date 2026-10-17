# Agente de boas-vindas

Objetivo: levar quem abre o escritório pela primeira vez ao "momento uau" (um agente trabalhando num pedido
dele) em um clique, sem precisar descobrir o "+ Novo agente", a pasta do projeto ou o terminal. Quem já sabe o
que está fazendo pula com um clique e nunca mais vê.

## Quando aparece

O cartão aparece no centro do escritório, no lugar do cartão "O escritório está vazio", quando **tudo** vale:

1. o servidor diz que as boas-vindas estão pendentes (`GET /api/welcome` → `state: "login" | "ready"`);
2. o escritório está conectado, fora do timelapse e **sem nenhum agente nem sala** no momento em que a página
   decide mostrar (depois de mostrado, o cartão fica até o cliente escolher ou pular, mesmo que um agente
   apareça — por exemplo o `claude` aberto no terminal para fazer login);
3. o terminal embutido não está aberto por cima (o cartão volta quando ele fecha).

Nunca aparece com `HABBLAUD_BOAS_VINDAS=0`, sem o recurso de abrir agentes (escritório exposto fora do loopback,
fora do Linux, sem tmux) ou no modo demonstração.

## Estados (servidor)

`GET /api/welcome` devolve `WelcomeView` (`shared/welcome.ts`):

| `state` | Quando | O cartão mostra |
| --- | --- | --- |
| `off` | `HABBLAUD_BOAS_VINDAS=0` ou recurso de abrir agentes desligado | nada (vale o "escritório vazio") |
| `done` | já pulou, já usou uma sugestão, ou já tinha usado o Claude/Codex antes desta versão | nada, para sempre |
| `login` | pendente e a conta do Claude ainda não está conectada (`missions/auth.ts`, a mesma da Missão 0) | passo 1: conectar a conta ("Fazer login agora" abre o terminal embutido rodando o `claude`; "Já fiz login: conferir"); as sugestões aparecem travadas |
| `ready` | pendente e a conta conectada | as 3 sugestões clicáveis |

Além do estado, a visão leva `delivery` (a entrega da primeira mensagem, ver abaixo) e a lista de sugestões.

### Quem já era cliente

Na **primeira** consulta (nenhum registro salvo), o servidor confere se já houve uso do Claude Code ou do Codex
nesta máquina (alguma conversa `.jsonl` em `<conta>/projects/*/` ou em `<CODEX_HOME>/sessions/`). Se sim, grava `done` (`auto`) e o
cartão nunca aparece para quem já usava o escritório antes desta versão. Se não, grava `pending`; consultas
seguintes não refazem essa conferência (o login feito no terminal não some com o cartão).

### Persistência

O registro fica no mesmo `state.json` do `GET/PUT /api/state` (`<dataDir>/state.json`), na chave
`habblaud.boasvindas.v1`, que **só o servidor grava** (o `PUT /api/state` recusa essa chave):

```json
{"state":"pending","since":1760700000000}
{"state":"done","how":"skipped","at":1760700000000}
{"state":"done","how":"used","choice":"site","at":1760700000000}
{"state":"done","how":"auto","at":1760700000000}
```

## Sugestões

| id | Botão / primeira mensagem | Pasta |
| --- | --- | --- |
| `site` | Crie um site simples para mim | `~/projetos/primeiro-projeto` (criada se faltar) |
| `explicar` | Explique o que você sabe fazer | HOME |
| `organizar` | Organize meus arquivos | HOME |

## Fluxo de um clique

`POST /api/welcome/start {choice}`:

1. confere de novo: `off` → 403, `done` → 409, conta sem login → 409 `{login: true}` (o cartão volta ao passo 1);
2. abre o agente pelo mesmo caminho do `POST /api/agents/new` (`input.spawn`, motor Claude, mesma trava de bind
   e `Host` local, confiança na pasta marcada);
3. só se abriu: grava `done/used` e começa a entrega da mensagem; responde `201 {agentId, cwd}`;
4. se o spawn falhar, nada é gravado (dá para tentar de novo) e o erro volta para o cartão.

`POST /api/welcome/skip` grava `done/skipped` (vale também com a conta sem login).

### Entrega da primeira mensagem

O Claude aberto no tmux só aceita texto depois de subir. O Habblaud já sabe quando um agente aberto por ele
chegou: o mesmo critério do `SetupWatcher` (`shell/setup.ts`), um agente principal `.claude:<pid>` presente e
não `offline` no escritório (o Claude criou `sessions/<pid>.json`), e o `input.available(id)` do envio normal.
A partir daí, para não colar o texto antes do campo de mensagem existir, o servidor espera a tela do pane
(`capture-pane`) ficar igual em duas leituras seguidas (1 s) — ou 8 s de agente presente — e manda o texto pelo
mesmo `input.send` do `POST /api/agents/:id/input` (buffer + bracketed paste + Enter).

- Espera no máximo 10 min (cobre o cliente que ainda vai terminar tema/configuração no terminal).
- Se o `SetupWatcher` reabrir o agente depois do login (pid novo), a entrega segue o pid novo.
- `delivery.state`: `waiting` → `sent` | `failed`. O cartão já fechou; a página consulta enquanto `waiting` e
  avisa "pedido enviado" ou, se falhar, "mande pela caixa de mensagem do agente".

## Cartão (cliente)

- Identidade do escritório: painel roxo-noite (`#181621`/`--ui-bg-solid`), limão `#C8FF32` na ação, rosa
  `#FF5CAD` no destaque, títulos em Pixelify Sans.
- Ilustração do escritório vazio com um agente (avatar do módulo de arte) sentado na mesa e um balão "Oi! Sou seu
  primeiro agente. Por onde começamos?".
- **"✕ Pular" no canto superior direito, sempre visível** (também com `Esc`), em todos os estados. Pular grava no
  servidor; o `localStorage` só guarda uma cópia para não piscar o cartão antes da resposta.
- Clicar numa sugestão: o cartão mostra "Abrindo…", fecha ao receber o 201, avisa que o agente está chegando e
  seleciona o agente quando ele entra no escritório.

## Fora do escopo

- O agente do cartão é uma ilustração no próprio cartão, não um boneco no mapa (um agente falso no snapshot
  vazaria para estatísticas, timelapse e missões).
- Codex nas sugestões (o motor é sempre o Claude, como pedido).
