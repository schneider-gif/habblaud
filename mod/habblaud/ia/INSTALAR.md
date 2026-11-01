# Motores de IA no escritório (daemon hb-ia)

O daemon `hb-ia.mjs` vai no pacote do release (pasta `mod/`), então fica em
`/opt/habblaud/mod/habblaud/ia/hb-ia.mjs`. Sem dependências (Node do escritório). A cada 5 min pede a chave dos
Motores de IA ao portal com o `CODER_AGENT_TOKEN` e liga o Claude Code nela (`apiKeyHelper` no
`~/.claude/settings.json`). Sem o add-on, o portal responde 404 e o daemon tira o que tinha posto. Com login próprio
do Claude (`~/.claude/.credentials.json` ou `primaryApiKey`), vale a conta do cliente: o daemon tira o nosso e não pede.

Contas em `CLAUDE_CONFIG_DIR` (outro diretório de configuração) não são gerenciadas: o daemon só mexe no `~/.claude`.
Tirar o add-on deixa as sessões em andamento usando a chave em cache por até 300 s; depois elas pedem login.

A chave nunca vai para env do container, `startup_script` nem manifest do Coder: só para `~/.habblaude/ia-chave` (600).

## Contêiner (imagem habblaude-office)

Camada nova sobre a imagem atual (confira com `sudo docker images habblaude-office`; em 31/10 a mais nova era a do
release 0.12.4), com o release que já traz `mod/habblaud/ia/hb-ia.mjs`. Ele sobe pelo `hb-entrypoint`,
supervisionado como `ubuntu`, e herda `CODER_AGENT_TOKEN` do container (o `runuser` sem `-l` mantém o ambiente), como
o `whatsapp-bot`.

```dockerfile
# habblaude-office:<novo> = <atual> + Habblaud <novo> (Motores de IA: daemon hb-ia)
ARG BASE=habblaude-office:0.12.4
FROM ${BASE}
ARG HABBLAUD_VERSION=0.12.5
RUN --mount=type=bind,target=/ctx set -e; mkdir -p /opt/habblaud-releases/v${HABBLAUD_VERSION}; \
 tar xzf /ctx/habblaud-v${HABBLAUD_VERSION}.tgz --no-same-owner -C /opt/habblaud-releases/v${HABBLAUD_VERSION}; \
 test -f /opt/habblaud-releases/v${HABBLAUD_VERSION}/mod/habblaud/ia/hb-ia.mjs; \
 ln -sfn /opt/habblaud-releases/v${HABBLAUD_VERSION} /opt/habblaud-releases/current; \
 chown -R ubuntu:ubuntu /opt/habblaud-releases/v${HABBLAUD_VERSION}; \
 chmod 0755 /opt/habblaud/mod/habblaud/ia/hb-ia.mjs; \
 if ! grep -q 'hb-supervise ia ' /usr/local/bin/hb-entrypoint; then \
   sed -i 's|^if \[ -n "\${HB_AGENT_INIT:-}" \]; then|# Motores de IA (chave OpenRouter do add-on); sem o add-on só confere a cada 5 min\nas_ubuntu /usr/local/bin/hb-supervise ia node /opt/habblaud/mod/habblaud/ia/hb-ia.mjs \&\n\n&|' /usr/local/bin/hb-entrypoint; \
 fi; \
 grep -q 'hb-supervise ia ' /usr/local/bin/hb-entrypoint; \
 bash -n /usr/local/bin/hb-entrypoint
LABEL habblaud.version="${HABBLAUD_VERSION}"
```

Montar (no nó, contexto com o `.tgz` do release, sem `.map`):

```sh
COPYFILE_DISABLE=1 tar --no-xattrs --exclude='*.map' -czf habblaud-v0.12.5.tgz package.json dist mod .claude-plugin LICENSE
sudo docker build -f Dockerfile.0.12.5 --build-arg BASE=habblaude-office:0.12.4 -t habblaude-office:0.12.5 .
sudo docker run --rm --entrypoint grep habblaude-office:0.12.5 -n 'hb-supervise ia ' /usr/local/bin/hb-entrypoint
```

## VM (Proxmox / Incus)

Serviço systemd como `ubuntu`. O token do agente vem de `/etc/hb-ia.env` (0600 root; o systemd lê antes de trocar de
usuário), gravado pelo script que já sobe o agente do Coder (no golden do Incus, `vibe-agent-boot`, que já tem
`$TOKEN`; no Proxmox, o equivalente do cloud-init). É o token do agente, não a chave da IA.

```sh
# no vibe-agent-boot, antes do exec do coder agent:
( umask 077; printf 'CODER_AGENT_TOKEN=%s\n' "$TOKEN" > /etc/hb-ia.env ); systemctl restart hb-ia || true
```

`/etc/systemd/system/hb-ia.service`:

```ini
[Unit]
Description=Motores de IA (hb-ia): chave dos agentes do escritório Habblaude
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
Environment=HOME=/home/ubuntu
EnvironmentFile=/etc/hb-ia.env
ExecStart=/usr/bin/node /opt/habblaud/mod/habblaud/ia/hb-ia.mjs
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

`sudo systemctl daemon-reload && sudo systemctl enable --now hb-ia`; log: `journalctl -u hb-ia` (só mudanças de estado).

## Log e resultados

O daemon recusa rodar como root (grava em `$HOME`; rode como `ubuntu`). O log só registra mudanças de estado:
`gravou`, `nada`, `removeu`, `propria`, `propria-removeu`, `config-do-cliente`, `settings-invalido`, `sem-token`,
`erro-<status>` (HTTP do portal), `erro-rede`, `erro-resposta`, `erro-concorrencia`. Nunca a chave nem o token.

## Contrato com o portal (app.habblaude.com)

- `POST /api/escritorio/ia/chave {agentToken}` -> 200 `{chave, baseUrl, modelo}`; 404 = sem Motores de IA (ou pausado
  no mês, ou chave ainda não criada); 401/429/5xx = não mexe em nada.

## Arquivos no escritório

- `~/.habblaude/ia-chave` (600): a chave.
- `~/.claude/settings.json`: `apiKeyHelper: "cat ~/.habblaude/ia-chave"`, `env` (`ANTHROPIC_BASE_URL`, modelos,
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`) e `"hbIaGerenciado": {"env": {...}}` (os valores que o daemon gravou: só o que ainda bate com eles é removido).
- `~/.claude.json`: `hasCompletedOnboarding: true` (só acrescenta).
- Contêiner: `/tmp/hb-logs/ia.log` (saída do supervisor).
