# Codex CLI no Habblaud (0.8.0)

Como o Habblaud enxerga o [Codex CLI](https://github.com/openai/codex) (`@openai/codex`, OpenAI) e o que foi
conferido de verdade, instalando o Codex CLI **0.162.1** (última versão no npm em 14/10/2026) num container Debian
(node:22) e conversando com ele por um provedor de modelo local de teste — sem conta OpenAI (as fixtures em
`server/codex/fixtures/` saíram dessas sessões, anonimizadas).

## Onde o Codex guarda as coisas

Tudo em `CODEX_HOME` (padrão `~/.codex`):

| O quê | Onde |
| --- | --- |
| Configuração | `config.toml` (`model`, `approval_policy`, `sandbox_mode`, `[projects."<pasta>"] trust_level = "trusted"`, `[features]`...) |
| Login | `auth.json`: `{"auth_mode": "chatgpt", "tokens": {...}}` (ChatGPT Plus/Pro) ou `{"auth_mode": "apikey", "OPENAI_API_KEY": "..."}` |
| Conversas | `sessions/AAAA/MM/DD/rollout-<AAAA-MM-DDTHH-MM-SS>-<threadId>.jsonl` (threadId é um UUIDv7) |
| Conversa aberta | `thread-writer-locks/<threadId>.lock` com `flock` de escrita de quem grava a conversa; some ao fechar |
| Histórico de prompts | `history.jsonl` (`{session_id, ts, text}`) |
| Índice/estado | `state_5.sqlite` (tabela `threads`: rollout_path, cwd, title, approval_mode...), `thread_history_1.sqlite`, `logs_2.sqlite`... |

O rollout **só nasce na primeira mensagem**: antes disso existe só a trava (`.lock`). Uma conversa aberta e fechada
sem mensagem ganha um rollout com uma linha (`session_meta`).

## Login

- `codex` sem login abre a tela "Welcome to Codex": **1. Sign in with ChatGPT** (navegador com redirecionamento para
  `localhost:1455`), **2. Sign in with Device Code** (link + código de uso único — o que funciona no escritório na
  nuvem), **3. Provide your own API key**.
- `codex login --device-auth` faz o login por código de dispositivo direto no terminal (é o que o botão
  **Conectar a OpenAI (Codex)** da Missão 0 roda).
- `codex login --with-api-key` lê a chave do stdin. `codex login status` sai com código 1 sem login.
- O Habblaud só confere se o `auth.json` tem credencial (e o `auth_mode`); nunca guarda nem mostra o conteúdo.

## Formato do rollout (0.162.1)

Cada linha: `{"timestamp", "ordinal", "type", "payload"}`.

| type / payload.type | Significado | No Habblaud |
| --- | --- | --- |
| `session_meta` | `{id, cwd, cli_version, originator, model_provider, base_instructions}` (1ª linha) | pasta do agente (sala) |
| `turn_context` | a cada turno: `{cwd, model?, approval_policy, sandbox_policy}` | modelo, modo de aprovação |
| `event_msg/task_started` | começou um turno | **trabalhando** |
| `response_item/message` role `user` | pedido do usuário (o 1º `user` é o `<environment_context>`, ignorado) | "Nova tarefa", título |
| `response_item/message` role `assistant` | resposta | "Escrevendo a resposta" |
| `response_item/message` role `developer` | instruções do Codex (e `<turn_aborted>`) | ignorado |
| `response_item/reasoning` | raciocínio (resumo opcional) | "Pensando…" |
| `response_item/function_call` `exec_command` | comando: `{"cmd": "...", "sandbox_permissions"?: "require_escalated", "justification"?}` | lendo/rodando/testes/git (mesmas regras do Bash do Claude) |
| `response_item/custom_tool_call` `apply_patch` | patch `*** Add/Update/Delete File: x` | editando/escrevendo |
| `response_item/function_call` `update_plan` | plano `{plan: [{step, status}]}` | tarefas |
| `response_item/function_call_output` / `custom_tool_call_output` | resultado (`Process exited with code N` + `Output:`) | fecha a chamada pendente |
| `event_msg/item_completed` | `CommandExecution` (status, exit_code), `FileChange`, `AgentMessage`, `UserMessage` | erro de comando |
| `event_msg/token_count` | tokens do turno/total | números |
| `event_msg/task_complete` | fim do turno `{last_agent_message, duration_ms}` | "Concluiu em X", **ocioso** |
| `event_msg/turn_aborted` | Esc: `{reason: "interrupted"}` | "Interrompido por você" |
| `world_state`, `token_usage_record`, `thread_settings_applied` | estado interno | ignorado |

**Pedido de aprovação não vira linha no rollout.** O que aparece é a chamada sem resultado (com
`sandbox_permissions: "require_escalated"` quando o modelo pede para sair do sandbox). A tela do TUI mostra:

```
  Would you like to run the following command?
  Reason: <justificativa>
  $ <comando>
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `…` (p)
  3. No, and tell Codex what to do differently (esc)
```

e, para edições, `Would you like to make the following edits?` com `2. Yes, and don't ask again for these files (a)`.

## Como o Habblaud acha o agente

O Codex não tem um registro de sessões abertas como o `~/.claude/sessions/<pid>.json`. O Habblaud usa:

1. **Travas abertas**: `thread-writer-locks/<threadId>.lock` com dono vivo em `/proc/locks` (inode → pid). Fora do
   Linux, todo `.lock` presente conta (sem pid).
2. **Quem segura a trava**: com `codex --no-daemon` (como o Habblaud abre) ou `features.daemon_auto_start = false`
   (config padrão da imagem do escritório), é o próprio TUI. O pid do agente é o do lançador `node .../bin/codex`
   (pai do binário nativo) — o pid do pane no tmux. Com o servidor compartilhado do 0.162 (`codex app-server`, padrão
   fora do escritório), quem segura é o daemon, que fica com a conversa um tempo depois de o TUI fechar e não está no
   tmux: o agente aparece, mas sem mensagens/aprovação pelo escritório.
3. **Rollout**: `sessions/<dia do UUIDv7 ±1>/rollout-*-<threadId>.jsonl` (varre tudo de vez em quando).

Id do agente: `<conta>:<pid>` (`.codex:1234`), como os do Claude — por isso mensagens (bracketed paste + Enter no
pane), bonecos em configuração e "Retomar" funcionam igual.

## Estados

| Estado | De onde vem |
| --- | --- |
| trabalhando | turno aberto (`task_started`/prompt sem `task_complete`) |
| ocioso | turno fechado (`task_complete`, `turn_aborted`) ou conversa ainda sem mensagem |
| precisa de você: aprovar um comando/edição | tela do tmux com o pedido (ou, fora do tmux, chamada com `require_escalated` pendente há mais de 1 s) |
| precisa de você: conectar sua conta OpenAI | sessão `agente-codex-*` aberta pelo escritório sem `auth.json` válido |
| precisa de você: confiar nesta pasta | tela "Trust this folder?" (o "+ Novo agente" já marca a pasta como confiável no `config.toml`) |
| esperando comando | `exec_command` sem resultado (vira `ShellJob` em primeiro plano) |
| encerrado | trava fechada |

## Aprovar pelo escritório

Não há API/hook do Codex para isso. O Habblaud lê a tela do pane (`tmux capture-pane`), mostra o pedido com o
mesmo painel dos pedidos do Claude (ids `codex-…` em `/api/permissions`) e, na decisão, **confere a tela de novo** e
manda a tecla mostrada pelo Codex: `y` (aprovar), `p`/`a` (aprovar e não perguntar de novo, quando oferecido) ou `Esc`
(recusar; o motivo, se houver, vai como mensagem em seguida). Se o pedido já foi respondido no terminal, nada é
digitado.

No escritório na nuvem o sandbox do Codex (bubblewrap) não consegue criar namespaces num container sem privilégios,
então a imagem usa `sandbox_mode = "danger-full-access"` (o container já é o isolamento, como a VM) com
`approval_policy = "on-request"`: o modelo só pede aprovação quando ele acha necessário.

## Retomar

`codex resume <threadId>` (ou `codex resume --last`). O histórico do Habblaud lista as conversas do Codex (selo e conta
"Conta OpenAI") e o botão **Retomar** abre `codex resume --no-daemon <id>` no tmux, na pasta original (lida do
`session_meta`).
