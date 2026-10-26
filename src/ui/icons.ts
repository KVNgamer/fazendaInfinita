import type { ItemKey } from '../core/items';

const ICONS: Record<ItemKey, string> = {
  enxada: '<line x1="8" y1="27" x2="21" y2="8" stroke="#8a5a34" stroke-width="3" stroke-linecap="square"/><polygon points="17,5 28,9 24,15 15,10" fill="#9fb0bd"/>',
  regador: '<rect x="6" y="12" width="16" height="13" fill="#5b8fc9"/><polygon points="22,15 29,9 29,12 22,19" fill="#5b8fc9"/><path d="M8 12 Q14 4 20 12" stroke="#3d6a9e" stroke-width="2.5" fill="none"/>',
  foice: '<path d="M10 24 L12 12 Q13 5 25 6 Q17 9 16 14 L14 25 Z" fill="#9fb0bd"/><rect x="9" y="22" width="5" height="8" fill="#8a5a34"/>',
  semente: '<path d="M6 12 L26 12 L24 28 L8 28 Z" fill="#b99a62"/><rect x="10" y="7" width="12" height="6" fill="#8a6c3a"/><circle cx="16" cy="20" r="3" fill="#e9dcae"/>',
  batata: '<ellipse cx="16" cy="18" rx="10" ry="7" fill="#c9a15a"/><circle cx="12" cy="17" r="1.2" fill="#8a6c3a"/><circle cx="19" cy="20" r="1.2" fill="#8a6c3a"/>',
  pao: '<ellipse cx="16" cy="19" rx="12" ry="7" fill="#d9a05b"/><path d="M7 17 Q16 7 25 17" stroke="#a8742a" stroke-width="2" fill="none"/>',
  assada: '<ellipse cx="16" cy="20" rx="10" ry="7" fill="#b8793a"/><path d="M11 12 Q13 8 11 4 M18 12 Q20 8 18 4" stroke="#bbb" stroke-width="1.5" fill="none"/>',
};

export function iconSvg(key: ItemKey): string {
  return '<svg viewBox="0 0 32 32" aria-hidden="true">' + ICONS[key] + '</svg>';
}

export const EMPTY_ICON = '<svg viewBox="0 0 32 32" aria-hidden="true"></svg>';
