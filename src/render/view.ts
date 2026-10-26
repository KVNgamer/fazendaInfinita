import * as THREE from 'three';
import { stageOf } from '../core/farm';
import type { Tile } from '../core/farm';
import type { Game } from '../core/game';
import { GATE } from '../core/layout';
import type { Worker } from '../core/workers';
import { Sky } from './sky';
import { buildFence, buildSaleAreas, buildWorld } from './world';
import type { FenceHandles, SaleHandles } from './world';
import { characterTexture, cropTexture } from './pixelart';

// mantém as cores do jeito que foram desenhadas (sem correção de gama)
THREE.ColorManagement.enabled = false;

const CROP_H = 1.15;
const FOOT_OFFSET = ((32 - 28) / 32) * CROP_H;

interface CharView {
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
  shadowMat: THREE.MeshBasicMaterial;
  bar: THREE.Mesh;
  fill: THREE.Mesh;
}

export class View {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 200);
  private readonly sky: Sky;
  private readonly bills: THREE.Object3D[] = [];
  private fence: FenceHandles | null = null;
  private fenceSig = '';
  private sale: SaleHandles | null = null;
  private saleSig = '';
  private readonly tileMeshes: THREE.Mesh[] = [];
  private readonly crops: THREE.Mesh[] = [];
  private readonly cropMats: THREE.MeshBasicMaterial[];
  private readonly tileGeo = new THREE.BoxGeometry(0.94, 0.2, 0.94);
  private readonly tileMats: Record<'raw' | 'tilled' | 'dry' | 'wet' | 'locked', THREE.MeshLambertMaterial>;
  private readonly chars = new Map<Worker, CharView>();
  private readonly highlight: THREE.Mesh;
  private gateOpen = 0;
  private yawS = Math.PI * 0.2;
  private tiltS = (40 * Math.PI) / 180;
  private readonly target = new THREE.Vector3(3.5, 0, 4);
  private readonly reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  /** Fazenda de um amigo sendo assistida (câmera de espectador, sem controlar nada). */
  private visiting = false;
  private hostAvatar: CharView | null = null;
  private hover: { i: number; j: number } | null = null;
  private readonly ray = new THREE.Raycaster();

  constructor(host: HTMLElement, private game: Game) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    host.insertBefore(this.canvas, host.firstChild);
    this.camera.rotation.order = 'YXZ';

    this.sky = new Sky(this.scene);
    this.builder = {
      scene: this.scene,
      sky: this.sky,
      billboard: (mat, w, h, x, y, z) => this.billboard(mat, w, h, x, y, z),
      spriteMat: (tex, at) => this.spriteMat(tex, at),
    };
    buildWorld(this.builder);

    this.cropMats = [0, 1, 2, 3].map((s) => this.spriteMat(cropTexture(s)));
    this.tileMats = {
      raw: new THREE.MeshLambertMaterial({ color: 0x93c46b }),
      tilled: new THREE.MeshLambertMaterial({ color: 0x86613f }),
      dry: new THREE.MeshLambertMaterial({ color: 0x6a4529 }),
      wet: new THREE.MeshLambertMaterial({ color: 0x36200f }),
      locked: new THREE.MeshLambertMaterial({ color: 0x8a5a55 }),
    };

    this.highlight = new THREE.Mesh(
      new THREE.PlaneGeometry(0.98, 0.98),
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.4 }),
    );
    this.highlight.rotation.x = -Math.PI / 2;
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  private readonly builder: Parameters<typeof buildWorld>[0];

  /** Troca o mundo desenhado: a sua fazenda ou a de um amigo que você visita. */
  setSource(game: Game, visiting: boolean): void {
    this.game = game;
    this.visiting = visiting;
    this.hover = null;
    this.fenceSig = '';
    this.saleSig = '';
    if (!visiting && this.hostAvatar) this.hostAvatar.mesh.visible = this.hostAvatar.shadow.visible = false;
  }

  /** Solo sob o ponteiro (só vale no modo espectador). */
  pickTile(clientX: number, clientY: number): { i: number; j: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * 2 - 1;
    const y = -((clientY - r.top) / r.height) * 2 + 1;
    this.ray.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    if (d.y >= -1e-6) return null;
    const t = -o.y / d.y;
    const i = Math.round(o.x + d.x * t);
    const j = Math.round(o.z + d.z * t);
    return this.game.farm.at(i, j) ? { i, j } : null;
  }

  /** Destaca o solo sob o ponteiro (ou nenhum). */
  setHover(tile: { i: number; j: number } | null): void {
    this.hover = tile;
  }

  private spriteMat(tex: THREE.Texture, alphaTest = 0.5): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest, side: THREE.DoubleSide });
    this.sky.tinted.push(m);
    return m;
  }

  private billboard(mat: THREE.Material, w: number, h: number, x: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(x, y, z);
    this.scene.add(m);
    this.bills.push(m);
    return m;
  }

  private makeChar(look: string): CharView {
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 });
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.4, 16), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.03;
    this.scene.add(shadow);
    const mesh = this.billboard(this.spriteMat(characterTexture(look), 0.02), 1.6, 1.6, 0, 0.83, 0);
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.1), new THREE.MeshBasicMaterial({ color: 0x223322 }));
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.1), new THREE.MeshBasicMaterial({ color: 0x4fd067 }));
    fill.position.z = 0.002;
    bar.add(fill);
    bar.position.set(0, 0.98, 0.01);
    mesh.add(bar);
    mesh.visible = false;
    shadow.visible = false;
    return { mesh, shadow, shadowMat, bar, fill };
  }

  private removeChar(c: CharView): void {
    this.scene.remove(c.mesh, c.shadow);
    const i = this.bills.indexOf(c.mesh);
    if (i >= 0) this.bills.splice(i, 1);
    const mat = c.mesh.material as THREE.MeshBasicMaterial;
    const t = this.sky.tinted.indexOf(mat);
    if (t >= 0) this.sky.tinted.splice(t, 1);
    mat.map?.dispose();
    mat.dispose();
  }

  resize(): void {
    const host = this.canvas.parentElement!;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Arrastar no modo espectador gira a câmera em volta da fazenda. */
  orbit(dx: number, dy: number): void {
    this.yawS -= dx * 0.006;
    this.tiltS = Math.max(0.3, Math.min(1.3, this.tiltS + dy * 0.005));
  }

  /** A cerca e as placas de terrenos só são refeitas quando a fazenda muda. */
  private syncStructures(): void {
    const g = this.game;
    const b = g.bounds;
    const fenceSig = [b.x0, b.x1, b.z0, b.z1].join(',');
    if (fenceSig !== this.fenceSig) {
      this.fenceSig = fenceSig;
      if (this.fence) {
        this.scene.remove(this.fence.group);
        this.fence.group.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
      }
      this.fence = buildFence(b);
      this.scene.add(this.fence.group);
    }
    const saleSig = g.lands.map((l) => (l.owned ? 1 : 0) + ':' + (l.locked ? l.debt : 0)).join('|');
    if (saleSig !== this.saleSig) {
      this.saleSig = saleSig;
      if (this.sale) {
        this.scene.remove(this.sale.group);
        for (const m of this.sale.mats) {
          const i = this.sky.tinted.indexOf(m);
          if (i >= 0) this.sky.tinted.splice(i, 1);
          m.map?.dispose();
          m.dispose();
        }
        this.sale.group.traverse((o) => {
          if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
        });
      }
      this.sale = buildSaleAreas(this.builder, g.lands);
      this.scene.add(this.sale.group);
    }
  }

  private syncFarm(): void {
    const tiles = this.game.farm.tiles;
    // solos de terrenos novos ganham malha e planta
    while (this.tileMeshes.length < tiles.length) {
      const t: Tile = tiles[this.tileMeshes.length];
      const m = new THREE.Mesh(this.tileGeo, this.tileMats.raw);
      m.position.set(t.i, -0.1, t.j);
      this.scene.add(m);
      this.tileMeshes.push(m);
      const c = this.billboard(this.cropMats[0], CROP_H, CROP_H, t.i, 0.02 - FOOT_OFFSET + CROP_H / 2, t.j);
      c.visible = false;
      this.crops.push(c);
    }
    // ao recomeçar, sobram malhas de terrenos que não existem mais
    while (this.tileMeshes.length > tiles.length) {
      this.scene.remove(this.tileMeshes.pop()!);
      const c = this.crops.pop()!;
      this.scene.remove(c);
      const i = this.bills.indexOf(c);
      if (i >= 0) this.bills.splice(i, 1);
    }
    for (let k = 0; k < tiles.length; k++) {
      const t = tiles[k];
      const mesh = this.tileMeshes[k];
      mesh.position.set(t.i, -0.1, t.j);
      this.crops[k].position.x = t.i;
      this.crops[k].position.z = t.j;
      mesh.material = t.locked
        ? this.tileMats.locked
        : t.state === 'raw' ? this.tileMats.raw : t.state === 'tilled' ? this.tileMats.tilled : t.wet ? this.tileMats.wet : this.tileMats.dry;
      const crop = this.crops[k];
      crop.visible = t.state === 'planted';
      if (crop.visible) crop.material = this.cropMats[stageOf(t.age)];
    }
  }

  render(now: number): void {
    const g = this.game;
    const spec = g.mode === 'spec' || this.visiting;
    const wantFov = spec ? 36 : 72;
    if (this.camera.fov !== wantFov) {
      this.camera.fov = wantFov;
      this.camera.updateProjectionMatrix();
    }
    this.sky.update(g.clock);
    this.syncStructures();
    this.syncFarm();

    if (!spec) {
      const p = g.player;
      this.camera.position.set(p.x, 1.55, p.z);
      this.camera.rotation.set(p.pitch, p.yaw, 0);
      const t = g.paused ? null : g.targetTile();
      this.highlight.visible = !!t;
      if (t) this.highlight.position.set(t.i, 0.025, t.j);
    } else {
      this.highlight.visible = !!this.hover && this.visiting;
      if (this.hover) this.highlight.position.set(this.hover.i, 0.025, this.hover.j);
      const b = g.bounds;
      // a câmera acompanha o tamanho da fazenda
      this.target.set((b.x1 - 3) / 2, 0, (b.z1 - 3) / 2);
      const d = 24 + Math.max(b.x1, b.z1) * 0.6;
      this.camera.position.set(
        this.target.x + Math.sin(this.yawS) * Math.cos(this.tiltS) * d,
        Math.sin(this.tiltS) * d,
        this.target.z + Math.cos(this.yawS) * Math.cos(this.tiltS) * d,
      );
      this.camera.lookAt(this.target);
    }

    // trabalhadores: cria o desenho de quem chegou e tira o de quem saiu (ao recomeçar)
    for (const w of g.workers) if (!this.chars.has(w)) this.chars.set(w, this.makeChar(w.cfg.look));
    for (const [w, c] of this.chars) {
      if (!g.workers.includes(w)) {
        this.removeChar(c);
        this.chars.delete(w);
      }
    }
    let gateBusy = false;
    const gateX = g.bounds.x0;
    for (const w of g.workers) {
      const c = this.chars.get(w)!;
      // aparece e some devagar no fim da estrada
      const fade = w.visible ? Math.max(0, Math.min(1, (w.x + 17) / 3)) : 0;
      c.mesh.visible = w.visible && fade > 0.02;
      c.shadow.visible = c.mesh.visible;
      if (!w.visible) continue;
      if (Math.abs(w.x - gateX) < 3.5 && Math.abs(w.z - GATE.z) < 2) gateBusy = true;
      const hop = !this.reduceMotion && w.moving ? Math.max(0, Math.sin(now / 110)) * 0.08 : 0;
      c.mesh.position.set(w.x, 0.83 + hop, w.z);
      c.shadow.position.set(w.x, 0.03, w.z);
      (c.mesh.material as THREE.MeshBasicMaterial).opacity = fade;
      c.shadowMat.opacity = 0.25 * fade;
      c.bar.visible = fade > 0.9;
      const e = w.energy / w.maxEnergy;
      c.fill.scale.x = Math.max(0.001, e);
      c.fill.position.x = -0.35 * (1 - e);
      (c.fill.material as THREE.MeshBasicMaterial).color.set(e > 0.3 ? 0x4fd067 : 0xe6a93a);
    }
    this.gateOpen += ((gateBusy ? 1 : 0) - this.gateOpen) * 0.12;
    if (this.fence) {
      this.fence.leafA.rotation.y = -this.gateOpen * 1.35;
      this.fence.leafB.rotation.y = this.gateOpen * 1.35;
    }

    // o dono da fazenda visitada aparece onde ele está
    if (this.visiting) {
      const a = (this.hostAvatar ??= this.makeChar('tiao'));
      a.mesh.visible = a.shadow.visible = true;
      a.bar.visible = false;
      a.mesh.position.set(g.player.x, 0.83, g.player.z);
      a.shadow.position.set(g.player.x, 0.03, g.player.z);
    }

    this.sky.stars.position.copy(this.camera.position);
    const face = (b: THREE.Object3D) => {
      b.rotation.y = Math.atan2(this.camera.position.x - b.position.x, this.camera.position.z - b.position.z);
    };
    for (const b of this.bills) face(b);
    if (this.sale) for (const b of this.sale.bills) face(b);
    this.renderer.render(this.scene, this.camera);
  }
}
