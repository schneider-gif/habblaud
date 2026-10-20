# Bot Habblaude no escritório (imagem habblaude-office:0.12.2)

O daemon `hb-wa-bot.mjs` vai no pacote do release (pasta `mod/`), então fica em
`/opt/habblaud/mod/habblaud/whatsapp/hb-wa-bot.mjs`. Ele sobe pelo `hb-entrypoint`, supervisionado como `ubuntu`,
e herda `CODER_AGENT_TOKEN` do container (o `runuser` sem `-l` mantém o ambiente). Sem ChatBot ativo, o portal
responde 409 e o bot dorme 5 min entre conferências (ocioso, sem chamar o Claude).

## Dockerfile.0.12.2

```dockerfile
# habblaude-office:0.12.2 = 0.12.1 + Habblaud 0.12.2 (Bot Habblaude do WhatsApp supervisionado)
FROM habblaude-office:0.12.1
ARG HABBLAUD_VERSION=0.12.2
RUN --mount=type=bind,target=/ctx mkdir -p /opt/habblaud-releases/v${HABBLAUD_VERSION} \
 && tar xzf /ctx/habblaud-v${HABBLAUD_VERSION}.tgz --no-same-owner -C /opt/habblaud-releases/v${HABBLAUD_VERSION} \
 && test -f /opt/habblaud-releases/v${HABBLAUD_VERSION}/mod/habblaud/whatsapp/hb-wa-bot.mjs \
 && ln -sfn /opt/habblaud-releases/v${HABBLAUD_VERSION} /opt/habblaud-releases/current \
 && chown -R ubuntu:ubuntu /opt/habblaud-releases/v${HABBLAUD_VERSION} \
 && chmod 0755 /opt/habblaud/mod/habblaud/mensagens/hb-msg.mjs /opt/habblaud/mod/habblaud/whatsapp/hb-wa-bot.mjs \
 && grep -q whatsapp-bot /usr/local/bin/hb-entrypoint || sed -i 's|^if \[ -n "\${HB_AGENT_INIT:-}" \]; then|# 0.12.2: Bot Habblaude (WhatsApp do add-on ChatBot); ocioso sem ChatBot\nas_ubuntu /usr/local/bin/hb-supervise whatsapp-bot node /opt/habblaud/mod/habblaud/whatsapp/hb-wa-bot.mjs \&\n\n&|' /usr/local/bin/hb-entrypoint \
 && grep -q 'hb-supervise whatsapp-bot' /usr/local/bin/hb-entrypoint
LABEL habblaud.version="${HABBLAUD_VERSION}"
```

Montar (no nó, contexto com o `.tgz` do release, sem `.map`):

```sh
COPYFILE_DISABLE=1 tar --no-xattrs --exclude='*.map' -czf habblaud-v0.12.2.tgz package.json dist mod .claude-plugin LICENSE
sudo docker build -f Dockerfile.0.12.2 -t habblaude-office:0.12.2 .
sudo docker run --rm --entrypoint grep habblaude-office:0.12.2 -n whatsapp-bot /usr/local/bin/hb-entrypoint
```

## Contrato com o portal (rotas em app.habblaude.com)

- `POST /api/whatsapp/bot/registrar {agentToken}` -> `{token}` (409 = sem ChatBot/WhatsApp)
- `GET /api/whatsapp/bot/config` -> `{ativo, pausado, instrucoes, ignorar[], numero}`
- `GET /api/whatsapp/mensagens?depois=<cursor>&limite=50` -> `{mensagens[], cursor}`
- `POST /api/whatsapp/bot/pendente {de, nome, texto}` (avisa o dono)
- `POST /api/whatsapp/enviar {para, texto}` (403 = quem não escreveu nos últimos 7 dias)

Todas com `Authorization: Bearer <token>`. 401 = registra de novo.

## Segurança

O Claude roda com `claude -p --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources ""
--permission-mode dontAsk --no-session-persistence --system-prompt <fixo>`, num diretório vazio, com ambiente mínimo
(sem `CODER_AGENT_TOKEN`). Conferido com `--output-format stream-json --verbose`: o `init` traz `tools: []`,
`mcp_servers: []` e só plugins embutidos; um pedido de "rode cat ~/.ssh/..." não gera `tool_use`.

## Arquivos no escritório

- `~/.habblaud/whatsapp-bot.json` (600): token do portal e cursor
- `~/.habblaud/whatsapp-bot/bot.log` (números mascarados, gira em 2 MB), `status.json`, `<numero>.jsonl` (histórico, 50 linhas)
- `/tmp/hb-logs/whatsapp-bot.log`: saída do supervisor
