/**
 * O que o navegador e o servidor dizem um ao outro. Tudo que chega pela rede é desconfiado:
 * `parseClientMsg` só deixa passar mensagens de formato exato, com valores dentro dos limites.
 */
import type { BoxKind, BoxResult } from '../core/boxes';
import type { Slot } from '../core/equipment';
import type { Currency, ListingKind, SellSpec } from '../core/market';
import type { HelpAction } from '../core/social';
import type { ItemKey } from '../core/items';
import { ITEM_KEYS } from '../core/items';
import type { TaskName } from '../core/workers';
import type { Patch } from './snapshot';

export const MAX_MESSAGE_BYTES = 64 * 1024;

export type Where = { at: 'bag' } | { at: 'store' } | { at: 'worker'; name: string };

/** Ações do jogador. O servidor confere cada uma (perto do lugar certo, prata suficiente, etc.). */
export type Command =
  | { t: 'use' }
  | { t: 'select'; slot: number }
  | { t: 'assign'; key: ItemKey | null }
  | { t: 'sleep' }
  | { t: 'auto' }
  | { t: 'exitAuto' }
  | { t: 'speed'; speed: number }
  | { t: 'paused'; value: boolean }
  | { t: 'cook'; n: number }
  | { t: 'order'; worker: string; key: ItemKey; n: number }
  | { t: 'sellPotatoes'; n: number }
  | { t: 'sellStore' }
  | { t: 'buy'; key: ItemKey; n: number }
  | { t: 'buyGear'; id: string }
  | { t: 'buyGold'; n: number }
  | { t: 'openBox'; kind: BoxKind }
  | { t: 'buyLand' }
  | { t: 'payDebt'; index: number }
  | { t: 'equip'; id: string }
  | { t: 'unequip'; slot: Slot }
  | { t: 'give'; worker: string; id: string }
  | { t: 'take'; worker: string; slot: Slot }
  | { t: 'move'; from: Where; to: Where; key: ItemKey; n: number }
  | { t: 'prios'; worker: string; order: TaskName[]; on: boolean[] }
  | { t: 'market'; kind?: ListingKind }
  | { t: 'marketSell'; spec: SellSpec; price: number; currency: Currency }
  | { t: 'marketBuy'; id: number }
  | { t: 'marketCancel'; id: number }
  | { t: 'rentRecall'; id: number }
  | { t: 'social' }
  | { t: 'friendRequest'; name: string }
  | { t: 'friendAnswer'; name: string; accept: boolean }
  | { t: 'friendRemove'; name: string }
  | { t: 'friendBlock'; name: string }
  | { t: 'friendUnblock'; name: string }
  | { t: 'friendPerm'; name: string; level: 0 | 1 | 2 }
  | { t: 'visit'; name: string }
  | { t: 'leaveVisit' }
  | { t: 'help'; action: HelpAction; i: number; j: number }
  | { t: 'save' }
  | { t: 'reset' };

export interface InputMsg {
  t: 'input';
  f: number;
  b: number;
  l: number;
  r: number;
  yaw: number;
  pitch: number;
}

export type ClientMsg =
  | { t: 'auth'; token: string }
  | InputMsg
  | { t: 'cmd'; id: number; c: Command };

export interface CommandResult {
  message: string;
  /** Só ao abrir caixa: o prêmio. */
  box?: BoxResult | null;
  /** Dados que a ação devolve (hoje: a tela do mercado). */
  data?: unknown;
  ok: boolean;
}

export type ServerMsg =
  | { t: 'welcome'; user: string; fresh: boolean; patch: Patch }
  | { t: 'patch'; patch: Patch }
  | { t: 'result'; id: number; result: CommandResult }
  | { t: 'msg'; text: string }
  | { t: 'visitStart'; host: string; canHelp: boolean; patch: Patch }
  | { t: 'visitPatch'; patch: Patch; canHelp: boolean }
  | { t: 'visitEnd'; reason: string }
  | { t: 'social' }
  | { t: 'saved' }
  | { t: 'kicked'; reason: string }
  | { t: 'error'; text: string };

// ---------- validação ----------

type Json = Record<string, unknown>;

function isObj(x: unknown): x is Json {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function int(x: unknown, min: number, max: number): number | null {
  return typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : null;
}

function bit(x: unknown): number | null {
  return x === 0 || x === 1 ? x : null;
}

function str(x: unknown, max = 40): string | null {
  return typeof x === 'string' && x.length > 0 && x.length <= max ? x : null;
}

const SLOTS: readonly string[] = ['chapeu', 'camisa', 'bolsa', 'calca', 'sapato'];
const TASKS: readonly string[] = ['Plantar', 'Regar', 'Preparar', 'Colher'];

function itemKey(x: unknown): ItemKey | null {
  return typeof x === 'string' && (ITEM_KEYS as readonly string[]).includes(x) ? (x as ItemKey) : null;
}

function slot(x: unknown): Slot | null {
  return typeof x === 'string' && SLOTS.includes(x) ? (x as Slot) : null;
}

function where(x: unknown): Where | null {
  if (!isObj(x)) return null;
  if (x.at === 'bag' || x.at === 'store') return { at: x.at };
  if (x.at === 'worker') {
    const name = str(x.name, 30);
    return name ? { at: 'worker', name } : null;
  }
  return null;
}

const LISTING_KINDS: readonly string[] = ['item', 'gear', 'worker', 'rent', 'gold'];

function sellSpec(x: unknown): SellSpec | null {
  if (!isObj(x)) return null;
  switch (x.what) {
    case 'item': {
      const key = itemKey(x.key);
      const qty = int(x.qty, 1, 100000);
      return key && qty !== null ? { what: 'item', key, qty } : null;
    }
    case 'gear': {
      const id = str(x.id);
      return id ? { what: 'gear', id } : null;
    }
    case 'worker': {
      const name = str(x.name, 30);
      return name ? { what: 'worker', name } : null;
    }
    case 'gold': {
      const qty = int(x.qty, 1, 1_000_000);
      return qty === null ? null : { what: 'gold', qty };
    }
    case 'rent': {
      const name = str(x.name, 30);
      const days = int(x.days, 1, 14);
      if (x.to !== undefined) {
        const to = str(x.to, 20);
        return name && days !== null && to ? { what: 'rent', name, days, to } : null;
      }
      return name && days !== null ? { what: 'rent', name, days } : null;
    }
    default:
      return null;
  }
}

/** Confere uma ação. Devolve null se algo estiver fora do formato. */
export function parseCommand(x: unknown): Command | null {
  if (!isObj(x) || typeof x.t !== 'string') return null;
  switch (x.t) {
    case 'cook': {
      const n = x.n === undefined ? 1 : int(x.n, 1, 100000);
      return n === null ? null : { t: 'cook', n };
    }
    case 'order': {
      const worker = str(x.worker, 30);
      const key = itemKey(x.key);
      const n = int(x.n, 0, 100000);
      return worker && key && n !== null ? { t: 'order', worker, key, n } : null;
    }
    case 'use': case 'sleep': case 'auto': case 'exitAuto': case 'sellStore':
    case 'buyLand': case 'save': case 'reset':
      return { t: x.t };
    case 'select': {
      const slotN = int(x.slot, 0, 8);
      return slotN === null ? null : { t: 'select', slot: slotN };
    }
    case 'assign': {
      if (x.key === null) return { t: 'assign', key: null };
      const key = itemKey(x.key);
      return key ? { t: 'assign', key } : null;
    }
    case 'speed': {
      const speed = int(x.speed, 1, 15);
      return speed === null ? null : { t: 'speed', speed };
    }
    case 'paused':
      return typeof x.value === 'boolean' ? { t: 'paused', value: x.value } : null;
    case 'sellPotatoes': {
      const n = int(x.n, 1, 100000);
      return n === null ? null : { t: 'sellPotatoes', n };
    }
    case 'buy': {
      const key = itemKey(x.key);
      const n = int(x.n, 1, 100000);
      return key && n !== null ? { t: 'buy', key, n } : null;
    }
    case 'buyGear': {
      const id = str(x.id);
      return id ? { t: 'buyGear', id } : null;
    }
    case 'buyGold': {
      const n = int(x.n, 1, 1000);
      return n === null ? null : { t: 'buyGold', n };
    }
    case 'openBox':
      return x.kind === 'prata' || x.kind === 'ouro' ? { t: 'openBox', kind: x.kind } : null;
    case 'payDebt': {
      const index = int(x.index, 0, 50);
      return index === null ? null : { t: 'payDebt', index };
    }
    case 'equip': {
      const id = str(x.id);
      return id ? { t: 'equip', id } : null;
    }
    case 'unequip': {
      const s = slot(x.slot);
      return s ? { t: 'unequip', slot: s } : null;
    }
    case 'give': {
      const worker = str(x.worker, 30);
      const id = str(x.id);
      return worker && id ? { t: 'give', worker, id } : null;
    }
    case 'take': {
      const worker = str(x.worker, 30);
      const s = slot(x.slot);
      return worker && s ? { t: 'take', worker, slot: s } : null;
    }
    case 'move': {
      const from = where(x.from);
      const to = where(x.to);
      const key = itemKey(x.key);
      const n = int(x.n, 1, 100000);
      return from && to && key && n !== null ? { t: 'move', from, to, key, n } : null;
    }
    case 'prios': {
      const worker = str(x.worker, 30);
      if (!worker || !Array.isArray(x.order) || !Array.isArray(x.on) || x.order.length !== 4 || x.on.length !== 4) return null;
      if (!x.order.every((k) => typeof k === 'string' && TASKS.includes(k))) return null;
      if (!x.on.every((v) => typeof v === 'boolean')) return null;
      return { t: 'prios', worker, order: x.order as TaskName[], on: x.on as boolean[] };
    }
    case 'social': case 'leaveVisit':
      return { t: x.t };
    case 'friendRequest': case 'friendRemove': case 'friendBlock': case 'friendUnblock': case 'visit': {
      const name = str(x.name, 20);
      return name ? { t: x.t, name } : null;
    }
    case 'friendAnswer': {
      const name = str(x.name, 20);
      return name && typeof x.accept === 'boolean' ? { t: 'friendAnswer', name, accept: x.accept } : null;
    }
    case 'friendPerm': {
      const name = str(x.name, 20);
      const level = int(x.level, 0, 2);
      return name && level !== null ? { t: 'friendPerm', name, level: level as 0 | 1 | 2 } : null;
    }
    case 'help': {
      const i = int(x.i, 0, 200);
      const j = int(x.j, 0, 200);
      return (x.action === 'water' || x.action === 'harvest') && i !== null && j !== null ? { t: 'help', action: x.action, i, j } : null;
    }
    case 'market': {
      if (x.kind === undefined) return { t: 'market' };
      return LISTING_KINDS.includes(x.kind as string) ? { t: 'market', kind: x.kind as ListingKind } : null;
    }
    case 'marketSell': {
      const spec = sellSpec(x.spec);
      // empréstimo a amigo (anúncio privado) pode ser de graça
      const price = int(x.price, spec && spec.what === 'rent' && spec.to ? 0 : 1, 10_000_000);
      const currency = x.currency === 'silver' || x.currency === 'gold' ? x.currency : null;
      return spec && price !== null && currency ? { t: 'marketSell', spec, price, currency } : null;
    }
    case 'marketBuy': case 'marketCancel': case 'rentRecall': {
      const id = int(x.id, 1, 2 ** 31);
      return id === null ? null : { t: x.t, id };
    }
    default:
      return null;
  }
}

/** Lê o texto de uma mensagem do navegador. null se não servir. */
export function parseClientMsg(text: string): ClientMsg | null {
  if (text.length > MAX_MESSAGE_BYTES) return null;
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(x) || typeof x.t !== 'string') return null;
  if (x.t === 'auth') {
    const token = str(x.token, 128);
    return token ? { t: 'auth', token } : null;
  }
  if (x.t === 'input') {
    const f = bit(x.f);
    const b = bit(x.b);
    const l = bit(x.l);
    const r = bit(x.r);
    if (f === null || b === null || l === null || r === null) return null;
    if (typeof x.yaw !== 'number' || typeof x.pitch !== 'number' || !Number.isFinite(x.yaw) || !Number.isFinite(x.pitch)) return null;
    return { t: 'input', f, b, l, r, yaw: x.yaw, pitch: x.pitch };
  }
  if (x.t === 'cmd') {
    const id = int(x.id, 0, 2 ** 31);
    const c = parseCommand(x.c);
    return id !== null && c ? { t: 'cmd', id, c } : null;
  }
  return null;
}
