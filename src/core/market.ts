/**
 * Mercado entre jogadores: tipos e regras que o servidor e o navegador compartilham.
 * Tudo que envolve dinheiro de verdade do jogo é decidido no servidor (src/server/market.ts).
 */
import type { ItemKey } from './items';
import type { Prio, WorkerCfg } from './workers';

export type ListingKind = 'item' | 'gear' | 'worker' | 'rent' | 'gold';
export type Currency = 'silver' | 'gold';

/** Taxa do mercado, cobrada de quem vende. Tira moeda de circulação. */
export const FEE_RATE = 0.05;
export const MAX_OPEN_LISTINGS = 20;
/** Quanto tempo (em dias reais) um anúncio fica aberto antes de voltar para o dono. */
export const LISTING_DAYS = 7;
export const RENT_MAX_DAYS = 14;
export const MAX_PRICE: Record<Currency, number> = { silver: 10_000_000, gold: 100_000 };

/** A taxa é 5%, arredondada para baixo, mas nunca menos de 1 (senão vender em pedacinhos escaparia dela). Preço 1 não paga taxa. */
export function marketFee(price: number): number {
  return price < 2 ? 0 : Math.max(1, Math.floor(price * FEE_RATE));
}

export function sellerGets(price: number): number {
  return price - marketFee(price);
}

/** O que se anuncia. Para aluguel, o preço é por dia do comprador e `days` é o prazo. */
export type SellSpec =
  | { what: 'item'; key: ItemKey; qty: number }
  | { what: 'gear'; id: string }
  | { what: 'worker'; name: string }
  | { what: 'gold'; qty: number }
  /** `to`: empréstimo a um amigo (anúncio privado, o preço pode ser 0). */
  | { what: 'rent'; name: string; days: number; to?: string };

/** Um trabalhador "embalado" para mudar de dono: a ficha e a ordem das tarefas, sem itens. */
export interface WorkerPackage {
  cfg: WorkerCfg;
  prios: Prio[];
}

export interface WorkerSummary {
  name: string;
  hp: number;
  lv: { plantio: number; regador: number; enxada: number; foice: number };
  abilities: string[];
}

export interface ListingView {
  id: number;
  seller: string;
  kind: ListingKind;
  /** Item, peça ou nome do trabalhador; 'gold' no anúncio de ouro. */
  key: string;
  qty: number;
  /** Preço total (venda) ou por dia (aluguel). */
  price: number;
  currency: Currency;
  status: 'open' | 'sold' | 'cancelled' | 'expired';
  mine: boolean;
  /** Dias reais até o anúncio vencer. */
  expiresInDays: number;
  /** Preço médio por unidade nas últimas vendas do mesmo item, se houver. */
  avg: number | null;
  worker?: WorkerSummary;
  /** Anúncio privado: para quem. */
  target?: string;
  rent?: { pricePerDay: number; days: number; total: number };
}

export interface RentalView {
  id: number;
  worker: string;
  /** O outro lado: quem alugou (se você é o dono) ou o dono (se você alugou). */
  other: string;
  pricePerDay: number;
  currency: Currency;
  daysLeft: number;
  daysTotal: number;
}

export interface MarketData {
  listings: ListingView[];
  mine: ListingView[];
  lent: RentalView[];
  rented: RentalView[];
  /** Nomes dos seus amigos, para emprestar trabalhadores. */
  friends: string[];
}

/** Aluguel de um trabalhador que está na fazenda de quem alugou. */
export interface Rental {
  /** O mesmo número do anúncio que originou o aluguel. */
  id: number;
  owner: string;
  daysLeft: number;
  pricePerDay: number;
  currency: Currency;
}
