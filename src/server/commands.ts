import type { Game } from '../core/game';
import type { Inventory } from '../core/items';
import { STORE_CAP } from '../core/items';
import type { Command, CommandResult, Where } from '../net/protocol';
import type { Market, MarketSession } from './market';
import type { GameSession } from './session';
import type { Social } from './social';

export interface CommandHooks {
  /** Salva agora. Devolve false se não deu. */
  save(): Promise<boolean>;
  /** O mercado entre jogadores. Em testes simples pode faltar. */
  market?: Market;
  social?: Social;
  session?: MarketSession & Partial<Pick<GameSession, 'visiting'>>;
}

/** A ação não é permitida agora (longe do lugar, modo errado...). Vira uma mensagem para o jogador. */
class Refused extends Error {}

/** Ações que valem mesmo enquanto se visita outra fazenda. */
const VISIT_OK = new Set<string>(['social', 'friendRequest', 'friendAnswer', 'friendRemove', 'friendBlock', 'friendUnblock', 'friendPerm', 'leaveVisit', 'help', 'save', 'paused']);

function need(condition: boolean, text: string): void {
  if (!condition) throw new Refused(text);
}

function place(game: Game, where: Where): { inv: Inventory; cap: number; label: string } {
  if (where.at === 'bag') return { inv: game.player.inv, cap: game.carryCap, label: 'bag' };
  if (where.at === 'store') {
    need(game.isNear('store') || game.mode === 'spec', 'Chegue perto do armazém.');
    return { inv: game.store, cap: STORE_CAP, label: 'store' };
  }
  const w = game.workers.find((x) => x.name === where.name);
  need(!!w, 'Esse trabalhador não existe.');
  need(game.workerIsNear(w!), 'Chegue perto de ' + w!.name + ' para trocar itens.');
  return { inv: w!.inv, cap: w!.cap, label: 'worker' };
}

/**
 * Executa uma ação do jogador no jogo do servidor. O navegador só pede; aqui se confere se pode.
 * As mensagens do jogo durante a ação voltam na resposta, em vez de ir como aviso solto.
 */
export async function runCommand(game: Game, cmd: Command, hooks: CommandHooks): Promise<CommandResult> {
  const said: string[] = [];
  const previous = game.onMessage;
  game.onMessage = (t) => said.push(t);
  try {
    const spoken = () => said[said.length - 1] ?? '';
    const worker = (name: string) => {
      const w = game.workers.find((x) => x.name === name);
      need(!!w, 'Esse trabalhador não existe.');
      return w!;
    };
    // no modo automático você está dentro de casa e usa o mercado, a cozinha e o armazém à distância
    const atHouse = game.isNear('house') || game.mode === 'spec';
    const atShop = game.isNear('shop') || game.mode === 'spec';
    // visitando, só as ações de amigos, a ajuda e sair da visita funcionam
    const v = hooks.session?.visiting;
    if (v && !VISIT_OK.has(cmd.t)) throw new Refused('Você está visitando ' + v.host.username + '. Volte para casa antes (tecla E).');
    switch (cmd.t) {
      case 'use':
        need(game.mode === 'fp', 'No modo automático você só assiste.');
        need(!game.paused, 'Feche a janela primeiro.');
        game.useSelected();
        return { ok: true, message: spoken() };
      case 'select':
        game.selectSlot(cmd.slot);
        return { ok: true, message: '' };
      case 'assign':
        game.assignSlot(cmd.key);
        return { ok: true, message: '' };
      case 'sleep':
        need(game.mode === 'fp', 'Saia do modo automático primeiro.');
        need(game.isNear('house'), 'Chegue perto da porta da casa.');
        game.endDay('sleep');
        return { ok: true, message: spoken() };
      case 'auto':
        need(game.mode === 'fp', 'Você já está no modo automático.');
        need(game.isNear('house'), 'Chegue perto da porta da casa.');
        game.enterAuto();
        return { ok: true, message: spoken() };
      case 'exitAuto':
        need(game.mode === 'spec', 'Você não está no modo automático.');
        game.exitAuto();
        return { ok: true, message: spoken() };
      case 'speed':
        game.setSpeed(cmd.speed);
        return { ok: true, message: '' };
      case 'paused':
        game.paused = cmd.value;
        return { ok: true, message: '' };
      case 'cook':
        need(atHouse, 'Chegue perto da porta da casa.');
        return { ok: true, message: game.cook(cmd.n) };
      case 'order': {
        need(game.mode === 'spec' || game.workerIsNear(worker(cmd.worker)), 'Chegue perto de ' + cmd.worker + ' ou use o modo automático.');
        return { ok: true, message: game.orderFetch(worker(cmd.worker), cmd.key, cmd.n) };
      }
      case 'sellPotatoes':
        need(atShop, 'Chegue perto do mercado.');
        return { ok: true, message: game.sellPotatoes(cmd.n) };
      case 'sellStore':
        need(atShop, 'Chegue perto do mercado.');
        return { ok: true, message: game.sellStorePotatoes() };
      case 'buy':
        need(atShop, 'Chegue perto do mercado.');
        return { ok: true, message: game.buy(cmd.key, cmd.n) };
      case 'buyGear':
        need(atShop, 'Chegue perto do mercado.');
        return { ok: true, message: game.buyGear(cmd.id) };
      case 'buyGold':
        need(atShop, 'Chegue perto do mercado.');
        return { ok: true, message: game.buyGold(cmd.n) };
      case 'openBox': {
        need(atShop, 'Chegue perto do mercado.');
        const r = game.openBox(cmd.kind);
        return { ok: true, message: r.message, box: r.result };
      }
      case 'buyLand':
        return { ok: true, message: game.buyLand() };
      case 'payDebt':
        return { ok: true, message: game.payDebt(cmd.index) };
      case 'equip':
        return { ok: true, message: game.equip(cmd.id) };
      case 'unequip':
        return { ok: true, message: game.unequip(cmd.slot) };
      case 'give':
        return { ok: true, message: game.giveGear(worker(cmd.worker), cmd.id) };
      case 'take':
        return { ok: true, message: game.takeGear(worker(cmd.worker), cmd.slot) };
      case 'move': {
        const a = place(game, cmd.from);
        const b = place(game, cmd.to);
        const okPair = (a.label === 'bag' && b.label !== 'bag') || (b.label === 'bag' && a.label !== 'bag');
        need(okPair, 'Só dá para passar itens entre a sua mochila e o armazém ou um trabalhador.');
        return { ok: true, message: game.moveItems(a.inv, b.inv, b.cap, cmd.key, cmd.n) };
      }
      case 'prios': {
        const w = worker(cmd.worker);
        need(game.setPriorities(w, cmd.order, cmd.on), 'Lista de tarefas inválida.');
        return { ok: true, message: '' };
      }
      case 'save': {
        const ok = await hooks.save();
        return { ok, message: ok ? 'Jogo salvo.' : 'Não foi possível salvar agora.' };
      }
      case 'reset': {
        // devolve os trabalhadores alugados antes de apagar tudo: o dono os recebe e você recebe os dias que sobraram
        if (hooks.market && hooks.session) await hooks.market.endRentals(hooks.session);
        game.reset(true);
        const message = spoken();
        if (hooks.market && hooks.session) await hooks.market.deliver(hooks.session.userId);
        return { ok: true, message };
      }
      case 'social': case 'friendRequest': case 'friendAnswer': case 'friendRemove': case 'friendBlock': case 'friendUnblock': case 'friendPerm':
      case 'visit': case 'leaveVisit': case 'help': {
        const { social, session } = hooks;
        need(!!social && !!session && !!(session as unknown as GameSession).username, 'Os amigos estão indisponíveis.');
        const s = session as unknown as GameSession;
        let r: CommandResult;
        switch (cmd.t) {
          case 'social': r = { ok: true, message: '', data: await social!.data(s) }; break;
          case 'friendRequest': r = await social!.request(s, cmd.name); break;
          case 'friendAnswer': r = await social!.answer(s, cmd.name, cmd.accept); break;
          case 'friendRemove': r = await social!.remove(s, cmd.name); break;
          case 'friendBlock': r = await social!.block(s, cmd.name); break;
          case 'friendUnblock': r = await social!.unblock(s, cmd.name); break;
          case 'friendPerm': r = await social!.setPermission(s, cmd.name, cmd.level); break;
          case 'visit': r = await social!.visit(s, cmd.name); break;
          case 'leaveVisit': {
            const was = await social!.leave(s);
            r = { ok: was, message: was ? 'Você voltou para casa.' : 'Você não está visitando ninguém.', data: await social!.data(s) };
            break;
          }
          default: r = await social!.help(s, cmd.action, cmd.i, cmd.j);
        }
        return r;
      }
      case 'market': case 'marketSell': case 'marketBuy': case 'marketCancel': case 'rentRecall': {
        const { market, session } = hooks;
        need(!!market && !!session, 'O mercado dos jogadores está indisponível.');
        need(atShop, 'Chegue perto do mercado.');
        let r: CommandResult;
        if (cmd.t === 'market') r = { ok: true, message: '', data: await market!.data(session!, cmd.kind) };
        else if (cmd.t === 'marketSell') r = await market!.sell(session!, cmd.spec, cmd.price, cmd.currency);
        else if (cmd.t === 'marketBuy') r = await market!.buy(session!, cmd.id);
        else if (cmd.t === 'marketCancel') r = await market!.cancel(session!, cmd.id);
        else r = await market!.recall(session!, cmd.id);
        // avisos do jogo gerados pela ação (por exemplo, o dono recebendo o trabalhador de volta) vão junto
        if (said.length) r = { ...r, message: [r.message, ...said].filter(Boolean).join(' ') };
        if (cmd.t !== 'market') r = { ...r, data: await market!.data(session!) };
        return r;
      }
    }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, message: e.message };
    throw e;
  } finally {
    game.onMessage = previous;
  }
}
