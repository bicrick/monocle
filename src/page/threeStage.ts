/**
 * Page-world Three.js stage. Bundled as IIFE and injected into the tab.
 * WebGL runs here (tab process) — not in the extension sandbox.
 */
import * as THREE from "three";
import { CANVAS_LONG_SIDE_CAP, capCanvasSize } from "../sandbox/safeCanvasDim";

declare global {
  interface Window {
    __monacleThreeStageInstalled?: boolean;
  }
}

// Successive APPLY_PATCH must not re-bind listeners / double-boot.
if (window.__monacleThreeStageInstalled) {
  // Still acknowledge so a host that re-injected waits for ready via ensure.
  window.postMessage(
    { source: "monacle-three-stage", type: "booted", reused: true },
    "*",
  );
} else {
  window.__monacleThreeStageInstalled = true;

const ROOT_ID = "monacle-three-root";
const HOST_SOURCE = "monacle-three-host";
const STAGE_SOURCE = "monacle-three-stage";
const ERROR_LIMIT = 3;

type Vec3 = [number, number, number];

interface AddSpec {
  id?: string;
  kind?: string;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3 | number;
  color?: string | number;
  size?: number;
  count?: number;
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  opacity?: number;
  visible?: boolean;
  parent?: string;
}

interface UpdateSpec {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3 | number;
  color?: string | number;
  visible?: boolean;
  opacity?: number;
}

interface CameraSpec {
  position?: Vec3;
  lookAt?: Vec3;
  fov?: number;
}

interface LightSpec {
  id?: string;
  kind?: string;
  color?: string | number;
  intensity?: number;
  position?: Vec3;
}

let root: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let rafId = 0;
let errorStreak = 0;
let running = false;
let seq = 0;
const registry = new Map<string, THREE.Object3D>();

function post(payload: Record<string, unknown>): void {
  window.postMessage({ source: STAGE_SOURCE, ...payload }, "*");
}

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}`;
}

function parseColor(value: string | number | undefined, fallback = 0xffffff): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      return new THREE.Color(value).getHex();
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function applyTransform(obj: THREE.Object3D, spec: UpdateSpec | AddSpec): void {
  if (spec.position) {
    obj.position.set(spec.position[0], spec.position[1], spec.position[2]);
  }
  if (spec.rotation) {
    obj.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
  }
  if (spec.scale != null) {
    if (typeof spec.scale === "number") {
      obj.scale.setScalar(spec.scale);
    } else {
      obj.scale.set(spec.scale[0], spec.scale[1], spec.scale[2]);
    }
  }
  if (typeof spec.visible === "boolean") obj.visible = spec.visible;
}

function ensureStage(): boolean {
  if (renderer && scene && camera && canvas) return true;
  try {
    root = document.getElementById(ROOT_ID) as HTMLDivElement | null;
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      Object.assign(root.style, {
        position: "fixed",
        inset: "0",
        // Above page body paint, under Monacle overlay/media (z≥1–2) and habitat panels.
        zIndex: "1",
        pointerEvents: "none",
        overflow: "hidden",
      });
      document.documentElement.insertBefore(
        root,
        document.documentElement.firstChild,
      );
    }

    canvas = root.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.setAttribute("data-monacle-three", "1");
      Object.assign(canvas.style, {
        position: "fixed",
        inset: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        display: "block",
      });
      root.appendChild(canvas);
    }

    const size = capCanvasSize(window.innerWidth || 1, window.innerHeight || 1);
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: "low-power",
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(size.width, size.height, false);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(
      55,
      size.width / Math.max(1, size.height),
      0.1,
      2000,
    );
    camera.position.set(0, 2.2, 8);
    camera.lookAt(0, 0, 0);

    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    amb.name = "monacle_ambient";
    scene.add(amb);
    registry.set("light_ambient", amb);

    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(4, 8, 5);
    dir.name = "monacle_dir";
    scene.add(dir);
    registry.set("light_dir", dir);

    canvas.addEventListener("webglcontextlost", onContextLost, false);
    window.addEventListener("resize", onWindowResize);
    lastW = 0;
    lastH = 0;
    resize(true);
    running = true;
    errorStreak = 0;
    tick();
    post({ type: "ready" });
    return true;
  } catch (err) {
    tearDown(String(err instanceof Error ? err.message : err));
    return false;
  }
}

function onContextLost(ev: Event): void {
  ev.preventDefault();
  tearDown("WebGL context lost");
}

let lastW = 0;
let lastH = 0;

function resize(force = false): void {
  if (!renderer || !camera || !canvas) return;
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  if (!force && vw === lastW && vh === lastH) return;
  lastW = vw;
  lastH = vh;
  const size = capCanvasSize(vw, vh);
  const aspect = size.width / Math.max(1, size.height);
  if (camera.aspect !== aspect) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
  renderer.setSize(size.width, size.height, false);
}

function onWindowResize(): void {
  resize(true);
}

function tick(): void {
  if (!running || !renderer || !scene || !camera) return;
  rafId = requestAnimationFrame(tick);
  try {
    renderer.render(scene, camera);
    errorStreak = 0;
  } catch (err) {
    errorStreak += 1;
    post({
      type: "error",
      fatal: errorStreak >= ERROR_LIMIT,
      message: err instanceof Error ? err.message : String(err),
    });
    if (errorStreak >= ERROR_LIMIT) {
      tearDown("Three.js frame errors exceeded limit");
    }
  }
}

function tearDown(reason?: string): void {
  running = false;
  window.removeEventListener("resize", onWindowResize);
  lastW = 0;
  lastH = 0;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  for (const obj of registry.values()) {
    disposeObject(obj);
  }
  registry.clear();
  if (renderer) {
    try {
      renderer.dispose();
    } catch {
      // ignore
    }
  }
  renderer = null;
  scene = null;
  camera = null;
  if (canvas) {
    canvas.removeEventListener("webglcontextlost", onContextLost, false);
    canvas.remove();
  }
  canvas = null;
  root?.remove();
  root = null;
  if (reason) post({ type: "error", fatal: true, message: reason });
  post({ type: "stopped" });
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (mat) {
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else (mat as THREE.Material).dispose();
    }
  });
  obj.removeFromParent();
}

function parentOf(spec: AddSpec): THREE.Object3D {
  if (spec.parent && registry.has(spec.parent)) {
    return registry.get(spec.parent)!;
  }
  return scene!;
}

function addObject(raw: AddSpec): string | null {
  if (!ensureStage() || !scene) return null;
  const kind = String(raw.kind || "mesh").toLowerCase();
  const id = String(raw.id || nextId(kind)).slice(0, 80);
  if (registry.has(id)) removeObject(id);

  let obj: THREE.Object3D | null = null;
  const color = parseColor(raw.color, 0xb0c4de);
  const opacity = typeof raw.opacity === "number" ? raw.opacity : 1;

  if (kind === "group") {
    obj = new THREE.Group();
  } else if (kind === "points" || kind === "starfield") {
    const count = Math.min(Math.max(Number(raw.count) || 200, 1), 800);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 40;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 24;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 40;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color,
      size: typeof raw.size === "number" ? raw.size : 0.06,
      sizeAttenuation: true,
      transparent: opacity < 1,
      opacity,
      depthWrite: false,
    });
    obj = new THREE.Points(geo, mat);
  } else if (kind === "sprite") {
    const mat = new THREE.SpriteMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      depthWrite: false,
    });
    obj = new THREE.Sprite(mat);
    const s = typeof raw.size === "number" ? raw.size : 1;
    obj.scale.set(s, s, 1);
  } else if (kind === "plane") {
    const geo = new THREE.PlaneGeometry(
      typeof raw.width === "number" ? raw.width : 20,
      typeof raw.height === "number" ? raw.height : 20,
    );
    const mat = new THREE.MeshStandardMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0.05,
    });
    obj = new THREE.Mesh(geo, mat);
  } else if (kind === "sphere") {
    const geo = new THREE.SphereGeometry(
      typeof raw.radius === "number" ? raw.radius : 1,
      24,
      16,
    );
    const mat = new THREE.MeshStandardMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      roughness: 0.65,
      metalness: 0.15,
    });
    obj = new THREE.Mesh(geo, mat);
  } else {
    // mesh / box default
    const geo = new THREE.BoxGeometry(
      typeof raw.width === "number" ? raw.width : 1,
      typeof raw.height === "number" ? raw.height : 1,
      typeof raw.depth === "number" ? raw.depth : 1,
    );
    const mat = new THREE.MeshStandardMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      roughness: 0.7,
      metalness: 0.1,
    });
    obj = new THREE.Mesh(geo, mat);
  }

  obj.name = id;
  applyTransform(obj, raw);
  parentOf(raw).add(obj);
  registry.set(id, obj);
  return id;
}

function updateObject(id: string, raw: UpdateSpec): boolean {
  const obj = registry.get(id);
  if (!obj) return false;
  applyTransform(obj, raw);
  if (raw.color != null || raw.opacity != null) {
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial | THREE.PointsMaterial | THREE.SpriteMaterial | undefined;
    if (mat && "color" in mat) {
      if (raw.color != null) mat.color.setHex(parseColor(raw.color));
      if (typeof raw.opacity === "number") {
        mat.opacity = raw.opacity;
        mat.transparent = raw.opacity < 1;
      }
    }
  }
  return true;
}

function removeObject(id: string): boolean {
  const obj = registry.get(id);
  if (!obj) return false;
  disposeObject(obj);
  registry.delete(id);
  return true;
}

function clearScene(): void {
  if (!ensureStage() || !scene) return;
  for (const [id, obj] of [...registry.entries()]) {
    if (id.startsWith("light_")) continue;
    disposeObject(obj);
    registry.delete(id);
  }
}

function setBackground(value: unknown): void {
  if (!ensureStage() || !scene || !renderer) return;
  if (value == null || value === "transparent" || value === false) {
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    return;
  }
  const hex = parseColor(value as string | number, 0x020408);
  scene.background = new THREE.Color(hex);
  renderer.setClearColor(hex, 1);
}

function setCamera(spec: CameraSpec): void {
  if (!ensureStage() || !camera) return;
  if (spec.position) {
    camera.position.set(spec.position[0], spec.position[1], spec.position[2]);
  }
  if (typeof spec.fov === "number" && spec.fov > 1) {
    camera.fov = spec.fov;
    camera.updateProjectionMatrix();
  }
  if (spec.lookAt) {
    camera.lookAt(spec.lookAt[0], spec.lookAt[1], spec.lookAt[2]);
  }
}

function setLights(list: LightSpec[]): void {
  if (!ensureStage() || !scene) return;
  for (const [id, obj] of [...registry.entries()]) {
    if (id.startsWith("light_") && id !== "light_ambient") {
      disposeObject(obj);
      registry.delete(id);
    }
  }
  for (const raw of list.slice(0, 8)) {
    const kind = String(raw.kind || "directional").toLowerCase();
    const id = String(raw.id || nextId("light")).slice(0, 80);
    const color = parseColor(raw.color, 0xffffff);
    const intensity = typeof raw.intensity === "number" ? raw.intensity : 0.8;
    let light: THREE.Light;
    if (kind === "ambient") {
      light = new THREE.AmbientLight(color, intensity);
    } else if (kind === "point") {
      light = new THREE.PointLight(color, intensity, 100);
      if (raw.position) light.position.set(raw.position[0], raw.position[1], raw.position[2]);
    } else {
      light = new THREE.DirectionalLight(color, intensity);
      if (raw.position) light.position.set(raw.position[0], raw.position[1], raw.position[2]);
      else light.position.set(4, 8, 5);
    }
    light.name = id;
    scene.add(light);
    registry.set(id, light);
  }
}

function handleCommand(cmd: string, args: unknown[]): unknown {
  switch (cmd) {
    case "ensure":
      return ensureStage();
    case "clear":
      clearScene();
      return true;
    case "setBackground":
      setBackground(args[0]);
      return true;
    case "add": {
      const spec =
        args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
          ? (args[0] as AddSpec)
          : {};
      return addObject(spec);
    }
    case "update": {
      const id = String(args[0] ?? "");
      const spec =
        args[1] && typeof args[1] === "object" && !Array.isArray(args[1])
          ? (args[1] as UpdateSpec)
          : {};
      return updateObject(id, spec);
    }
    case "remove":
      return removeObject(String(args[0] ?? ""));
    case "camera": {
      const spec =
        args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
          ? (args[0] as CameraSpec)
          : {};
      setCamera(spec);
      return true;
    }
    case "lights": {
      const list = Array.isArray(args[0]) ? (args[0] as LightSpec[]) : [];
      setLights(list);
      return true;
    }
    case "stop":
      tearDown();
      return true;
    case "cap":
      return CANVAS_LONG_SIDE_CAP;
    default:
      return null;
  }
}

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  if (!data || data.source !== HOST_SOURCE) return;
  if (data.type !== "monacle-three-cmd") return;
  try {
    const result = handleCommand(String(data.cmd ?? ""), Array.isArray(data.args) ? data.args : []);
    if (data.id != null) {
      post({ type: "result", id: data.id, result });
    }
  } catch (err) {
    post({
      type: "error",
      fatal: false,
      message: err instanceof Error ? err.message : String(err),
      id: data.id,
    });
  }
});

post({ type: "booted", cap: CANVAS_LONG_SIDE_CAP });

} // end idempotent install guard
