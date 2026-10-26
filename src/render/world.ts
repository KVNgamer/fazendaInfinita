import * as THREE from 'three';
import { LANDS, landCenter } from '../core/lands';
import type { LandState } from '../core/lands';
import { GATE, HOUSE_POS, SHOP_POS, STORE_POS } from '../core/layout';
import type { Bounds } from '../core/layout';
import { labelTexture, treeTexture } from './pixelart';
import type { Sky } from './sky';

export interface Builder {
  scene: THREE.Scene;
  sky: Sky;
  billboard(mat: THREE.Material, w: number, h: number, x: number, y: number, z: number): THREE.Mesh;
  spriteMat(tex: THREE.Texture, alphaTest?: number): THREE.MeshBasicMaterial;
}

const lam = (c: number) => new THREE.MeshLambertMaterial({ color: c });

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function label(b: Builder, text: string, x: number, z: number, y: number, w: number, fs = 22): THREE.Mesh {
  return b.billboard(b.spriteMat(labelTexture(text, fs), 0), w, w / 4, x, y, z);
}

/** Tudo que nunca muda: chão, estrada, casa, armazém, mercado e árvores. */
export function buildWorld(b: Builder): void {
  const { scene } = b;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), lam(0x7fb35d));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.2;
  scene.add(ground);

  // estrada do portão até a fazenda e caminhos para a casa e o armazém
  const road = lam(0xc9ae7a);
  const strip = (cx: number, cz: number, w: number, d: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), road);
    m.rotation.x = -Math.PI / 2;
    m.position.set(cx, 0.012, cz);
    scene.add(m);
  };
  strip(-12.5, GATE.z, 24, 1.8);
  strip(-1.5, 3.5, 1.2, 3.4);
  strip(-1.5, -1.4, 1.2, 2.8);

  // casa
  const house = new THREE.Group();
  box(3, 2.2, 3, lam(0xe6d3a8), 0, 1.1, 0, house);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.7, 1.5, 4), lam(0xb4503c));
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 2.95;
  house.add(roof);
  box(0.06, 1.3, 0.8, lam(0x6b4429), 1.52, 0.65, 0, house);
  const win = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.6), b.sky.windowMat);
  win.position.set(1.52, 1.4, -1);
  house.add(win);
  house.position.set(HOUSE_POS.x, 0, HOUSE_POS.z);
  scene.add(house);

  // armazém
  const shed = new THREE.Group();
  box(2.6, 1.8, 2.6, lam(0x9a6b3d), 0, 0.9, 0, shed);
  const shedRoof = new THREE.Mesh(new THREE.ConeGeometry(2.3, 1.1, 4), lam(0x3d6b45));
  shedRoof.rotation.y = Math.PI / 4;
  shedRoof.position.y = 2.35;
  shed.add(shedRoof);
  box(0.06, 1.3, 1.1, lam(0x5b3a24), 1.32, 0.65, 0, shed);
  shed.position.set(STORE_POS.x, 0, STORE_POS.z);
  scene.add(shed);
  label(b, 'Armazém', STORE_POS.x, STORE_POS.z, 3.2, 2, 24);

  // mercado
  const wood = lam(0x8a6a42);
  const stall = new THREE.Group();
  box(2.2, 0.9, 1, lam(0x8a5a34), 0, 0.45, 0, stall);
  box(0.1, 1.9, 0.1, wood, -1.1, 0.95, 0.5, stall);
  box(0.1, 1.9, 0.1, wood, 1.1, 0.95, 0.5, stall);
  box(2.7, 0.1, 1.7, lam(0xc0463a), 0, 1.95, -0.1, stall).rotation.x = 0.18;
  for (const [x, y] of [[-0.6, 0.97], [0, 0.99], [0.6, 0.96]]) box(0.38, 0.22, 0.34, lam(0xc9a15a), x, y + 0.1, 0, stall);
  stall.position.set(SHOP_POS.x, 0, SHOP_POS.z);
  scene.add(stall);
  label(b, 'Mercado', SHOP_POS.x, SHOP_POS.z, 2.6, 2, 24);

  // árvores: só fora de todos os terrenos possíveis, para nunca nascerem no meio de um plantio
  const tree = b.spriteMat(treeTexture());
  const trees: Array<[number, number]> = [
    [-7, -6], [-7.5, -2], [3, -7], [9, -7], [15, -6], [22, -7], [28, -5], [-2, 24], [10, 24], [20, 24], [28, 14], [30, 3],
    [-7, 15], [-7, 10.5], [1, -5], [-7, 20], [-12, 2], [-14, 8], [-11, 9], [-13, 0.5], [-18, 8], [-19, 2], [-22, 6.5], [-15, -4],
    [34, 12], [5, 28], [-5, 28], [16, 28],
  ];
  for (const [x, z] of trees) {
    const inLand = LANDS.some((l) => x > l.x0 - 2.5 && x < l.x1 + 2.5 && z > l.z0 - 2.5 && z < l.z1 + 2.5);
    if (!inLand) b.billboard(tree, 2.2, 2.75, x, 1.37, z);
  }
}

export interface FenceHandles {
  group: THREE.Group;
  leafA: THREE.Group;
  leafB: THREE.Group;
}

/** Cerca e portão em volta dos terrenos comprados. Refeita quando a fazenda cresce. */
export function buildFence(bounds: Bounds): FenceHandles {
  const group = new THREE.Group();
  const wood = lam(0x8a6a42);
  const postGeo = new THREE.BoxGeometry(0.2, 1, 0.2);
  const post = (x: number, z: number) => {
    const p = new THREE.Mesh(postGeo, wood);
    p.position.set(x, 0.5, z);
    group.add(p);
  };
  const rail = (x0: number, z0: number, x1: number, z1: number) => {
    const alongZ = x0 === x1;
    const len = Math.abs(alongZ ? z1 - z0 : x1 - x0);
    for (const y of [0.35, 0.75]) box(alongZ ? 0.07 : len, 0.08, alongZ ? len : 0.07, wood, (x0 + x1) / 2, y, (z0 + z1) / 2, group);
  };
  const { x0, x1, z0, z1 } = bounds;
  for (let x = x0; x <= x1; x++) {
    post(x, z0);
    post(x, z1);
  }
  for (let z = z0 + 1; z < z1; z++) {
    post(x1, z);
    if (z < GATE.z0 || z > GATE.z1) post(x0, z);
  }
  rail(x0, z0, x1, z0);
  rail(x0, z1, x1, z1);
  rail(x1, z0, x1, z1);
  rail(x0, z0, x0, GATE.z0);
  rail(x0, GATE.z1, x0, z1);

  box(0.3, 1.8, 0.3, wood, x0, 0.9, GATE.z0, group);
  box(0.3, 1.8, 0.3, wood, x0, 0.9, GATE.z1, group);
  box(0.26, 0.24, 2.6, wood, x0, 1.78, GATE.z, group);
  const leaf = (z: number, side: number) => {
    const g = new THREE.Group();
    g.position.set(x0, 0, z);
    box(0.07, 0.85, 0.95, wood, 0, 0.55, side * 0.5, g);
    group.add(g);
    return g;
  };
  return { group, leafA: leaf(GATE.z0 + 0.14, 1), leafB: leaf(GATE.z1 - 0.14, -1) };
}

export interface SaleHandles {
  group: THREE.Group;
  /** Placas que sempre encaram a câmera. */
  bills: THREE.Mesh[];
  /** Materiais das placas, para tirar da lista de sprites ao refazer. */
  mats: THREE.MeshBasicMaterial[];
}

/** Terrenos fora da cerca: o próximo à venda destacado, os outros mais claros, os bloqueados em vermelho. */
export function buildSaleAreas(b: Builder, lands: readonly LandState[]): SaleHandles {
  const group = new THREE.Group();
  const bills: THREE.Mesh[] = [];
  const mats: THREE.MeshBasicMaterial[] = [];
  const saleLabel = (text: string, x: number, z: number, y: number, w: number, fs: number) => {
    const mat = new THREE.MeshBasicMaterial({ map: labelTexture(text, fs), transparent: true, side: THREE.DoubleSide });
    b.sky.tinted.push(mat);
    mats.push(mat);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), mat);
    m.position.set(x, y, z);
    group.add(m);
    bills.push(m);
  };
  const nextIndex = lands.findIndex((l) => !l.owned);
  LANDS.forEach((l, i) => {
    const s = lands[i];
    const owned = s.owned;
    if (i === 0 || (owned && !s.locked)) return;
    const w = l.x1 - l.x0 + 1;
    const d = l.z1 - l.z0 + 1;
    const c = landCenter(l);
    const locked = owned && s.locked;
    const color = locked ? 0xd9534f : 0xe8cf6a;
    const opacity = locked ? 0.45 : i === nextIndex ? 0.55 : 0.2;
    const g = new THREE.PlaneGeometry(w, d);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(c.x, 0.02, c.z);
    group.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: locked ? 0x8b1d1d : 0xb8860b }));
    e.rotation.x = -Math.PI / 2;
    e.position.set(c.x, 0.03, c.z);
    group.add(e);
    if (locked) saleLabel('Aluguel atrasado: ' + s.debt, c.x, c.z, 1.1, 4.2, 20);
    else if (i === nextIndex) saleLabel(l.name + ' · ' + l.price + ' · aluguel ' + l.rent + '/dia', c.x, c.z, 1.1, 5.2, 14);
  });
  return { group, bills, mats };
}
