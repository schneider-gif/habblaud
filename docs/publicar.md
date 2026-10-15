# Publicar (Hospedagem Habblaude)

O escritório publica uma pasta de `~/projetos` na hospedagem do Habblaude e devolve `https://<site>-<usuário>.habblaude.app`
(e, se quiser, um domínio próprio com HTTPS). É um complemento da assinatura; o escritório fala só com o portal
(`HB_PORTAL_URL`, padrão `https://app.habblaude.com`), nunca com o servidor de publicação.

## Onde abrir

- Botão **Publicar** na barra superior (no grupo dos painéis; vai para o "⋯" quando a barra não cabe).
- **Publicar este projeto** na gaveta da sala (clique numa sala do escritório): já abre com a pasta dela.
- De qualquer código da interface: `window.dispatchEvent(new CustomEvent('hb:publish', { detail: { path } }))`.

O assistente: conectar a conta → projeto → tipo e comandos (detectados, editáveis) → variáveis (importa do `.env`,
avisa de senhas/chaves escritas no código) → endereço (e domínio próprio com os registros DNS exatos e checagem a
cada 15 s) → publicar com log ao vivo e link. "Meus sites" mostra status, último envio, domínios, logs do app,
"Publicar de novo" e "Despublicar".

Só funciona com a mesma trava do terminal: Habblaud em bind local (`HABBLAUD_HOST` loopback) e aberto por
`http://localhost`/`127.0.0.1` (ou um nome de `HABBLAUD_LOCAL_HOSTS`). Fora disso as rotas respondem 403 e o botão some.

## Conta e token

- **Pareamento** (pelo assistente): o servidor chama `POST /api/publicar/conectar`, o navegador abre a página de
  confirmação do portal e o servidor faz o polling de `/conectar/token`. O token vai para
  `~/.habblaude/publish-token` (0600).
- **Variável**: `HB_PUBLISH_TOKEN=hbp_...` (template do Coder) vence o arquivo.

## O que vai no pacote

`tar.gz` gerado em JS puro (raiz = raiz do projeto). Repositório git: `git ls-files -co --exclude-standard`; senão,
tudo menos `node_modules`, `.git`, `.next`, `dist`/`build` (exceto a pasta de saída de um site estático),
`__pycache__`, `.venv`/`venv`. **Nunca** `.env*`, nem links simbólicos. Limite: `maxUploadMB` do plano (padrão 50 MB),
com erro claro antes do envio.

## Agentes publicando (com confirmação)

O agente (Claude, Codex…) pede; o usuário confirma no escritório; só então o projeto é empacotado e enviado.

```sh
node scripts/habblaud-publicar.mjs ~/projetos/minha-loja --origem Claude   # ou: npm run publicar -- <pasta>
# no build: node dist/server/publicar.mjs <pasta>
```

- Aparece no escritório o aviso **"Publicar?"**. Se a pasta já tem site (mesmo nome, ou `--site <id>`), "Publicar"
  envia na hora; se não, "Abrir o assistente" leva ao passo a passo (o agente continua esperando).
- O comando imprime o andamento e, no fim, `Publicado! https://...` (saída 0). Recusado, expirado (15 min) ou falhou:
  saída 1. Habblaud fora do ar / escritório sem conta conectada: saída 2. `--json` imprime só o resultado.
- `HABBLAUD_URL` ou `--porta` apontam para outro Habblaud local (padrão `http://127.0.0.1:4747`).

Instrução sugerida para o agente: *"Para publicar, rode `node <habblaud>/scripts/habblaud-publicar.mjs <pasta>
--origem Claude` e avise o usuário para confirmar no escritório; nunca coloque senhas no código, use variáveis."*

## Rotas locais (`server/publish/http.ts`)

`GET /api/publish/status` · `POST /connect` · `POST /disconnect` · `GET /projects` · `POST /detect {path}` ·
`POST /env-import {path}` · `POST /account {handle}` · `POST /sites` · `GET|PATCH|DELETE /sites/:id` ·
`PUT /sites/:id/env` · `GET /sites/:id/logs` · `POST /sites/:id/dominios` · `POST /sites/:id/dominios/:nome/verificar` ·
`DELETE /sites/:id/dominios/:nome` · `POST /deploy {siteId, path, requestId?}` · `GET /deploys/:id` ·
`GET /deploys/:id/logs` (SSE repassado) · `POST|GET /requests` (long-poll `?wait=1&since=N`) · `GET /requests/:id` ·
`POST /requests/:id/approve|reject`. `path` precisa estar dentro de `~/projetos` (caminho real, sem symlink
escapando), senão 400.

## Desenvolvimento com o portal falso

```sh
npm run fake-portal                    # portal em memória em http://127.0.0.1:8787 (pareamento se confirma sozinho)
HB_PORTAL_URL=http://127.0.0.1:8787 npm run dev
```

Opções do portal falso (`npx tsx server/publish/fake-portal.ts`): `--port`, `--auto`, `--inativo sem_complemento`,
`--handle fulano`, `--falhar` (builds falham), `--passo <ms>`. Domínio próprio: a 1ª verificação fica pendente, a
2ª passa. Também é usado pelos testes (`server/publish/publish.test.ts`, `startFakePortal()`).
