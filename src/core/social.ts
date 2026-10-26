/** Amigos, visitas e ajuda: tipos e limites que o servidor e o navegador compartilham. */

/** O que o dono deixa um amigo fazer na fazenda dele: 0 nada, 1 assistir, 2 assistir e ajudar. */
export type Permission = 0 | 1 | 2;

export const PERMISSION_NAME: Record<Permission, string> = { 0: 'Nada', 1: 'Assistir', 2: 'Assistir e ajudar' };

export const MAX_VISITORS = 5;
export const MAX_FRIENDS = 100;
export const MAX_PENDING = 20;

export interface FriendView {
  name: string;
  online: boolean;
  /** O que você deixa esse amigo fazer na sua fazenda. */
  iAllow: Permission;
  /** O que esse amigo deixa você fazer na fazenda dele. */
  theyAllow: Permission;
  /** Você pode visitar agora: ele está conectado, em casa, deixou e há vaga. */
  canVisit: boolean;
}

export interface SocialData {
  friends: FriendView[];
  /** Pedidos que você recebeu (nomes). */
  incoming: string[];
  /** Pedidos que você mandou e ainda esperam resposta. */
  outgoing: string[];
  blocked: string[];
  /** Quem está visitando você agora. */
  visitors: string[];
  /** De quem é a fazenda que você está visitando, se estiver. */
  visiting: string | null;
}

export type HelpAction = 'water' | 'harvest';
