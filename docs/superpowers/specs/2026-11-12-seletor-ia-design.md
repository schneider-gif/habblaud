# Seletor de IA na barra do escritório (Motores de IA + conta Claude)

## Por quê

12/11/2026: o primeiro cliente com o adicional Motores de IA (hb-6df6ows6) logou a própria conta Claude e, pela regra
atual do `hb-ia` ("login próprio vence sempre"), os Motores saíram de cena sem aviso: consumo zero no OpenRouter.
O dono quer que o cliente use as IAs de dentro do escritório de forma fácil, começando num modelo bom e barato, e
trocando por uma lista quando quiser. A conta Claude dele também aparece na lista, se estiver conectada.

## O que o cliente vê (aprovado no rascunho)

- Barra de cima: um botão só com o **logo da IA em uso** e uma bolinha verde (funcionando).
- Clicou: lista no estilo do seletor do chat Prisma1 (logo + nome + uma linha de descrição, ✓ na atual):
  - **Sua conta**: "Minha conta Claude" — só se houver conta Claude conectada.
  - **Motores de IA Habblaude** — só com o adicional ativo: Prisma (padrão), DeepSeek, Qwen3 Coder, Gemini Flash
    Lite, Claude Sonnet ("gasta rápido").
  - Rodapé: gasto de hoje ("Hoje: US$ 0,12 de US$ 0,37").
  - Sem conta Claude: item "Conectar minha conta Claude (vale 1 ano)" com o passo a passo do `claude setup-token`
    e um campo para colar o token.
  - Sem o adicional: só a conta Claude + convite "Contratar Motores de IA" (link para o portal).
- Trocar vale para agentes novos; os já abertos trocam quando reabrir (aviso na lista).

## Como funciona

Um único escritor do `~/.claude/settings.json`: o daemon `hb-ia`. O servidor do escritório só grava pedidos em
arquivos de `~/.habblaude/` e lê o estado que o daemon publica.

| Arquivo | Quem grava | Conteúdo |
|---|---|---|
| `ia-escolha.json` | servidor do escritório | `{modo: "motores"\|"conta", modelo?: "<id OpenRouter>"}` |
| `claude-token` (600) | servidor do escritório | token do `claude setup-token` (ou ausente) |
| `ia-estado.json` | hb-ia | `{motores, conta, modo, modelo, uso: {hoje, limite}\|null, motivo?, em}` |

hb-ia (a cada 5 min e na hora em que `ia-escolha.json`/`claude-token` mudam, via fs.watch):
- Pede a chave ao portal como hoje; guarda a última resposta boa em memória (o portal limita 1 pedido/min por
  escritório — troca rápida reaproveita a resposta).
- Sem escolha gravada: `conta` se há conta Claude própria, senão `motores` (mesmo comportamento de hoje).
- `motores`: aplica `apiKeyHelper` + env com o modelo escolhido (ou o do portal). Pela ordem de credenciais do Claude
  Code (`apiKeyHelper` vem antes de `CLAUDE_CODE_OAUTH_TOKEN` e do `/login`), funciona mesmo com a conta logada.
- `conta`: tira o que é nosso (como o `remover` de hoje).
- Token do setup-token: vira `env.CLAUDE_CODE_OAUTH_TOKEN` no settings (marcado como nosso; settings vai para 600);
  apagar o arquivo tira a variável.
- Uso de hoje: `GET https://openrouter.ai/api/v1/key` com a chave do cliente.
- Configuração do próprio cliente (ANTHROPIC_* dele, apiKeyHelper dele) continua intocada: estado `motivo:
  "config-do-cliente"`, lista mostra a opção desativada.

Servidor do escritório: `GET /api/ia`, `POST /api/ia {modo, modelo?}`, `POST /api/ia/token {token}`,
`DELETE /api/ia/token`; mesma trava de host do painel do GitHub. O catálogo de modelos fica em `shared/ia-modelos.ts`
(id OpenRouter, nome, descrição, logo, premium); só ids do catálogo são aceitos.

## Decisões do Claude (conferir)

- "Prisma" = `minimax/minimax-m2.7` (US$ 0,21/0,84 por M tokens, mais novo e mais barato que o m2.5 do portal).
- Kimi fora da lista (sem logo no pacote do Prisma1). Logos copiados de `/opt/polymind/branding/ia`.
- Token colado no campo (o escritório não captura a saída do terminal sozinho).
- Nada muda no portal; deploy = release novo do escritório (staging antes de prod).

## Fora do escopo

- Integração ProZéIA dentro do escritório (próximo item, a pedido do dono).
- Trocar modelo de agente já aberto sem reabrir.
