/** Pixel art desenhado em código: personagem, plantas e árvore. Cada sprite vira uma textura. */
import * as THREE from 'three';

export const SPR: readonly string[] = [
  '....hhhh....',
  '...hhhhhh...',
  '..hhhhhhhh..',
  '...ssssss...',
  '...skssks...',
  '...ssssss...',
  '..tttttttt..',
  '.stttttttts.',
  '.stttttttts.',
  '..tttttttt..',
  '..pppppppp..',
  '..pppppppp..',
  '..pp....pp..',
  '..bb....bb..',
  '.bbb....bbb.',
];

export type Palette = Record<'h' | 's' | 'k' | 't' | 'p' | 'b', string>;

export const PALETTES: Record<string, Palette> = {
  tiao: { h: '#e0b24a', s: '#f1c9a0', k: '#222', t: '#3b8fd9', p: '#4a4a6a', b: '#5b3a24' },
  zeca: { h: '#d9534f', s: '#e2b48a', k: '#222', t: '#3fa34d', p: '#3a3a52', b: '#5b3a24' },
  v1: { h: '#c0392b', s: '#f1c9a0', k: '#222', t: '#2e86c1', p: '#34495e', b: '#4a2f1d' },
  v2: { h: '#27ae60', s: '#d9a77a', k: '#222', t: '#f39c12', p: '#2c3e50', b: '#3a2a1c' },
  v3: { h: '#8e44ad', s: '#f5d0b0', k: '#222', t: '#1abc9c', p: '#4a235a', b: '#2e1e12' },
  v4: { h: '#2c3e50', s: '#c68e65', k: '#222', t: '#e74c3c', p: '#5d4037', b: '#2e1e12' },
  v5: { h: '#f1c40f', s: '#e8b78d', k: '#222', t: '#8e44ad', p: '#1b4f72', b: '#4a2f1d' },
  v6: { h: '#16a085', s: '#b9805a', k: '#222', t: '#ecf0f1', p: '#34495e', b: '#3a2a1c' },
  v7: { h: '#d35400', s: '#f1c9a0', k: '#222', t: '#27ae60', p: '#4e342e', b: '#2e1e12' },
  v8: { h: '#7f8c8d', s: '#e2b48a', k: '#222', t: '#c0392b', p: '#2c3e50', b: '#4a2f1d' },
  cida: { h: '#8e5cc4', s: '#e9bd96', k: '#222', t: '#d9a441', p: '#3d3558', b: '#4a2f3a' },
  eu: { h: '#e8e8e8', s: '#f1c9a0', k: '#222', t: '#c98a0a', p: '#2e2e44', b: '#3a2a1c' },
};

type Rect = readonly [number, number, number, number, string];

const G1 = '#3f9a4c';
const G2 = '#2c7a3a';
const G3 = '#63b862';
const MOUND: Rect[] = [[-7, -1, 14, 3, '#5b3a24'], [-5, -2, 10, 1, '#6b4630']];

/** Retângulos relativos ao pé da planta, por estágio (0 semente a 3 pronta). */
export const CROP_RECTS: readonly (readonly Rect[])[] = [
  [...MOUND, [-3, -3, 2, 2, '#d8b878'], [2, -3, 2, 2, '#d8b878']],
  [...MOUND, [-1, -9, 2, 8, G2], [-6, -10, 6, 3, G1], [1, -12, 6, 3, G3]],
  [...MOUND, [-1, -17, 2, 16, G2], [-10, -9, 8, 4, G1], [2, -12, 9, 4, G3], [-8, -15, 7, 4, G3], [1, -19, 8, 4, G1], [-3, -22, 6, 4, G3]],
  [
    ...MOUND,
    [-1, -17, 2, 16, G2], [-11, -9, 9, 4, G1], [2, -12, 10, 4, G3], [-9, -15, 8, 4, G3], [1, -19, 8, 4, G1], [-3, -22, 6, 4, G3],
    [-6, -24, 3, 3, '#fff'], [5, -22, 3, 3, '#fff'],
    [-8, -3, 6, 4, '#d8b26a'], [1, -4, 7, 5, '#d8b26a'], [-3, 0, 5, 3, '#d8b26a'],
    [8, -28, 2, 6, '#f2c94c'], [6, -26, 6, 2, '#f2c94c'],
  ],
];

export function makeTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, smooth = false): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  const t = new THREE.CanvasTexture(canvas);
  t.generateMipmaps = false;
  t.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
  t.minFilter = t.magFilter;
  return t;
}

export function cropTexture(stage: number): THREE.CanvasTexture {
  return makeTexture(32, 32, (c) => {
    for (const [x, y, w, h, color] of CROP_RECTS[stage]) {
      c.fillStyle = color;
      c.fillRect(16 + x, 28 + y, w, h);
    }
  });
}

export function characterTexture(look: string): THREE.CanvasTexture {
  const pal = PALETTES[look] ?? PALETTES.tiao;
  return makeTexture(16, 16, (c) => {
    SPR.forEach((row, r) => {
      for (let col = 0; col < row.length; col++) {
        const ch = row[col];
        if (ch === '.') continue;
        c.fillStyle = pal[ch as keyof Palette];
        c.fillRect(col + 2, r, 1, 1);
      }
    });
  });
}

export function treeTexture(): THREE.CanvasTexture {
  return makeTexture(32, 40, (c) => {
    c.fillStyle = '#6b4429';
    c.fillRect(14, 26, 5, 13);
    c.fillStyle = '#2c7a3a';
    c.fillRect(5, 12, 22, 15);
    c.fillRect(9, 5, 14, 10);
    c.fillStyle = '#3f9a4c';
    c.fillRect(8, 10, 10, 8);
    c.fillRect(13, 6, 8, 6);
  });
}

export function labelTexture(text: string, fontSize = 22): THREE.CanvasTexture {
  return makeTexture(256, 64, (c) => {
    c.fillStyle = 'rgba(255,255,255,.88)';
    c.fillRect(0, 10, 256, 44);
    c.fillStyle = '#4a3a08';
    c.font = 'bold ' + fontSize + 'px monospace';
    c.textAlign = 'center';
    c.fillText(text, 128, 40);
  }, true);
}
