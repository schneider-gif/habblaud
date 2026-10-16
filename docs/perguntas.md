# Perguntas com opções (AskUserQuestion) pelo chat

Quando o Claude Code abre o diálogo do AskUserQuestion, o Habblaud mostra a pergunta no chat do agente e responde
dirigindo o diálogo pelo tmux (`server/questions`). Enquanto a pergunta está aberta, mensagens pelo chat são recusadas
(o TUI as perderia ou, pior, um Enter escolheria uma opção).

## Telas do Claude Code 2.1.295 (observadas no TUI real)

- O `tool_use` do AskUserQuestion vai para o transcript assim que o diálogo abre; o `tool_result` só quando a pessoa
  responde. Pode haver um pequeno atraso entre o diálogo aparecer e a linha ser gravada.
- Uma pergunta, escolha única: setas até a opção e Enter já envia (sem revisão).
- Várias perguntas: abas no topo (`←  ☐ Banco  ☐ Recursos  ✔ Submit  →`). Enter numa opção de escolha única passa para
  a próxima aba.
- multiSelect: linhas `N. [ ] Rótulo`; Espaço ou Enter marcam/desmarcam. Depois do "Type something" vem um `Submit` sem
  número; Enter nele passa para a próxima aba (ou para a revisão).
- "Type something" (último número): com o cursor nele, o texto digitado vai para o campo; no multiSelect já marca a caixa.
- Revisão (`Review your answers`): `❯ 1. Submit answers` / `2. Cancel`; Enter no 1 envia.
- Rodapé: `Enter to select · ↑/↓ to navigate · Esc to cancel` (com abas: `Tab/Arrow keys to navigate`).
- O item `Chat about this` (abaixo do separador) nunca é usado.

## Teste ponta a ponta

`scripts/e2e-perguntas/run.ts` sobe uma API falsa (`mock-api.mjs`), abre o `claude` num tmux próprio (sem login, com
pasta de configuração própria) e responde pelo `QuestionService`, conferindo o `tool_result` recebido pela API:

    CLAUDE_BIN=~/cc295/node_modules/.bin/claude npx tsx scripts/e2e-perguntas/run.ts

Rodar só na máquina de desenvolvimento.
