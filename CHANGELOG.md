# Novidades

O que entrou em cada versão do Habblaud. Cada versão tem a sua seção aqui, e o texto dela vira as notas da
[release no GitHub](https://github.com/marmottajr/habblaud/releases) (`npm run release`), que o Habblaud abre em
**Configurações › Sobre › Ver o que mudou**.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/), e os números seguem o
[versionamento semântico](https://semver.org/lang/pt-BR/): correção sobe o último número (0.2.**1**), novidade sobe o
do meio (0.**3**.0).


## [0.12.3] - 2026-10-20

### Adicionado

- Bot Habblaude v2:
  - **Base de conhecimento:** o bot usa o cardápio, catálogo ou tabela de preços que o dono cadastrar no portal para responder preço, produto e prazo; o que não estiver lá vai para o dono.
  - **Pedidos, orçamentos, agendamentos e contatos:** quando o cliente fecha algo, o bot registra no portal (lista no painel do WhatsApp), sem mostrar nada disso ao cliente.
  - **Imagens:** o bot vê a foto que o cliente manda (pedido, comprovante, produto). Áudio sem transcrição: pede gentilmente para o cliente escrever.
  - **Dono assume a conversa:** conversa assumida pelo dono no portal não recebe resposta do bot.
  - **Só estes números:** com a lista "somente" preenchida no portal, o bot só responde esses números (com ou sem o 9º dígito).
  - **Mais natural:** mensagens que chegam em sequência são respondidas de uma vez (espera 4 s de silêncio), sem repetir saudação, em até 2 mensagens curtas.

## [0.12.2] - 2026-10-20

### Adicionado

- Bot Habblaude: com o add-on ChatBot (WhatsApp 24h) ativo, o escritório atende o WhatsApp sozinho, seguindo as
  instruções que o dono escreve no portal. Responde só conversas novas de outros números, chama o dono quando não sabe,
  e o Claude roda sem nenhuma ferramenta (texto de estranhos nunca chega a arquivos ou comandos).

## [0.12.1] - 2026-10-20

### Alterado

- Nome Habblaude em todo o escritório: título da página, barra, Sobre, ajuda, avisos, mensagens de erro, textos dos
  plugins e do hb-msg agora dizem "Habblaude" (habblaude.com). "habblaud" fica só nos nomes técnicos internos
  (pastas, plugins, variáveis, comando /habblaud). A skill de comunicação avisa isso aos agentes.

## [0.12.0] - 2026-10-19

### Adicionado

- Renomear sala: clique na sala e use **✎ Renomear** para dar o nome que quiser (ex.: "meu-site" vira "Site da
  padaria"). Muda só o nome que aparece no escritório: a pasta, os agentes e o histórico continuam onde estão. Deixe
  o nome em branco para voltar ao nome da pasta.

### Corrigido

- Depois de atualizar ou religar o escritório, aparecia "O escritório está vazio" por alguns segundos enquanto os
  agentes voltavam. Agora aparece "Retomando seus agentes…" até eles chegarem.

- Login do Claude pelo escritório: quando a conta sai (ou o login expira) e o agente pede para entrar, a tela com o
  link de login agora aparece no chat do agente, com o link clicável. Depois de entrar, é só colar o código na caixa
  de mensagem. Antes a tela sumia e o link não aparecia.
- Agente com a mão levantada sem nada para responder: telas do terminal sem lista de opções (código de login
  inválido "Press Enter to retry", "Login successful. Press Enter to continue…") agora aparecem no escritório com os
  botões Enter e Esc.

## [0.11.0] - 2026-10-18

### Adicionado

- Boas-vindas na primeira abertura: um agente sentado na mesa oferece 3 primeiras tarefas ("Crie um site simples
  para mim", "Explique o que você sabe fazer", "Organize meus arquivos"). Um clique abre o agente e já manda o pedido
  quando o Claude fica pronto; sem a conta conectada, o cartão leva ao login primeiro. **✕ Pular** sempre à vista, e
  quem pula ou usa nunca mais vê (fica salvo no servidor). Enquanto o cartão está na tela, o quadro de missões fica
  escondido. `HABBLAUD_BOAS_VINDAS=0` desliga.

### Corrigido

- Versão do marketplace e dos plugins do Claude Code (mod) acompanha a do Habblaud de novo (tinha ficado em 0.10.1).

## [0.10.2] - 2026-10-17

### Corrigido

- Criar um agente numa pasta que ainda não existe não dá mais erro 400: um nome simples (ex.: `meu-site`) vira
  `~/projetos/meu-site` e um caminho novo é criado dentro do HOME. Caminhos que saem do HOME continuam recusados.

## [0.10.1] - 2026-10-16

### Adicionado

- Os agentes voltam sozinhos quando o escritório religa (por exemplo, depois de desligar por inatividade): o Habblaud
  guarda em `abertos.json` os agentes abertos e, ao subir, retoma cada conversa com o mesmo nome e visual. Agente que
  você fechou não volta. `HABBLAUD_REOPEN=0` desliga.

## [0.10.0] - 2026-10-16

### Adicionado

- Agentes conversando entre si: comando `hb-msg` (`quem`, `enviar`, `ler`, `responder`) e a skill `comunicacao` no
  plugin do Claude Code (o mesmo SKILL.md serve ao Codex). A mensagem fica na caixa privada do destinatário e o
  Habblaud digita o aviso no terminal dele quando ele fica livre; no feed aparece "📨 Flavia → Bruno". Limite de 8 KB
  por mensagem e anti-loop por par (5/min, 30/h).
- A conta do Claude aparece como "Conta Anthropic", ao lado da "Conta OpenAI".
- Botão 🐞 Bug na barra (`HABBLAUD_BUG_URL`): abre o formulário de bug da plataforma.

## [0.9.2] - 2026-10-16

### Corrigido

- Perguntas com opções no Claude Code de verdade: o 2.1.295 só grava a pergunta no transcript depois da resposta, então
  o Habblaud agora lê a pergunta da tela do diálogo (uma aba por vez quando há várias).
- Telas de seleção que o Habblaud não conhece (ex.: "Teach auto mode about your environment?") não travam mais o agente:
  o escritório mostra o trecho do terminal com os botões ↑ ↓ Enter Esc.

## [0.9.1] - 2026-10-16

### Corrigido

- Perguntas com opções do Claude (AskUserQuestion, inclusive a tela "Review your answers"): aparecem num cartão no chat
  e na gaveta do agente, com as opções, "Outro" e Enviar; o Habblaud responde dirigindo o diálogo no terminal.
- Mensagem digitada enquanto o agente espera a resposta de uma pergunta não some mais: a caixa avisa e guarda o texto.

### Adicionado

- Caixa de mensagem do chat com várias linhas: Enter envia, Shift+Enter quebra a linha.

### Corrigido

- "+ Novo agente" com uma pasta que ainda não existe não dá mais erro 400: um nome novo (ex.: `meu-site`) cria
  `~/projetos/meu-site`, e um caminho novo é criado dentro do HOME. Pastas fora do HOME continuam recusadas.

## [0.9.0] - 2026-10-15

### Adicionado

- Aviso global da plataforma (`HABBLAUD_ANNOUNCE_URL`): modal com logo e confete, uma vez por navegador, só quando
  alguém está usando o escritório (aba visível e clique ou tecla no último minuto).

## [0.8.0] - 2026-10-15

### Adicionado

- **Codex (OpenAI) no escritório.** Além do Claude Code, o Habblaud agora acompanha o
  [Codex CLI](https://github.com/openai/codex): as conversas abertas do Codex (`~/.codex`, `CODEX_HOME` e
  `~/.codex-*`) aparecem como agentes, com selo verde **Codex**, na **Conta OpenAI**, com o mesmo modelo dos agentes
  do Claude: trabalhando / esperando / precisa de você / encerrado, atividade atual (lendo, editando, terminal, testes,
  git…), título, sala da pasta do projeto, histórico, linha do tempo, tarefas (`update_plan`) e o terminal da conversa.
  O formato das sessões foi conferido instalando o Codex CLI 0.162.1 de verdade (ver `docs/codex.md`).
- **"+ Novo agente" com Claude ou Codex.** O diálogo pergunta a ferramenta (lembra a última escolha; quem não está
  instalado fica desligado). O Codex abre no tmux (`codex --no-daemon`) na pasta escolhida, já marcada como confiável,
  e recebe mensagens pelo escritório como o Claude. Sem login, ele aparece na hora como "precisa de você: conectar sua
  conta OpenAI" e o clique abre o terminal embutido anexado; feito o login num deles, os outros parados no login são
  reabertos sozinhos.
- **Aprovar o Codex pelo escritório.** Quando o Codex pede aprovação (comando fora do sandbox, edição), o agente fica
  "precisa de você" e o painel de permissão mostra o comando e o motivo: **Aprovar**, **Aprovar e não perguntar de
  novo** (quando o Codex oferece) ou **Recusar** (com motivo). O Habblaud lê a tela do tmux e manda a tecla certa
  (`y`, `p`/`a`, `Esc`), conferindo a tela de novo antes de digitar. Fora do tmux, o pedido aparece e leva ao terminal.
- **Retomar conversas do Codex.** O histórico lista as conversas do Codex dos últimos 7 dias e o **Retomar** abre
  `codex resume` na pasta original.
- **GitHub no escritório.** Botão **GitHub** na barra (ou no **⋯**): **Conectar GitHub** abre o terminal embutido com
  `gh auth login --web` (o link e o código aparecem lá, com o link clicável inteiro) e, logado, configura o git
  (`gh auth setup-git`, nome e e-mail). Depois: o @usuário, **Clonar repositório** (lista os seus repositórios, clona em
  `~/projetos/<nome>` e oferece abrir um agente Claude ou Codex lá), **Novo repositório a partir de uma pasta** de
  `~/projetos` (privado por padrão, com confirmação antes de criar e enviar) e os seus PRs abertos. Tudo pelo `gh` no
  seu usuário: o token nunca passa pelo Habblaud. Mesma trava do terminal embutido; `HABBLAUD_GITHUB=0` desliga.
- A missão **Leve para o GitHub** ganhou o botão **Abrir o GitHub do escritório** e continua concluindo só com
  repositório remoto configurado e push feito de verdade.

### Alterado

- **Missão 0: "Conecte sua conta do Claude ou da OpenAI (Codex)".** Conclui com qualquer uma das duas; o quadro tem
  **Fazer login agora (Claude)** e **Conectar a OpenAI (Codex)** (`codex login --device-auth`).

## [0.7.1] - 2026-10-14

### Corrigido

- **Conversa de agente recém-aberto.** Um agente aberto pelo **+ Novo agente** (ou que estava em configuração/login)
  ficava preso em "Este agente ainda não tem conversa" mesmo depois de conversar: o terminal da conversa era aberto
  antes de existir o transcript, o servidor respondia "não encontrado" e a página desistia. Agora o terminal abre
  vazio e a conversa entra sozinha quando a primeira mensagem chega, no mesmo boneco.

## [0.7.0] - 2026-10-14

### Adicionado

- **Terminal embutido: um shell de verdade dentro do escritório.** O botão **Terminal** da barra superior (ou a tecla
  à esquerda do `1`: `` ` `` no teclado americano, `'` no ABNT2) abre uma janela com um terminal completo, como o seu
  usuário (nunca root). Cada aba é uma sessão tmux (`terminal-1`, `terminal-2`…): recarregar a página ou fechar o
  navegador não mata nada, e a mesma aba abre no VS Code com `tmux attach -t terminal-1`. Abas, cópia e cola
  (`Ctrl+C` com texto selecionado copia, sem seleção interrompe como sempre; `Ctrl+V`, `Ctrl+Shift+V`, `⌘C`/`⌘V` no
  Mac e menu do botão direito), roda do mouse rolando o histórico, janela que se arrasta, redimensiona e maximiza
  lembrando a posição, tema do escritório e, no celular, tela cheia com uma barra de teclas (Esc, Tab, Ctrl+C, setas,
  copiar e colar). Só existe com o Habblaud acessível apenas pelo próprio computador (a mesma trava do terminal da
  conversa), no Linux, fora do modo demonstração; `HABBLAUD_SHELL=0` desliga.
- **Links longos inteiros.** No terminal embutido, uma URL quebrada em várias linhas (como a do login do Claude Code)
  é reconhecida inteira: clicar em qualquer pedaço abre a URL completa em outra aba, e o botão direito tem **Copiar
  link**. No terminal da conversa, as URLs viram links clicáveis com o endereço completo (antes saíam cortadas ao
  copiar ou abrir).
- **Agentes novos aparecem na hora, mesmo sem login.** Um agente aberto pelo **+ Novo agente** que ainda está na
  primeira execução do Claude Code (escolha de tema, login) aparece na mesa como "precisa de você: conectar sua conta
  do Claude"; clicar nele abre o terminal embutido já anexado à sessão dele, para terminar ali mesmo. Antes o
  escritório continuava "vazio" e não dava para saber que faltava o login.
- **Login vale para todos os agentes.** Quando o login (e a configuração inicial do Claude) termina num agente, os
  outros que estavam parados pedindo login são reabertos sozinhos na mesma pasta, com o mesmo nome e boneco, já
  prontos. Agentes com conversa e a sessão que você está olhando nunca são reiniciados.
- **Missão 0 com "Fazer login agora":** abre o terminal embutido já rodando o `claude` para escolher o tema e entrar
  com a conta. O escritório vazio também oferece **+ Novo agente** e **Abrir o terminal**.
- **Botão VS Code** na barra superior quando o escritório na nuvem informa o endereço (`HABBLAUD_VSCODE_URL`); sem a
  variável, o botão não aparece.

### Alterado

- **Painel lateral e feed vêm recolhidos.** Na primeira visita (e no celular, sempre) os dois começam recolhidos; a
  escolha fica salva. Recolhido, o botão do painel lateral mostra quantos agentes precisam de você. Atalhos `[` e `]`.
  No celular, o quadro de missões começa recolhido na etiqueta do canto.
- **Barra superior que cabe na tela.** O que não cabe vai para o menu **⋯** (com o nome de cada botão), na ordem: câmera,
  timelapse, Meu dia, histórico, feed, ajuda. Nada se sobrepõe em 1280, 1024, 768 ou 390 px.
- **Abrir terminal** de um agente em configuração abre o terminal embutido da sessão dele (não há conversa ainda).

## [0.6.0] - 2026-10-14

### Adicionado

- **Missões no escritório.** Um quadro de cortiça na recepção abre o quadro de missões: uma por vez (Conecte sua
  conta do Claude, que se conclui sozinha para quem já tem login, Seu primeiro site, Peça uma melhoria, Um jogo em pixel art, Leve para o GitHub, Uma API com banco), cada uma com um objetivo
  (nunca um pedido pronto) e um exemplo escondido. **Começar missão** cria a pasta em `~/projetos` e abre um agente
  lá com a caixa de mensagem vazia. A conclusão é detectada sozinha (ou pelo botão **Concluí**), solta confete em
  pixel, sem som, paga moedas na **Caixa do escritório** (uma vez por missão) e libera a próxima. XP, nível e dias
  seguidos. O quadro pode ser recolhido e nunca bloqueia o escritório. Só com o Habblaud acessível apenas pelo
  próprio computador.

## [0.5.0] - 2026-10-14

### Adicionado

- **Retomar sessões encerradas.** No histórico, as sessões encerradas da conta principal têm o botão **Retomar**: abre
  um agente novo no tmux com `claude --resume`, na pasta original da sessão, com o mesmo nome e boneco, e a câmera vai
  até ele quando chegar. Depois de reiniciar a máquina, dá para trazer os agentes de volta sem abrir terminal.

### Alterado

- **Mensagens pelo terminal com aviso visível.** "Mensagem enviada para …" ou o motivo da falha aparecem como aviso na
  tela (antes, só para leitores de tela). Num agente fora do tmux, `Enter` na caixa explica por que ele não recebe
  mensagens daqui. O selo **somente leitura** e o cursor de bloqueio só aparecem quando a caixa não envia; nos agentes
  que recebem mensagens, o selo vira **envia mensagens**.

## [0.4.0] - 2026-10-08

### Alterado

- **O CodeTown agora se chama Habblaud.** O nome muda em toda parte: interface, logotipo, placa da recepção, totem da
  entrada, prévia de link, repositório (`github.com/marmottajr/habblaud`), marketplace e plugins do Claude Code
  (`habblaud` e `habblaud-permissoes`, com o comando `/habblaud`), variáveis de ambiente (`HABBLAUD_*`), pasta de
  estado (`~/.habblaud`) e Docker (container e imagem `habblaud`, volume `habblaud-data`).
- Para quem vem do CodeTown: rode `npm run mod:install` uma vez (troca o marketplace e os plugins antigos pelos novos
  em cada conta) e `npm run docker:up` (tira o container antigo e copia os nomes, a linha do tempo e as estatísticas
  do volume `codetown_codetown-data` para o novo, sem apagar o antigo). A pasta `~/.codetown` e as preferências e
  moedinhas guardadas no navegador passam para os nomes novos sozinhas. As variáveis `CODETOWN_*` não valem mais:
  renomeie para `HABBLAUD_*` no `.env` (o servidor e o `docker:up` avisam). Detalhes no README, em
  "Vindo do CodeTown".

## [0.3.2] - 2026-10-08

### Corrigido

- Quando um terminal fechava e a sala dele era desmontada, ficava um jardim no meio do prédio, entre salas. Agora a
  sala mais distante se muda para a vaga: é montada lá, ainda apagada; o primeiro a chegar acende a luz e cada um
  volta para a mesma mesa. O endereço antigo apaga e é desmontado, e o prédio encolhe. Uma sala que abre ocupa a
  primeira vaga livre, e a carga inicial já vem sem buracos.
- Quem estava a caminho de algo que deixou de existir, como o bebedouro de uma coluna do corredor que sumiu quando o
  prédio encolheu, era teletransportado. Agora muda de plano e segue andando.

## [0.3.1] - 2026-10-08

### Corrigido

- Quem cochilava na mesa (ocioso há mais de 10 minutos) e levantava para uma roda, uma festa ou um passeio saía
  andando com o "zzz" na cabeça. Agora o "zzz" só aparece enquanto o personagem dorme.

## [0.3.0] - 2026-10-08

### Adicionado

- **Mod do Habblaud para o Claude Code** (2.1.287 ou mais novo): `npm run mod:install` instala, em cada conta, o
  marketplace desta pasta com o mod `habblaud` (uso de 5 horas e semanal ao vivo, uma linha no terminal quando outra
  sessão precisa de você e o comando `/habblaud`) e o plugin `habblaud-permissoes` (responder permissões pelo
  escritório; `-- --sem-permissoes` deixa de fora). `npm run mod:status` mostra o que cada conta tem e
  `npm run mod:uninstall` tira tudo. O `npm run docker:up` atualiza o mod de quem já instalou.

### Mudado

- O tap de statusline (`npm run usage:install`) e o hook de permissão (`npm run hooks:install`) viram o jeito antigo,
  para o Claude Code anterior ao 2.1.287. O `npm run mod:install` tira os dois da conta (com backup), porque o mod faz
  o mesmo. A interface e o README passam a ensinar o `npm run mod:install`.
- O script do hook de permissão mudou para `mod/habblaud-permissoes/hooks/permission-hook.mjs`. O caminho antigo
  (`scripts/permission-hook.mjs`) virou um atalho, então quem instalou o hook antes continua funcionando.
- Em Contas e uso, a origem dos números diz quando vêm do mod ("ao vivo (mod do Habblaud)").
- O leitor do uso ao vivo ignora um arquivo lido pela metade e fica com o último número bom, em vez de esconder a
  conta por um ciclo.

## [0.2.0] - 2026-10-08

Primeira versão publicada.

### Adicionado

- **Versão e atualizações:** a versão em uso aparece na barra superior e em Configurações › Sobre. A cada 6 horas o
  Habblaud confere as releases no GitHub; quando sai uma versão nova, aparece o selo **Nova versão**, com um aviso e o
  link do que mudou. `HABBLAUD_UPDATE_CHECK=0` desliga a consulta.
- **Meu dia** (tecla M): para onde foi o tempo dos agentes, quanto tempo esperaram você, tokens e custo, com 30 dias
  de histórico.
- **GitHub no escritório:** PR aberto ou mergeado e release publicada viram festa na sala; CI vermelho liga o alarme,
  até um CI verde.
- **Responder pelo escritório** (tecla P): com o hook instalado (`npm run hooks:install`), aprovar, recusar ou
  "sempre permitir" pedidos de permissão sem ir ao terminal. Só com acesso local.
- **Timelapse do dia** (tecla L): o escritório reproduz o dia em alta velocidade.
- **Terminal somente leitura** (tecla T): a conversa de cada agente, ao vivo, no estilo do Claude Code, com busca,
  filtro, botão de copiar e histórico das sessões dos últimos 7 dias. Só com acesso local.
- **Dia e noite** pela hora local e **sons** sintetizados no navegador (desligados por padrão).
- **Vida social:** quem está à toa se junta em rodas (TV, videogame, pingue-pongue, papo na copa, jokenpô valendo
  moedinhas), com personalidades, amizades e rivalidades.
- **Esperando o shell:** o agente que espera um comando longo fica na mesa com a ampulheta, e a espera vira uma gag.
- Forks de sessão aparecem no escritório.
- A página aberta se recarrega sozinha quando o servidor passa a servir outra versão.
- O container usa o fuso horário do computador.
- **O escritório:** cada projeto aberto no Claude Code vira uma sala e cada sessão, um personagem com nome próprio.
  Subagentes chegam, trabalham e entregam ao principal. Mostra as duas contas, com o uso de 5 horas e semanal de
  cada uma (tap de statusline), além de feed de atividade, avisos e modo demonstração. Roda no Node ou no Docker local.

[Não lançado]: https://github.com/schneider-gif/habblaud/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/schneider-gif/habblaud/releases/tag/v0.9.0
[0.6.0]: https://github.com/schneider-gif/habblaud/releases/tag/v0.6.0
[0.5.0]: https://github.com/schneider-gif/habblaud/releases/tag/v0.5.0
[0.4.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.4.0
[0.3.2]: https://github.com/marmottajr/habblaud/releases/tag/v0.3.2
[0.3.1]: https://github.com/marmottajr/habblaud/releases/tag/v0.3.1
[0.3.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.3.0
[0.2.0]: https://github.com/marmottajr/habblaud/releases/tag/v0.2.0
