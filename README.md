# Fazenda Infinita · Fase 5 (amigos, visitas e ajuda) + conforto de jogo

Jogo de fazenda em primeira pessoa (só computador). O jogo roda **no servidor**: plantas, trabalhadores, tempo, mercado e caixas são decididos lá. O navegador desenha e pede ações.

## Como rodar

Precisa do [Node.js](https://nodejs.org) 22 ou mais novo (testado no 24).

```bash
npm install
npm run dev
```

O segundo comando sobe o **servidor do jogo** (porta 3001) e o **site** (Vite) juntos e mostra o endereço do site, normalmente http://localhost:5173 (se a porta estiver ocupada, outra, como 5174). Abra esse endereço, **crie uma conta** e jogue. Ctrl-C encerra os dois.

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Servidor + site, recarregando ao editar |
| `npm run server` | Só o servidor |
| `npm run build` | Gera o site final em `dist/` |
| `npm start` | Sobe o servidor, que também serve o site de `dist/` em http://127.0.0.1:3001 |
| `npm test` | Roda os testes (regras, rede, contas, servidor ponta a ponta) |
| `npm run typecheck` | Confere os tipos do TypeScript |
| `npm run bot` | Robô de teste: entra como outro jogador (`vendedor_teste`), anda até o mercado e faz anúncios, para você testar a compra sozinho. Só para desenvolvimento |
| `npm run bot:amigo -- seu_nome` | Robô de teste: entra como `amigo_teste`, pede amizade a `seu_nome`, aceita pedidos e libera "assistir e ajudar", para você testar visitas sozinho. Só para desenvolvimento |

## Contas e progresso

- Você cria uma conta com **nome e senha**. O progresso fica no servidor (PostgreSQL, ou o arquivo `data/fazenda.sqlite` se você não configurar um), e acompanha a conta.
- O servidor salva sozinho **em segundo plano**: a cada novo dia, a cada minuto (só se algo mudou), ao abrir o **Menu (Tab)** e quando você sai. O jogo não espera o banco responder, então salvar não trava nada. O botão **Salvar** do menu salva na hora.
- **O tempo só passa enquanto você está conectado e olhando.** Ao sair, ou ao esconder a aba, a fazenda para.
- Uma conta tem uma conexão por vez: entrar em outro lugar derruba a anterior.
- **Esqueci a senha:** ao criar a conta o jogo mostra **uma vez** um **código de recuperação** (como `7K2M-XQ9P-4DRT-HW6N`). Na tela de entrada, aba **Esqueci a senha**, escreva o nome, o código e uma senha nova: a senha é trocada, todas as sessões antigas caem (inclusive o jogo aberto) e você recebe **outro código**, porque cada um vale uma vez. O código aceita minúsculas, espaços e traços. O banco guarda só um resumo dele.
- Perdeu o código, ou a conta é de antes deste recurso? Entre normalmente e use o botão **Conta**: com a senha você gera um novo (o anterior deixa de valer).
- Não há e-mail na conta. **Quem perde a senha e o código perde a conta**: não há outro jeito de provar que ela é sua.
- **Backup:** no SQLite, copie `data/fazenda.sqlite` com o servidor parado; no PostgreSQL, use `pg_dump`.

## Banco de dados: PostgreSQL ou SQLite

- **Sem configurar nada** o jogo usa o arquivo SQLite (`data/fazenda.sqlite`), bom para testar.
- **Com PostgreSQL:** crie um banco vazio (por exemplo `CREATE DATABASE fazenda;`) e diga o endereço em `DATABASE_URL`. O jeito mais simples é copiar `.env.example` para `.env` e preencher:

```
DATABASE_URL=postgres://usuario:senha@127.0.0.1:5432/fazenda
```

  As tabelas são criadas sozinhas na primeira vez. O `.env` não vai para o controle de versão.
- Os dois bancos usam **o mesmo SQL e os mesmos testes**. Para rodar os testes também no PostgreSQL (use um banco **só de teste**: ele é esvaziado!):

```bash
TEST_DATABASE_URL=postgres://usuario:senha@127.0.0.1:5432/fazenda_test npx vitest run --no-file-parallelism
```

- **Não há migração automática de SQLite para PostgreSQL.** Contas criadas no arquivo SQLite não aparecem no PostgreSQL. Faça a troca antes de ter jogadores de verdade.
- O jogo de cada pessoa vive na memória de **um** servidor; o banco guarda o estado. Não rode dois servidores no mesmo banco.
- Por dentro: todas as chamadas ao banco são assíncronas. As operações que mexem no jogo e no banco juntos (comprar, visitar, salvar, fim do dia) entram numa **fila única** (`src/server/lock.ts`) e o relógio dos jogos espera enquanto há algo nela, para que um passo do relógio nunca apareça no meio de uma compra que será desfeita.

## Mercado entre jogadores

Perto do Mercado (barraca vermelha, tecla **E**), aba **Jogadores**:

- **Comprar:** anúncios de outros jogadores, com filtro por tipo (itens, peças, trabalhadores, aluguéis, ouro). Mostra o preço médio das últimas vendas do mesmo item.
- **Vender:** itens da mochila, peças de equipamento guardadas, ouro (vendido por prata) e trabalhadores. Você escolhe o preço total e a moeda (prata ou ouro).
- **Meus anúncios:** acompanhe e cancele. Um anúncio aberto fica guardado: o item sai da sua mochila ao anunciar e volta se você cancelar ou se o anúncio vencer.
- **Aluguéis:** alugue o trabalhador por 1 a 14 dias (preço por dia). Quem aluga paga tudo antes. O dono recebe um dia por dia de jogo de quem alugou, menos a taxa. Se o dono chamar de volta, quem alugou recebe de volta os dias que sobraram.

Regras:

- **Taxa de 5%** sobre o que o vendedor recebe (mínimo 1; preço 1 não paga). A taxa some do jogo: tira moeda de circulação.
- **Quem vende sempre recebe:** com o vendedor conectado o dinheiro entra na hora; desconectado, fica no **correio** e entra quando ele voltar. O mesmo vale para anúncios que vencem (7 dias) e trabalhadores devolvidos.
- **Trabalhadores:** ao vender ou alugar, os itens e as peças dele voltam para o seu armazém e a sua mochila. Quem recebe ele recebe **sem nada**. Se o nome já existir na fazenda de quem recebe, ganha um número (ou o nome do dono, no aluguel).
- **Segurança das trocas:** comprar é tudo ou nada. A prata do comprador, o item, o pagamento do vendedor e o fim do anúncio entram no banco numa única transação, junto com o salvamento do comprador. Se algo falhar, nada muda para ninguém. Dois compradores no mesmo anúncio: só o primeiro leva.
- Limites: 20 anúncios abertos por pessoa, preço de 1 a 10.000.000 de prata (100.000 de ouro), não dá para comprar o próprio anúncio nem vender trabalhador alugado.
- Comprar, vender e cancelar só valem perto do mercado. Recomeçar o jogo devolve os trabalhadores alugados ao dono e os dias que sobraram a quem alugou.

## Menu, modo automático e armazém

- **Tab** abre o menu, que concentra o que antes eram os botões do alto da tela: seu status (prata, ouro, aluguel por dia, energia, vida, níveis de ferramenta), as janelas do jogo e o **Histórico**. Tab de novo fecha.
- **Histórico:** o que aconteceu por último (dormir, aluguel pago, avisos de amigos e do mercado) fica ali, e não na tela. Um pontinho vermelho no botão Menu avisa quando há coisa nova. Só os resultados das suas ações (plantar, regar, erros) aparecem por uns segundos.
- **Relógio e calendário:** o canto superior esquerdo tem um calendário com o dia e um relógio de ponteiros (escurece à noite). As barras de energia e vida aparecem só no modo normal; no menu elas ficam sempre.
- **Recomeçar** só aparece no menu quando você quebrou: menos de 50 de prata, nada plantado, sem sementes e sem batatas para vender.
- **No modo automático** você abre o menu e usa **Mercado, Cozinha, Armazém, Personagem e Inventário** de dentro de casa.
- **Compras vão para o armazém** (se ele encher, o resto vai para a mochila). Sementes e pão têm campo de **quantidade** com o botão **Máx**, que é o menor entre o que cabe e o que a sua prata paga. O que chega do mercado dos jogadores também vai para o armazém.
- **Cozinha:** escolha quantas batatas assadas fazer (2 batatas cada); o resultado cai no armazém.
- **Mandar um trabalhador buscar um item:** na janela do Armazém, escolha o trabalhador, o item e a quantidade. A ordem vale antes das tarefas dele (ele vai ao armazém, pega o que cabe na mochila dele e volta ao trabalho). Funciona também no modo automático.
- **Níveis:** cada nível de ferramenta, do jogador e dos trabalhadores, reduz a energia gasta pela ação (até metade no nível 100). Eles sobem com o uso.

## Amigos, visitas e ajuda

Tecla **F** (ou botão **Amigos**):

- **Pedir amizade** pelo nome. O outro aceita ou recusa; se os dois pedirem ao mesmo tempo, viram amigos na hora. Quem está fora recebe o aviso no correio.
- **Permissão por amigo, dada por você:** *Nada* (padrão), *Assistir* ou *Assistir e ajudar*. É sobre a **sua** fazenda: o que o seu amigo pode fazer lá.
- **Visitar:** só quando o amigo está **conectado**, em casa, deixou você assistir e há vaga (até 5 visitantes por fazenda). A câmera vira a de espectador na fazenda dele; você vê o tempo dele passar. **Enquanto você visita, o seu próprio jogo fica parado.** A tecla **E** (ou o botão) volta para casa.
- **Ajudar** (só com permissão 2): escolha **Regar** ou **Colher** na barra de baixo e clique num solo. Usa o **seu** regador/foice e a **sua** energia (e sobem o seu nível de ferramenta). A colheita vai para o **armazém do dono**. Ao fim da visita ele recebe um resumo do que foi feito.
- O visitante **não vê** a prata, o ouro, a mochila, o armazém, as dívidas nem os itens dos trabalhadores do dono: o servidor nem manda esses dados.
- Se o dono sair, tirar a permissão, remover ou bloquear, a visita acaba na hora. **Bloquear** desfaz a amizade e impede novos pedidos (quem foi bloqueado não é avisado).
- **Emprestar trabalhador a um amigo:** em Mercado → Jogadores → Vender, escolha "só (amigo)" no aluguel. O anúncio é privado (só ele vê e aceita) e pode custar **0** (de graça). O trabalhador volta no fim dos dias, ou quando você chamar de volta.

Fica para a Fase 6 (a decidir): **atrapalhar** (PvP) e qualquer ação que prejudique a fazenda de outro jogador.

## Publicar (Fly.io + Cloudflare + Supabase)

- **Banco:** o Supabase (veja "Banco de dados"). Use a `DATABASE_URL` da **conexão direta**; o Fly alcança por IPv6.
- **Servidor:** o Fly.io roda a imagem do `Dockerfile` (Node serve a API, o WebSocket e o site compilado). `fly.toml` já pede uma máquina só, sempre ligada, em São Paulo.
  1. Instale o `flyctl` e entre: `fly auth login`.
  2. Na pasta do jogo: `fly launch --no-deploy --copy-config` (escolha um nome de app) e ajuste `ALLOWED_ORIGINS` no `fly.toml` para o seu domínio.
  3. Guarde o segredo do banco (ele não vai no `fly.toml`): `fly secrets set DATABASE_URL='postgresql://...'`.
  4. `fly deploy` e depois `fly scale count 1`. **Nunca mais de uma máquina.**
- **Cloudflare:** aponte o seu domínio para o app (CNAME para `nome.fly.dev`, com o proxy ligado) e deixe o SSL em "Full (strict)". WebSocket passa sem configuração extra. Com o proxy ligado, o IP real de cada jogador vem em `cf-connecting-ip`; é isso que `CLIENT_IP_HEADER` usa. **Sem proxy na frente, apague essa variável**, porque quem chega direto poderia inventar o cabeçalho e escapar do limite de tentativas.

## Segurança do servidor

- Senhas nunca são guardadas: só um resumo com sal (scrypt). O token de sessão fica no navegador e o banco guarda só o resumo dele (válido por 30 dias).
- Login e cadastro têm limite de tentativas por endereço (10 por minuto), e a resposta é a mesma para nome inexistente e senha errada.
- Toda mensagem do navegador é validada (formato, tipos, limites). Mensagens grandes ou em excesso derrubam a conexão. Antes do login, nada é aceito.
- O servidor confere cada ação: estar perto da casa, do mercado, do armazém ou do trabalhador, ter prata ou ouro, etc. Uma mudança feita só no navegador (por exemplo, a prata na tela) não vale nada e é desfeita na próxima sincronização (a cada ~10 segundos).
- Visitas e ajuda são conferidas no servidor a cada ação: amizade, permissão **atual** do dono, o visitante estar visitando, ferramenta, energia e o solo existir. O dono pode mudar a permissão a qualquer momento.
- Por padrão o servidor só aceita conexões **deste computador** (`127.0.0.1`) e só de páginas em `localhost`.

Variáveis de ambiente do servidor (ou no arquivo `.env`): `PORT` (3001), `HOST` (127.0.0.1; use `0.0.0.0` para outras máquinas), `DATABASE_URL` (PostgreSQL), `DB_PATH` (arquivo SQLite, se não houver `DATABASE_URL`), `ALLOWED_ORIGINS` (endereços extras, separados por vírgula), `CLIENT_IP_HEADER` (atrás de proxy: cabeçalho com o IP real).

- Recuperar a senha tem limite próprio: 5 tentativas por minuto por endereço e 10 por hora por conta, e a mesma resposta para nome inexistente, conta sem código e código errado.

**Antes de abrir para outras pessoas** ainda falta: HTTPS (atrás de um proxy como Caddy ou nginx) e um servidor na internet.

## Controles

| Tecla | Ação |
| --- | --- |
| Tab | Menu: status, inventário, personagem, terrenos, trabalhadores, armazém, cozinha, mercado, amigos, histórico, conta, salvar |
| W A S D | Andar (nunca gasta energia) |
| Mouse | Olhar (clique na tela para capturar; Esc solta) |
| Clique ou Espaço | Usar o item da hotbar |
| E | Interagir: casa, armazém, mercado, trabalhadores |
| I | Inventário e hotbar |
| C | Personagem: atributos, níveis de ferramenta e equipamento |
| L | Terrenos: comprar, ver aluguel e pagar dívida |
| T | Status, equipamento e prioridades dos trabalhadores |
| F | Amigos: pedidos, permissões e visitas |
| 1 a 9 | Escolher slot da hotbar |
| H | Mostrar ou esconder a lista de controles (o jogo lembra a sua escolha) |

## Como funciona a rede

1. O navegador manda o que você aperta (andar e para onde olha) e **ações** (usar, comprar, abrir caixa...).
2. O servidor roda o jogo e manda de volta só o que mudou, umas 10 vezes por segundo.
3. O navegador mantém uma **cópia** do jogo: anima os trabalhadores e prevê o seu próprio passo entre uma atualização e outra, mas o servidor sempre corrige.

## Como o código está organizado

```
src/core     Regras do jogo. Não usa Three.js, navegador nem rede. Roda igual no servidor e no navegador.
  game.ts      o jogo inteiro: tempo, modos, ações, mercado, cozinha
  farm.ts      solos, crescimento e morte por falta de água
  lands.ts     terrenos, preços e aluguéis
  boxes.ts     caixas, chances e trabalhadores sorteados
  market.ts    tipos e regras do mercado entre jogadores (taxa, limites)
  social.ts    tipos e limites de amigos, permissões e visitas
  workers.ts   a IA dos trabalhadores
  equipment.ts, abilities.ts, stats.ts   equipamento, habilidades e atributos
  items.ts, player.ts, clock.ts, layout.ts, rng.ts
  save.ts      transformar o jogo em dados e de volta, com validação
src/net      O que o navegador e o servidor dizem um ao outro
  protocol.ts  mensagens e validação de tudo que chega pela rede
  snapshot.ts  diferenças que o servidor manda e como o navegador aplica
  remote.ts    conexão do navegador e cópia do jogo
  account.ts   login, cadastro e token
src/server   Servidor (Node.js)
  app.ts       HTTP (contas) e WebSocket (jogo), um jogo por conta conectada
  session.ts   o jogo de uma pessoa conectada
  commands.ts  confere e executa cada ação
  market.ts    o mercado: anúncios, compras, correio e aluguéis, em transações
  social.ts    amigos, bloqueio, permissões, visitas e ajuda
  auth.ts      senhas, tokens e códigos de recuperação
  db.ts        a interface do banco e o SQL único, mais o SQLite
  pgdb.ts      a conexão com o PostgreSQL
  lock.ts      a fila das operações que mexem no jogo e no banco
src/render   Cena 3D (Three.js)
src/ui       Interface: HUD, janelas, tela de entrada, mercado dos jogadores
```

Os testes ficam ao lado do que testam (`*.test.ts`).
