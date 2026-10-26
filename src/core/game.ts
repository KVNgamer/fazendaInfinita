import { AUTO_SLEEP, AUTO_WAKE, DAY_START, FAINT_AT, MIN_PER_SEC } from './clock';
import { EQUIPMENT, SLOTS, SLOT_NAME } from './equipment';
import type { Gear, Slot } from './equipment';
import { Farm, READY_AGE } from './farm';
import type { Tile } from './farm';
import { BUY_PRICE, FOOD, ITEMS, ITEM_KEYS, SELL_PRICE, STORE_CAP, invWeight, newInv, transfer } from './items';
import type { Rental, WorkerPackage } from './market';
import type { Inventory, ItemKey } from './items';
import { BOXES, GOLD_PRICE_IN_SILVER, rollBox } from './boxes';
import type { BoxKind, BoxResult } from './boxes';
import { HOUSE_DOOR, SHOP_FRONT, STORE_DOOR, fenceBounds, restSpot } from './layout';
import type { Bounds } from './layout';
import { LANDS, initialLands, landSize } from './lands';
import type { LandDef, LandState } from './lands';
import { movePlayer, newPlayer, placeAtDoor, playerStats } from './player';
import type { MoveInput, Player, ToolLevels } from './player';
import type { Rng } from './rng';
import { PLAYER_BASE, WORKER_BASE, actionCost, computeStats } from './stats';
import type { BaseStats, Stats } from './stats';
import { DEMO_WORKERS, Worker, stepWorker } from './workers';
import type { TaskName, WorkerCfg, WorkerEnv } from './workers';

export type Mode = 'fp' | 'spec';
export type SleepKind = 'sleep' | 'auto' | 'faint';
export type InteractKind = 'house' | 'store' | 'shop' | 'trade';

export interface Interactable {
  kind: InteractKind;
  label: string;
  worker?: Worker;
}

/** Energia base que o jogador gasta em cada ferramenta. Andar nunca gasta. */
export const PLAYER_COST: Partial<Record<ItemKey, number>> = { enxada: 8, semente: 2, regador: 3, foice: 5 };
const LEVEL_OF: Partial<Record<ItemKey, keyof ToolLevels>> = { enxada: 'enxada', semente: 'plantio', regador: 'regador', foice: 'foice' };
/** Cada uso da ferramenta treina o nível um pouco (máximo 100). */
export const LEVEL_GAIN = 0.5;
export const SPEEDS = [1, 5, 15] as const;
export const HOTBAR_SIZE = 9;
/** Limite de trabalhadores na fazenda (lugares de descanso ao lado da estrada). */
export const MAX_WORKERS = 12;
/** Energia do jogador volta sozinha quando ele passa este tempo (s de jogo) sem usar ferramenta. */
export const PLAYER_IDLE_AFTER = 2;
export const PLAYER_REST_RATE = 0.4;

const DEFAULT_HOTBAR: Array<ItemKey | null> = ['enxada', 'regador', 'foice', 'semente', 'batata', 'pao', 'assada', null, null];
const REACH = 1.4;

type GearCheck = { ok: true; next: Gear } | { ok: false; message: string };

export class Game {
  farm = new Farm();
  lands: LandState[] = initialLands();
  player: Player = newPlayer();
  /** Atributos finais do jogador (base + equipamento). */
  stats: Stats = playerStats(this.player);
  store: Inventory = newInv();
  workers: Worker[] = DEMO_WORKERS.map((c) => new Worker(c));
  clock = DAY_START;
  day = 1;
  mode: Mode = 'fp';
  speed = 1;
  hotbar: Array<ItemKey | null> = [...DEFAULT_HOTBAR];
  selected = 0;
  message = '';
  /** Enquanto uma janela está aberta, o tempo para. */
  paused = false;
  /** Segundos de jogo desde a última vez que o jogador gastou energia com uma ferramenta. */
  private sinceWork = 0;
  onMessage: ((text: string) => void) | null = null;
  /** Nomes de quem está visitando esta fazenda agora (o servidor preenche). */
  visitors: string[] = [];
  /** Chamado quando um novo dia começa (a interface usa para salvar). */
  onDayEnd: (() => void) | null = null;
  private readonly rng: Rng;

  constructor(rng: Rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  /** Volta ao começo. Com announce=false não escreve a mensagem (a cópia do navegador usa assim). */
  reset(announce = true): void {
    this.lands = initialLands();
    this.farm.reset();
    this.player = newPlayer();
    this.refreshStats();
    this.player.energy = this.stats.maxEnergy;
    this.player.hp = this.stats.maxHp;
    this.store = newInv({ semente: 20, pao: 2 });
    this.workers = DEMO_WORKERS.map((c) => new Worker(c));
    this.clock = DAY_START;
    this.day = 1;
    this.mode = 'fp';
    this.speed = 1;
    this.hotbar = [...DEFAULT_HOTBAR];
    this.selected = 0;
    this.sinceWork = 0;
    if (announce) this.say('Fazenda recomeçada no dia 1.');
  }

  say(text: string): void {
    this.message = text;
    this.onMessage?.(text);
  }

  /** Limites da fazenda: a cerca cresce com os terrenos comprados. */
  get bounds(): Bounds {
    let maxX = 0;
    let maxZ = 0;
    LANDS.forEach((l, i) => {
      if (this.lands[i].owned) {
        maxX = Math.max(maxX, l.x1);
        maxZ = Math.max(maxZ, l.z1);
      }
    });
    return fenceBounds(maxX, maxZ);
  }

  get carryCap(): number {
    return this.stats.carry;
  }

  /** Recalcula os atributos do jogador depois de mudar equipamento. */
  refreshStats(): void {
    this.stats = playerStats(this.player);
    this.player.energy = Math.min(this.player.energy, this.stats.maxEnergy);
    this.player.hp = Math.min(this.player.hp, this.stats.maxHp);
  }

  // ---------- tempo ----------

  /** Avança `dt` segundos reais. No modo automático o tempo corre `speed` vezes mais rápido. */
  step(dt: number, input: MoveInput): void {
    if (this.paused) return;
    const sim = dt * (this.mode === 'spec' ? this.speed : 1);
    const n = Math.max(1, Math.ceil(sim / 0.1));
    for (let s = 0; s < n; s++) this.simStep(sim / n);
    if (this.mode === 'fp') movePlayer(this.player, input, dt, this.stats.speed, this.bounds);
  }

  get env(): WorkerEnv {
    return {
      farm: this.farm,
      store: this.store,
      clock: this.clock,
      seedsTotal: this.workers.reduce((a, w) => a + w.inv.semente, this.player.inv.semente + this.store.semente),
      emptyTilled: this.farm.count('tilled'),
      storeCap: STORE_CAP,
      rng: this.rng,
      workers: this.workers,
    };
  }

  private simStep(h: number): void {
    this.clock += h * MIN_PER_SEC;
    this.sinceWork += h;
    if (this.sinceWork > PLAYER_IDLE_AFTER) {
      this.player.energy = Math.min(this.stats.maxEnergy, this.player.energy + PLAYER_REST_RATE * h);
    }
    const env = this.env;
    for (const w of this.workers) stepWorker(w, h, env);
    if (this.mode === 'spec' && this.clock >= AUTO_SLEEP) this.endDay('auto');
    else if (this.clock >= FAINT_AT) this.endDay('faint');
  }

  endDay(kind: SleepKind): void {
    const rent = this.chargeRent();
    const died = this.farm.endDay(this.rng);
    this.day++;
    this.clock = kind === 'auto' ? AUTO_WAKE : DAY_START;
    this.workers.forEach((w) => {
      w.sleep();
      w.hp = w.maxHp;
    });
    const s = this.stats;
    if (kind === 'faint') {
      this.player.energy = s.maxEnergy * 0.7;
      this.player.hp = Math.min(this.player.hp, s.maxHp * 0.8);
    } else {
      this.player.energy = s.maxEnergy;
      this.player.hp = s.maxHp;
    }
    placeAtDoor(this.player);
    const intro = kind === 'faint'
      ? 'Você desmaiou às 02:00 e acordou com 70% de energia e 80% de vida. '
      : kind === 'auto'
        ? 'Você foi dormir às 18:00 e acordou às 07:00. '
        : 'Você dormiu e acordou às 06:00. ';
    this.say(intro + 'Dia ' + this.day + (died ? ' · ' + died + ' planta(s) morreram por falta de água.' : '.') + rent);
    this.onDayEnd?.();
  }

  // ---------- modos ----------

  enterAuto(): void {
    if (this.clock >= AUTO_SLEEP) this.endDay('auto');
    else if (this.clock < AUTO_WAKE) this.clock = AUTO_WAKE;
    this.mode = 'spec';
    this.speed = 1;
    this.say('Modo automático: você está em casa e só assiste. Arraste para girar a câmera. Escolha a velocidade.');
  }

  exitAuto(): void {
    this.mode = 'fp';
    this.speed = 1;
    placeAtDoor(this.player);
    this.say('Você saiu de casa e voltou ao modo normal.');
  }

  setSpeed(s: number): void {
    if (this.mode === 'spec' && (SPEEDS as readonly number[]).includes(s)) this.speed = s;
  }

  // ---------- ações do jogador ----------

  targetTile(): Tile | null {
    const p = this.player;
    return this.farm.at(Math.round(p.x - Math.sin(p.yaw) * REACH), Math.round(p.z - Math.cos(p.yaw) * REACH));
  }

  /** Energia que o jogador gasta agora com a ferramenta: base, nível e equipamento. */
  toolCost(key: ItemKey): number {
    const base = PLAYER_COST[key] ?? 0;
    const lv = LEVEL_OF[key];
    const level = lv ? this.player.levels[lv] : 0;
    return actionCost(base, level, this.stats.costMod + (key === 'enxada' ? this.stats.hoeCostMod : 0));
  }

  /** Gasta a energia e treina o nível da ferramenta. Devolve false (e avisa) se faltar energia. */
  workWith(key: ItemKey): boolean {
    const p = this.player;
    const cost = this.toolCost(key);
    if (p.energy < cost) {
      this.say('Sem energia. Coma algo (pão, batata assada ou batata) ou vá dormir.');
      return false;
    }
    p.energy -= cost;
    this.sinceWork = 0;
    const lv = LEVEL_OF[key];
    if (lv) p.levels[lv] = Math.min(100, p.levels[lv] + LEVEL_GAIN);
    return true;
  }

  /** Usa o item do slot selecionado: comer, ou trabalhar o solo à frente. */
  useSelected(): void {
    const key = this.hotbar[this.selected];
    const p = this.player;
    if (!key) return this.say('Slot vazio. Abra o inventário (I) e escolha um item para este slot.');
    if (p.inv[key] < 1) return this.say('Você não tem mais ' + ITEMS[key].name.toLowerCase() + '.');
    const food = FOOD[key];
    if (food) {
      if (p.energy >= this.stats.maxEnergy && p.hp >= this.stats.maxHp) return this.say('Você já está com energia e vida cheias.');
      p.inv[key]--;
      p.energy = Math.min(this.stats.maxEnergy, p.energy + food.energy);
      p.hp = Math.min(this.stats.maxHp, p.hp + food.hp);
      return this.say('Você comeu: +' + food.energy + ' energia, +' + food.hp + ' vida.');
    }
    const t = this.targetTile();
    if (!t) return this.say('Nada à frente. Chegue perto dos solos.');
    if (t.locked) return this.say('Terreno bloqueado por aluguel atrasado. Pague em Terrenos (L).');
    switch (key) {
      case 'enxada':
        if (t.state !== 'raw') return this.say(t.state === 'tilled' ? 'Esse solo já está preparado.' : 'Há uma planta aqui.');
        if (!this.workWith(key)) return;
        t.state = 'tilled';
        return this.say('Solo preparado.');
      case 'semente':
        if (t.state === 'raw') return this.say('Prepare o solo com a enxada primeiro.');
        if (t.state === 'planted') return this.say('Já tem uma planta aqui.');
        if (!this.workWith(key)) return;
        p.inv.semente--;
        t.state = 'planted';
        t.age = 0;
        t.wet = false;
        t.dry = 0;
        t.careful = false;
        return this.say('Semente plantada. Lembre de regar.');
      case 'regador':
        if (t.state !== 'planted') return this.say('Só se rega onde há planta.');
        if (t.wet) return this.say('Já foi regada hoje.');
        if (!this.workWith(key)) return;
        t.wet = true;
        t.careful = false;
        return this.say('Regada.');
      case 'foice':
        if (t.state !== 'planted') return this.say('Não há nada para colher aqui.');
        if (t.age < READY_AGE) return this.say('Ainda não está pronta (dia ' + (t.age + 1) + ' de 6).');
        if (invWeight(p.inv) + ITEMS.batata.weight > this.carryCap) return this.say('Mochila cheia. Guarde no armazém ou venda no mercado (E).');
        if (!this.workWith(key)) return;
        t.state = 'tilled';
        t.age = 0;
        t.careful = false;
        p.inv.batata++;
        return this.say('Você colheu 1 batata.');
      default:
        return;
    }
  }

  selectSlot(i: number): void {
    if (i >= 0 && i < HOTBAR_SIZE) this.selected = i;
  }

  assignSlot(key: ItemKey | null): void {
    this.hotbar[this.selected] = key;
  }

  // ---------- equipamento ----------

  /** Confere se trocar uma peça cabe: o peso carregado não pode passar do novo limite. */
  private checkGear(gear: Gear, slot: Slot, id: string | null, inv: Inventory, base: BaseStats, abilities: readonly string[]): GearCheck {
    const next = { ...gear, [slot]: id };
    const carry = computeStats(base, next, abilities).carry;
    if (invWeight(inv) > carry + 1e-9) {
      return { ok: false, message: 'Tire peso da mochila antes: o limite cairia para ' + carry + ' kg.' };
    }
    return { ok: true, next };
  }

  equip(id: string): string {
    const p = this.player;
    const def = EQUIPMENT[id];
    const idx = p.gearInv.indexOf(id);
    if (!def || idx < 0) return 'Você não tem essa peça.';
    const check = this.checkGear(p.gear, def.slot, id, p.inv, PLAYER_BASE, []);
    if (!check.ok) return check.message;
    const old = p.gear[def.slot];
    p.gearInv.splice(idx, 1);
    if (old) p.gearInv.push(old);
    p.gear = check.next;
    this.refreshStats();
    return 'Você vestiu: ' + def.name + '.';
  }

  unequip(slot: Slot): string {
    const p = this.player;
    const id = p.gear[slot];
    if (!id) return 'Nada vestido em ' + SLOT_NAME[slot].toLowerCase() + '.';
    const check = this.checkGear(p.gear, slot, null, p.inv, PLAYER_BASE, []);
    if (!check.ok) return check.message;
    p.gear = check.next;
    p.gearInv.push(id);
    this.refreshStats();
    return 'Você guardou: ' + EQUIPMENT[id].name + '.';
  }

  /** Dá uma peça da sua mochila a um trabalhador por perto. A peça que ele usava volta para você. */
  giveGear(w: Worker, id: string): string {
    const p = this.player;
    const def = EQUIPMENT[id];
    const idx = p.gearInv.indexOf(id);
    if (!def || idx < 0) return 'Você não tem essa peça.';
    if (!this.workerIsNear(w)) return 'Chegue perto de ' + w.name + ' para trocar peças.';
    const base = { ...WORKER_BASE, maxHp: w.cfg.hp };
    const check = this.checkGear(w.gear, def.slot, id, w.inv, base, w.abilities);
    if (!check.ok) return w.name + ': ' + check.message;
    const old = w.gear[def.slot];
    p.gearInv.splice(idx, 1);
    if (old) p.gearInv.push(old);
    w.gear = check.next;
    w.refreshStats();
    return w.name + ' vestiu: ' + def.name + '.';
  }

  takeGear(w: Worker, slot: Slot): string {
    const id = w.gear[slot];
    if (!id) return w.name + ' não veste nada em ' + SLOT_NAME[slot].toLowerCase() + '.';
    if (!this.workerIsNear(w)) return 'Chegue perto de ' + w.name + ' para trocar peças.';
    const base = { ...WORKER_BASE, maxHp: w.cfg.hp };
    const check = this.checkGear(w.gear, slot, null, w.inv, base, w.abilities);
    if (!check.ok) return w.name + ': ' + check.message;
    w.gear = check.next;
    this.player.gearInv.push(id);
    w.refreshStats();
    return 'Você pegou de volta: ' + EQUIPMENT[id].name + '.';
  }

  buyGear(id: string): string {
    const def = EQUIPMENT[id];
    if (!def || def.price === undefined) return 'Essa peça não está à venda.';
    if (this.player.silver < def.price) return 'Prata insuficiente.';
    this.player.silver -= def.price;
    this.player.gearInv.push(id);
    return 'Comprou: ' + def.name + '. Equipe em Personagem (C).';
  }

  // ---------- terrenos e aluguel ----------

  /** Próximo terreno à venda (compra-se na ordem), ou null se já comprou todos. */
  nextLand(): LandDef | null {
    const i = this.lands.findIndex((l) => !l.owned);
    return i < 0 ? null : LANDS[i];
  }

  /** Aluguel que será cobrado esta noite: terrenos comprados e em dia. */
  dailyRent(): number {
    return LANDS.reduce((sum, l, i) => sum + (this.lands[i].owned && !this.lands[i].locked ? l.rent : 0), 0);
  }

  buyLand(): string {
    const def = this.nextLand();
    if (!def) return 'Você já comprou todos os terrenos disponíveis.';
    if (this.player.silver < def.price) return 'Prata insuficiente: o ' + def.name + ' custa ' + def.price + '.';
    this.player.silver -= def.price;
    this.lands[def.index].owned = true;
    this.farm.addLand(def.index);
    return 'Você comprou o ' + def.name + ': +' + landSize(def) + ' solos. A cerca foi ampliada. Aluguel de ' + def.rent + ' por dia, cobrado ao dormir.';
  }

  /** Cobra o aluguel ao fim do dia. Sem prata, o terreno fica bloqueado (parado) até pagar a dívida. */
  private chargeRent(): string {
    let paid = 0;
    const newlyLocked: string[] = [];
    LANDS.forEach((l, i) => {
      const s = this.lands[i];
      if (!s.owned || i === 0) return;
      if (s.locked) {
        s.debt += l.rent;
      } else if (this.player.silver >= l.rent) {
        this.player.silver -= l.rent;
        paid += l.rent;
      } else {
        s.locked = true;
        s.debt = l.rent;
        this.farm.setLocked(i, true);
        newlyLocked.push(l.name);
      }
    });
    let text = '';
    if (paid) text += ' Aluguel pago: ' + paid + ' de prata.';
    if (newlyLocked.length) text += ' Sem prata para o aluguel: ' + newlyLocked.join(', ') + ' bloqueado.';
    return text;
  }

  /** Paga a dívida de um terreno bloqueado e libera o trabalho nele. */
  payDebt(index: number): string {
    const s = this.lands[index];
    if (!s?.locked) return 'Esse terreno não está bloqueado.';
    if (this.player.silver < s.debt) return 'Prata insuficiente: a dívida é de ' + s.debt + '.';
    this.player.silver -= s.debt;
    const paid = s.debt;
    s.debt = 0;
    s.locked = false;
    this.farm.setLocked(index, false);
    return 'Dívida de ' + paid + ' paga. O ' + LANDS[index].name + ' voltou a funcionar.';
  }

  // ---------- ouro e caixas ----------

  buyGold(amount: number): string {
    const cost = amount * GOLD_PRICE_IN_SILVER;
    if (this.player.silver < cost) return 'Prata insuficiente: ' + amount + ' de ouro custa ' + cost + ' de prata.';
    this.player.silver -= cost;
    this.player.gold += amount;
    return 'Você trocou ' + cost + ' de prata por ' + amount + ' de ouro.';
  }

  /** Tira um trabalhador da fazenda. Os itens dele vão para o armazém e as peças para a sua mochila. */
  detachWorker(w: Worker): WorkerPackage {
    if (w.task?.tile) w.task.tile.reserved = null;
    for (const k of ITEM_KEYS) {
      this.store[k] += w.inv[k];
      w.inv[k] = 0;
    }
    for (const slot of SLOTS) {
      const id = w.gear[slot];
      if (id) {
        this.player.gearInv.push(id);
        w.gear[slot] = null;
      }
    }
    this.workers = this.workers.filter((x) => x !== w);
    return { cfg: { ...w.cfg, name: w.name, gear: {}, inv: {} }, prios: w.prios.map((p) => ({ k: p.k, on: p.on })) };
  }

  /** Põe na fazenda um trabalhador que veio de fora, sem itens. Devolve null se a fazenda está cheia. */
  attachWorker(pkg: WorkerPackage, rental: Rental | null = null): Worker | null {
    if (this.workers.length >= MAX_WORKERS) return null;
    const taken = this.workers.map((w) => w.name);
    let name = pkg.cfg.name;
    if (taken.includes(name) && rental) name = (pkg.cfg.name + ' (' + rental.owner + ')').slice(0, 30);
    const base = name.slice(0, 26).replace(/ \d+$/, '');
    for (let n = 2; taken.includes(name); n++) name = base + ' ' + n;
    const w = new Worker({ ...pkg.cfg, name, gear: {}, inv: {}, rest: restSpot(this.workers.length) });
    w.prios = pkg.prios.map((p) => ({ k: p.k, on: p.on }));
    w.rental = rental;
    this.workers.push(w);
    return w;
  }

  /** Quantas unidades de `key` ainda cabem no armazém e na mochila. */
  room(key: ItemKey): { store: number; bag: number } {
    const w = ITEMS[key].weight;
    return {
      store: Math.max(0, Math.floor((STORE_CAP - invWeight(this.store) + 1e-9) / w)),
      bag: Math.max(0, Math.floor((this.carryCap - invWeight(this.player.inv) + 1e-9) / w)),
    };
  }

  /** Guarda o que chegou de fora (compra, devolução, cozinha): vai para o armazém e, se ele encher, o resto para a mochila. */
  receiveItem(key: ItemKey, qty: number): void {
    const room = this.room(key);
    const inStore = Math.min(qty, room.store);
    this.store[key] += inStore;
    const rest = qty - inStore;
    if (rest <= 0) return;
    // o armazém encheu: o resto vai para a mochila; se nem ela couber, volta ao armazém (nada se perde)
    const inBag = Math.min(rest, room.bag);
    this.player.inv[key] += inBag;
    this.store[key] += rest - inBag;
  }

  addWorker(cfg: WorkerCfg): Worker {
    const w = new Worker(cfg);
    this.workers.push(w);
    return w;
  }

  /** Abre uma caixa: paga com prata ou ouro e recebe uma peça ou um trabalhador. */
  openBox(kind: BoxKind): { message: string; result: BoxResult | null } {
    const box = BOXES[kind];
    const p = this.player;
    if (box.currency === 'silver' ? p.silver < box.price : p.gold < box.price) {
      return { message: (box.currency === 'silver' ? 'Prata' : 'Ouro') + ' insuficiente para a ' + box.name.toLowerCase() + '.', result: null };
    }
    if (box.currency === 'silver') p.silver -= box.price;
    else p.gold -= box.price;
    const full = this.workers.length >= MAX_WORKERS;
    const result = rollBox(this.rng, kind, this.workers.map((w) => w.name), restSpot(this.workers.length), !full);
    if (result.type === 'equip') {
      p.gearInv.push(result.id);
      return { message: 'Saiu uma peça: ' + EQUIPMENT[result.id].name + '. Veja em Personagem (C).', result };
    }
    const w = this.addWorker(result.cfg);
    return { message: 'Novo trabalhador: ' + w.name + '! Dê ferramentas e sementes a ele na tela de troca.', result };
  }

  // ---------- interação ----------

  nearby(): Interactable | null {
    const p = this.player;
    let best: Interactable | null = null;
    let bd = Infinity;
    const consider = (c: Interactable, x: number, z: number, r: number) => {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < r && d < bd) {
        bd = d;
        best = c;
      }
    };
    consider({ kind: 'house', label: 'Entrar em casa (dormir, cozinha, modo automático)' }, HOUSE_DOOR.x, HOUSE_DOOR.z, 2.3);
    consider({ kind: 'store', label: 'Armazém (ver e guardar itens)' }, STORE_DOOR.x, STORE_DOOR.z, 2.2);
    consider({ kind: 'shop', label: 'Mercado (vender e comprar)' }, SHOP_FRONT.x, SHOP_FRONT.z, 2.3);
    for (const w of this.workers) {
      if (w.visible && w.pres === 'in' && !w.waypoints.length) {
        consider({ kind: 'trade', label: 'Trocar itens e prioridades com ' + w.name, worker: w }, w.x, w.z, 2.4);
      }
    }
    return best;
  }

  workerIsNear(w: Worker): boolean {
    return w.visible && w.pres === 'in' && Math.hypot(this.player.x - w.x, this.player.z - w.z) < 3.5;
  }

  /** O jogador está perto da casa, do armazém ou do mercado? O servidor confere antes de aceitar ações desses lugares. */
  isNear(kind: 'house' | 'store' | 'shop'): boolean {
    const spot = kind === 'house' ? HOUSE_DOOR : kind === 'store' ? STORE_DOOR : SHOP_FRONT;
    const radius = kind === 'store' ? 2.2 : 2.3;
    return Math.hypot(this.player.x - spot.x, this.player.z - spot.z) < radius;
  }

  /** Define a ordem e o liga/desliga das tarefas de um trabalhador. A lista precisa ter as quatro tarefas, sem repetir. */
  setPriorities(w: Worker, order: readonly TaskName[], on: readonly boolean[]): boolean {
    const all: TaskName[] = ['Plantar', 'Regar', 'Preparar', 'Colher'];
    if (order.length !== 4 || on.length !== 4 || !all.every((k) => order.includes(k))) return false;
    w.prios = order.map((k, i) => ({ k, on: on[i] }));
    return true;
  }

  /**
   * Só anima: avança o relógio e os trabalhadores, sem sorteios, sem fim de dia e sem mexer no jogador.
   * É o que a cópia do jogo no navegador roda entre uma atualização do servidor e a próxima.
   * O servidor tem a palavra final: cada atualização dele corrige o que esta animação errar.
   */
  animate(dt: number): void {
    if (this.paused) return;
    const sim = dt * (this.mode === 'spec' ? this.speed : 1);
    const n = Math.max(1, Math.ceil(sim / 0.1));
    const limit = (this.mode === 'spec' ? AUTO_SLEEP : FAINT_AT) - 0.01;
    for (let s = 0; s < n; s++) {
      const h = sim / n;
      this.clock = Math.min(limit, this.clock + h * MIN_PER_SEC);
      const env = this.env;
      for (const w of this.workers) stepWorker(w, h, env);
    }
  }

  /** Move só o jogador (a previsão do navegador, enquanto o servidor não responde). */
  predictMove(dt: number, input: MoveInput): void {
    if (this.mode === 'fp' && !this.paused) movePlayer(this.player, input, dt, this.stats.speed, this.bounds);
  }

  // ---------- inventários ----------

  /** Passa itens entre duas mochilas respeitando o peso. Devolve o texto para mostrar. */
  moveItems(from: Inventory, to: Inventory, capTo: number, key: ItemKey, amount: number): string {
    const r = transfer(from, to, key, amount, capTo);
    if (r.moved < 1) return 'Cheio: ' + ITEMS[key].name + ' não cabe (' + r.free.toFixed(1).replace('.', ',') + ' kg livres).';
    return r.moved + ' × ' + ITEMS[key].name + ' transferido(s).';
  }

  // ---------- mercado e cozinha ----------

  sellPotatoes(amount: number): string {
    const p = this.player;
    const n = Math.min(amount, p.inv.batata);
    if (n < 1) return 'Você não tem batatas na mochila.';
    const price = SELL_PRICE.batata!;
    p.inv.batata -= n;
    p.silver += n * price;
    return 'Vendeu ' + n + ' batata(s) por ' + n * price + ' de prata.';
  }

  sellStorePotatoes(): string {
    const n = this.store.batata;
    if (n < 1) return 'O armazém está sem batatas.';
    const price = SELL_PRICE.batata!;
    this.store.batata = 0;
    this.player.silver += n * price;
    return 'Vendeu ' + n + ' batata(s) do armazém por ' + n * price + ' de prata.';
  }

  /** O máximo que dá para comprar agora: o que cabe (armazém e depois mochila) e o que a prata paga. */
  maxBuy(key: ItemKey): number {
    const price = BUY_PRICE[key];
    if (!price) return 0;
    const room = this.room(key);
    return Math.max(0, Math.min(Math.floor(this.player.silver / price), room.store + room.bag));
  }

  /** Compra para o armazém; se ele encher, o resto vai para a mochila. */
  buy(key: ItemKey, amount: number): string {
    const price = BUY_PRICE[key];
    const p = this.player;
    if (!price) return 'Esse item não está à venda.';
    if (!Number.isInteger(amount) || amount < 1) return 'Quantidade inválida.';
    if (p.silver < price * amount) return 'Prata insuficiente.';
    const room = this.room(key);
    if (amount > room.store + room.bag) return 'Não cabe: só há lugar para ' + (room.store + room.bag) + ' (armazém e mochila).';
    p.silver -= price * amount;
    const inStore = Math.min(amount, room.store);
    this.store[key] += inStore;
    p.inv[key] += amount - inStore;
    return 'Comprou ' + amount + ' × ' + ITEMS[key].name + (inStore === amount ? ' (no armazém).' : inStore ? ' (' + inStore + ' no armazém, ' + (amount - inStore) + ' na mochila).' : ' (armazém cheio: na mochila).');
  }

  /** Batata assada: 2 batatas (primeiro da mochila, depois do armazém). */
  canCook(): boolean {
    return this.player.inv.batata + this.store.batata >= 2;
  }

  /** Quantas batatas assadas dá para fazer agora. */
  maxCook(): number {
    return Math.floor((this.player.inv.batata + this.store.batata) / 2);
  }

  /** Cozinha até `n` batatas assadas (2 batatas cada, primeiro da mochila). O resultado vai para o armazém. */
  cook(n = 1): string {
    const p = this.player;
    const times = Math.min(Math.max(1, Math.floor(n)), this.maxCook());
    if (times < 1) return 'Precisa de 2 batatas (mochila ou armazém).';
    const need = times * 2;
    const fromBag = Math.min(need, p.inv.batata);
    p.inv.batata -= fromBag;
    this.store.batata -= need - fromBag;
    this.receiveItem('assada', times);
    return 'Você cozinhou ' + times + ' batata(s) assada(s). Elas estão no armazém.';
  }

  /** Manda um trabalhador buscar itens no armazém (a ordem vale antes das tarefas dele). `n` = 0 cancela. */
  orderFetch(w: Worker, key: ItemKey, n: number): string {
    if (n < 1) {
      w.order = null;
      return w.name + ' não tem mais ordem de buscar itens.';
    }
    if (this.store[key] < 1) return 'O armazém não tem ' + ITEMS[key].name.toLowerCase() + '.';
    w.order = { key, left: Math.floor(n) };
    return w.name + ' vai buscar ' + Math.min(Math.floor(n), this.store[key]) + ' × ' + ITEMS[key].name + ' no armazém' + (w.pres === 'in' ? '.' : ' quando chegar.');
  }
}
