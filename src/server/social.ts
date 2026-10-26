import { READY_AGE } from '../core/farm';
import { ITEMS, STORE_CAP, invWeight } from '../core/items';
import { MAX_FRIENDS, MAX_PENDING, MAX_VISITORS } from '../core/social';
import type { FriendView, HelpAction, Permission, SocialData } from '../core/social';
import type { CommandResult } from '../net/protocol';
import type { Db } from './db';
import type { GameSession } from './session';

const ok = (message: string, data?: unknown): CommandResult => ({ ok: true, message, data });
const fail = (message: string): CommandResult => ({ ok: false, message });

const LEVEL_TEXT = ['nada', 'assistir', 'assistir e ajudar'];

/**
 * Amigos, visitas e ajuda. Quem visita assiste ao jogo do dono em tempo real (só se o dono estiver conectado)
 * e, se o dono deixou, ajuda com as próprias ferramentas e energia. O que o visitante vê não inclui a carteira,
 * a mochila nem o armazém do dono.
 */
export class Social {
  constructor(
    private readonly db: Db,
    private readonly online: (userId: number) => GameSession | undefined,
  ) {}

  async areFriends(a: number, b: number): Promise<boolean> {
    return (await this.db.getFriendship(a, b))?.status === 'accepted';
  }

  /** Avisa a outra pessoa (na hora, se estiver conectada; senão, pelo correio) e manda a tela de amigos se atualizar. */
  private async tell(userId: number, text: string): Promise<void> {
    const s = this.online(userId);
    if (s) {
      s.notify(text);
      s.pokeSocial();
    } else {
      await this.db.insertMail(userId, 'note', { text }, Date.now());
    }
  }

  private async canVisit(s: GameSession, otherId: number): Promise<boolean> {
    const h = this.online(otherId);
    return !!h && h !== s && !s.visiting && !h.visiting && h.visitorCount < MAX_VISITORS && (await this.db.getPermission(otherId, s.userId)) >= 1;
  }

  async data(s: GameSession): Promise<SocialData> {
    const rows = await this.db.friendsOf(s.userId);
    const mine = await this.db.permissionsBy(s.userId);
    const friends: FriendView[] = [];
    for (const r of rows.filter((x) => x.status === 'accepted')) {
      friends.push({
        name: r.otherName,
        online: !!this.online(r.otherId),
        iAllow: mine.get(r.otherId) ?? 0,
        theyAllow: await this.db.getPermission(r.otherId, s.userId),
        canVisit: await this.canVisit(s, r.otherId),
      });
    }
    return {
      friends,
      incoming: rows.filter((r) => r.status === 'pending' && r.requestedBy !== s.userId).map((r) => r.otherName),
      outgoing: rows.filter((r) => r.status === 'pending' && r.requestedBy === s.userId).map((r) => r.otherName),
      blocked: (await this.db.blockedBy(s.userId)).map((b) => b.name),
      visitors: s.visitorNames,
      visiting: s.visiting?.host.username ?? null,
    };
  }

  private async result(s: GameSession, r: CommandResult): Promise<CommandResult> {
    return { ...r, data: await this.data(s) };
  }

  // ---------- amizades ----------

  async request(s: GameSession, name: string): Promise<CommandResult> {
    const other = await this.db.findUser(name);
    if (!other) return fail('Não existe jogador com esse nome.');
    if (other.id === s.userId) return fail('Você não pode ser amigo de si mesmo.');
    if (await this.db.isBlocked(s.userId, other.id)) return fail('Você bloqueou ' + other.username + '. Desbloqueie antes de mandar um pedido.');
    // quem foi bloqueado não descobre: o pedido parece enviado
    if (await this.db.isBlocked(other.id, s.userId)) return this.result(s, ok('Pedido de amizade enviado para ' + other.username + '.'));
    const existing = await this.db.getFriendship(s.userId, other.id);
    if (existing?.status === 'accepted') return fail('Vocês já são amigos.');
    if (existing) {
      if (existing.requestedBy === s.userId) return fail('Você já mandou um pedido para ' + other.username + '.');
      // ele já tinha pedido: os dois querem, então fecha a amizade
      return this.answer(s, other.username, true);
    }
    const rows = await this.db.friendsOf(s.userId);
    if (rows.filter((r) => r.status === 'accepted').length >= MAX_FRIENDS) return fail('Você chegou ao limite de ' + MAX_FRIENDS + ' amigos.');
    if (rows.filter((r) => r.status === 'pending' && r.requestedBy === s.userId).length >= MAX_PENDING) return fail('Você já tem ' + MAX_PENDING + ' pedidos esperando resposta.');
    if ((await this.db.friendsOf(other.id)).filter((r) => r.status === 'pending' && r.requestedBy !== other.id).length >= MAX_PENDING * 2) return fail(other.username + ' já tem pedidos demais esperando.');
    await this.db.insertFriendRequest(s.userId, other.id, Date.now());
    await this.tell(other.id, s.username + ' quer ser seu amigo. Veja em Amigos (F).');
    return this.result(s, ok('Pedido de amizade enviado para ' + other.username + '.'));
  }

  async answer(s: GameSession, name: string, accept: boolean): Promise<CommandResult> {
    const other = await this.db.findUser(name);
    const f = other ? await this.db.getFriendship(s.userId, other.id) : null;
    if (!other || !f || f.status !== 'pending' || f.requestedBy === s.userId) return fail('Não há pedido de ' + name + ' esperando.');
    if (!accept) {
      await this.db.deleteFriendship(s.userId, other.id);
      return this.result(s, ok('Pedido de ' + other.username + ' recusado.'));
    }
    await this.db.acceptFriendship(s.userId, other.id);
    await this.tell(other.id, s.username + ' aceitou ser seu amigo.');
    return this.result(s, ok('Agora você e ' + other.username + ' são amigos. Em Amigos (F) você escolhe o que cada um pode fazer na fazenda do outro.'));
  }

  /** Corta qualquer visita entre os dois (num sentido ou no outro). */
  private async cutVisits(a: number, b: number): Promise<void> {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const visitor = this.online(x);
      if (visitor?.visiting?.host.userId === y) await this.leave(visitor, 'A amizade acabou: a visita terminou.');
    }
  }

  async remove(s: GameSession, name: string): Promise<CommandResult> {
    const other = await this.db.findUser(name);
    if (!other || !(await this.db.getFriendship(s.userId, other.id))) return fail('Você não tem ' + name + ' na lista.');
    await this.db.deleteFriendship(s.userId, other.id);
    await this.cutVisits(s.userId, other.id);
    await this.tell(other.id, s.username + ' saiu da sua lista de amigos.');
    return this.result(s, ok(other.username + ' saiu da sua lista de amigos.'));
  }

  async block(s: GameSession, name: string): Promise<CommandResult> {
    const other = await this.db.findUser(name);
    if (!other) return fail('Não existe jogador com esse nome.');
    if (other.id === s.userId) return fail('Você não pode bloquear a si mesmo.');
    await this.db.deleteFriendship(s.userId, other.id);
    await this.db.block(s.userId, other.id);
    await this.cutVisits(s.userId, other.id);
    return this.result(s, ok(other.username + ' foi bloqueado.'));
  }

  async unblock(s: GameSession, name: string): Promise<CommandResult> {
    const other = await this.db.findUser(name);
    if (!other) return fail('Não existe jogador com esse nome.');
    await this.db.unblock(s.userId, other.id);
    return this.result(s, ok(other.username + ' foi desbloqueado.'));
  }

  async setPermission(s: GameSession, name: string, level: Permission): Promise<CommandResult> {
    const other = await this.db.findUser(name);
    if (!other || !(await this.areFriends(s.userId, other.id))) return fail('Só dá para dar permissão a amigos.');
    await this.db.setPermission(s.userId, other.id, level);
    const visitor = this.online(other.id);
    if (visitor?.visiting?.host === s) {
      if (level === 0) await this.leave(visitor, 'O dono tirou a permissão: a visita terminou.');
      else {
        visitor.visiting.level = level;
        if (level === 1) visitor.notify('O dono não deixa mais ajudar. Você só pode assistir.');
      }
    }
    await this.tell(other.id, s.username + ' mudou o que você pode fazer na fazenda dele: ' + LEVEL_TEXT[level] + '.');
    return this.result(s, ok(other.username + ' agora pode: ' + LEVEL_TEXT[level] + '.'));
  }

  // ---------- visitas ----------

  async visit(s: GameSession, name: string): Promise<CommandResult> {
    if (s.visiting) return fail('Você já está visitando ' + s.visiting.host.username + '. Volte para casa antes.');
    if (s.visitorCount > 0) return fail('Você está recebendo visitas. Espere elas saírem para visitar alguém.');
    const other = await this.db.findUser(name);
    if (!other || other.id === s.userId) return fail('Não existe jogador com esse nome.');
    if (!(await this.areFriends(s.userId, other.id)) || (await this.db.isBlocked(other.id, s.userId))) return fail(other.username + ' não é seu amigo.');
    const level = await this.db.getPermission(other.id, s.userId);
    if (level < 1) return fail(other.username + ' ainda não deixou você visitar.');
    const host = this.online(other.id);
    if (!host) return fail(other.username + ' não está conectado agora. Só dá para visitar quem está jogando.');
    if (host.visiting) return fail(other.username + ' está visitando outra fazenda agora.');
    if (host.visitorCount >= MAX_VISITORS) return fail('A fazenda de ' + other.username + ' está cheia de visitantes.');
    const patch = host.addVisitor(s);
    await s.startVisit(host, level, patch);
    host.notify(s.username + ' está visitando a sua fazenda.');
    host.pokeSocial();
    return this.result(s, ok('Você está visitando a fazenda de ' + other.username + (level >= 2 ? '. Ele deixou você ajudar: escolha Regar ou Colher e clique num solo.' : '. Ele deixou só assistir.')));
  }

  /** O visitante volta para casa. */
  async leave(s: GameSession, reason = 'Você voltou para casa.'): Promise<boolean> {
    const v = s.visiting;
    if (!v) return false;
    v.host.removeVisitor(s);
    await s.endVisit(reason);
    const helped = v.water + v.harvest;
    v.host.notify(helped
      ? s.username + ' terminou a visita e ajudou: ' + v.water + ' solo(s) regado(s), ' + v.harvest + ' colhido(s).'
      : s.username + ' terminou a visita.');
    v.host.pokeSocial();
    return true;
  }

  /** O dono saiu: todos os visitantes voltam para casa. */
  async ejectAll(host: GameSession, reason = 'O dono saiu da fazenda: a visita terminou.'): Promise<void> {
    for (const v of host.visitorSessions) await this.leave(v, reason);
  }

  // ---------- ajuda ----------

  /** O visitante ajuda no solo escolhido, com a própria ferramenta e a própria energia. */
  async help(s: GameSession, action: HelpAction, i: number, j: number): Promise<CommandResult> {
    const v = s.visiting;
    if (!v) return fail('Você precisa estar visitando uma fazenda para ajudar.');
    const host = v.host;
    // vale o que o dono deixa agora, não o que valia ao entrar
    if ((await this.db.getPermission(host.userId, s.userId)) < 2) return fail(host.username + ' deixou você só assistir.');
    // a visita pode ter acabado enquanto o banco respondia
    if (s.visiting !== v) return fail('A visita terminou.');
    const tile = host.game.farm.at(i, j);
    if (!tile) return fail('Esse solo não existe.');
    if (tile.locked) return fail('Esse terreno está bloqueado por aluguel atrasado.');
    const mine = s.game;
    if (action === 'water') {
      if (tile.state !== 'planted') return fail('Só se rega onde há planta.');
      if (tile.wet) return fail('Esse solo já foi regado hoje.');
      if (mine.player.inv.regador < 1) return fail('Você precisa de um regador na mochila.');
      let said = '';
      const prev = mine.onMessage;
      mine.onMessage = (t) => { said = t; };
      const paid = mine.workWith('regador');
      mine.onMessage = prev;
      if (!paid) return fail(said || 'Sem energia.');
      tile.wet = true;
      tile.careful = false;
      v.water++;
      return ok('Você regou um solo. (' + v.water + ' nesta visita)');
    }
    if (tile.state !== 'planted' || tile.age < READY_AGE) return fail('Ainda não está pronta para colher.');
    if (mine.player.inv.foice < 1) return fail('Você precisa de uma foice na mochila.');
    if (invWeight(host.game.store) + ITEMS.batata.weight > STORE_CAP) return fail('O armazém de ' + host.username + ' está cheio.');
    let said = '';
    const prev = mine.onMessage;
    mine.onMessage = (t) => { said = t; };
    const paid = mine.workWith('foice');
    mine.onMessage = prev;
    if (!paid) return fail(said || 'Sem energia.');
    tile.state = 'tilled';
    tile.age = 0;
    tile.careful = false;
    host.game.store.batata++;
    v.harvest++;
    return ok('Você colheu uma batata para ' + host.username + '. Ela foi para o armazém dele. (' + v.harvest + ' nesta visita)');
  }
}
