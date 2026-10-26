import * as THREE from 'three';

/** [minuto, cor do céu, luz ambiente, sol, brilho dos sprites]. O amanhecer é escuro, o meio do dia claro, a noite escura. */
const KEYS: ReadonlyArray<readonly [number, string, number, number, number]> = [
  [360, '#56658f', 0.45, 0.15, 0.6],
  [420, '#e0a88a', 0.65, 0.35, 0.75],
  [510, '#9fd4ef', 0.85, 0.55, 1],
  [960, '#9fd4ef', 0.85, 0.55, 1],
  [1080, '#e8985e', 0.65, 0.3, 0.8],
  [1200, '#3b3f6b', 0.4, 0.1, 0.55],
  [1320, '#141a33', 0.28, 0.05, 0.4],
  [1560, '#0c1226', 0.25, 0.04, 0.35],
];

/** Nas versões atuais do Three.js a luz é fisicamente correta; este fator mantém o mesmo brilho dos protótipos. */
const LIGHT_K = Math.PI;

export interface SkyState {
  brightness: number;
  night: number;
}

export class Sky {
  readonly ambient = new THREE.AmbientLight(0xffffff, 0.85 * LIGHT_K);
  readonly sun = new THREE.DirectionalLight(0xffffff, 0.55 * LIGHT_K);
  readonly stars: THREE.Points;
  private readonly starMat: THREE.PointsMaterial;
  private readonly a = new THREE.Color();
  private readonly b = new THREE.Color();
  private readonly color = new THREE.Color();
  /** Materiais de sprites, que não recebem luz e por isso são escurecidos à mão. */
  readonly tinted: THREE.MeshBasicMaterial[] = [];
  /** Janela da casa: acende à noite. */
  readonly windowMat = new THREE.MeshBasicMaterial({ color: 0x9fd3ec });
  private readonly winDay = new THREE.Color('#9fd3ec');
  private readonly winNight = new THREE.Color('#ffd36b');

  constructor(private readonly scene: THREE.Scene) {
    this.scene.background = new THREE.Color('#9fd4ef');
    this.scene.fog = new THREE.Fog('#9fd4ef', 45, 110);
    this.sun.position.set(6, 12, 4);
    this.scene.add(this.ambient, this.sun);

    const pos: number[] = [];
    for (let i = 0; i < 260; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * 1.2 + 0.1;
      pos.push(Math.cos(th) * Math.cos(ph) * 90, Math.sin(ph) * 90, Math.sin(th) * Math.cos(ph) * 90);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.stars = new THREE.Points(geo, this.starMat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  update(clock: number): SkyState {
    const m = Math.max(360, Math.min(1560, clock));
    let k = 0;
    while (k < KEYS.length - 2 && m > KEYS[k + 1][0]) k++;
    const [t0, c0, a0, s0, b0] = KEYS[k];
    const [t1, c1, a1, s1, b1] = KEYS[k + 1];
    const f = Math.max(0, Math.min(1, (m - t0) / (t1 - t0)));
    this.a.set(c0);
    this.b.set(c1);
    this.color.copy(this.a).lerp(this.b, f);
    (this.scene.background as THREE.Color).copy(this.color);
    (this.scene.fog as THREE.Fog).color.copy(this.color);
    this.ambient.intensity = (a0 + (a1 - a0) * f) * LIGHT_K;
    this.sun.intensity = (s0 + (s1 - s0) * f) * LIGHT_K;
    const br = b0 + (b1 - b0) * f;
    const night = Math.max(0, Math.min(1, (0.8 - br) / 0.4));
    for (const mat of this.tinted) mat.color.setRGB(br * (1 - 0.12 * night), br * (1 - 0.05 * night), br);
    this.starMat.opacity = night;
    this.windowMat.color.copy(this.winDay).lerp(this.winNight, night);
    return { brightness: br, night };
  }
}
