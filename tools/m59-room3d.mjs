// m59-room3d.mjs -- render a Three.js top-down view of a room.
//
// Takes the room's walkability grid (base64 flags), dimensions, and
// entity positions, and returns a self-contained HTML page with an
// inline Three.js scene: floor, walls, and entity markers.
//
// The page uses an ES module import of Three.js from a CDN, so it
// needs no build step or bundled dependency.

export function renderRoom3D(name, rv) {
  if (!rv) return '<p>No room data available.</p>';
  const { cols, rows, objects, self } = rv;
  const grid = JSON.stringify(objects.map(o => ({
    x: o.col, y: o.row,
    type: o.is_self ? 'self' : o.is_player ? 'player' : 'npc',
    name: o.name,
  })));
  const selfPos = self ? JSON.stringify({ x: self.col, y: self.row }) : 'null';
  const wallGrid = JSON.stringify(rv.walkable ?? []);

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — Room View</title>
<meta http-equiv="refresh" content="15">
<style>
  body { margin:0; background:#111; color:#ccc; font:14px system-ui; }
  #canvas { display:block; width:100vw; height:100vh; }
  #hud { position:fixed; top:8px; left:8px; font-size:12px; color:#aaa;
    background:rgba(0,0,0,.6); padding:6px 10px; border-radius:4px;
    pointer-events:none; }
  a { color:#4a9; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="hud"><a href="/hero/${name}">&larr; ${name}</a> · ${cols}×${rows}</div>
<script type="module">
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';

const COLS = ${cols}, ROWS = ${rows};
const OBJECTS = ${grid};
const SELF = ${selfPos};
const WALKABLE = ${wallGrid};

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0f);
const camera = new THREE.PerspectiveCamera(50, innerWidth/innerHeight, 0.1, 500);
camera.position.set(COLS/2, ROWS/2, 60);
camera.lookAt(COLS/2, ROWS/2, 0);

const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('canvas'), antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(COLS/2, ROWS/2, 0);
controls.maxPolarAngle = Math.PI/2;
controls.update();

// Lights
scene.add(new THREE.AmbientLight(0x404040, 2));
const dir = new THREE.DirectionalLight(0xffffff, 1);
dir.position.set(COLS/2, ROWS/2, 30);
scene.add(dir);

// Floor
const floorGeo = new THREE.PlaneGeometry(COLS, ROWS);
const floorMat = new THREE.MeshLambertMaterial({ color: 0x1a1a2e });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI/2;
floor.position.set(COLS/2, ROWS/2, -0.01);
scene.add(floor);

// Grid lines
const gridHelper = new THREE.GridHelper(Math.max(COLS, ROWS), Math.max(COLS, ROWS), 0x222233, 0x1a1a2e);
gridHelper.position.set(COLS/2, ROWS/2, 0);
scene.add(gridHelper);

// Walls: one box per non-walkable cell
const wallMat = new THREE.MeshLambertMaterial({ color: 0x4a4a6a });
const wallGeo = new THREE.BoxGeometry(1, 1, 1);
const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, COLS * ROWS);
let wi = 0;
const dummy = new THREE.Object3D();
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const walkable = WALKABLE[r * COLS + c] === 1;
    if (walkable) continue;
    dummy.position.set(c + 0.5, r + 0.5, 0.5);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    wallMesh.setMatrixAt(wi++, dummy.matrix);
  }
}
wallMesh.count = wi;
wallMesh.instanceMatrix.needsUpdate = true;
scene.add(wallMesh);

// Entities
const entityColors = { self: 0x44ffaa, player: 0xff4444, npc: 0xffaa44 };
for (const o of OBJECTS) {
  const geo = new THREE.SphereGeometry(0.35, 16, 16);
  const mat = new THREE.MeshLambertMaterial({ color: entityColors[o.type] || 0xffffff,
    emissive: o.type === 'self' ? 0x228844 : 0x000000 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(o.x + 0.5, o.y + 0.5, 0.5);
  scene.add(mesh);

  // Label
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = '24px system-ui';
  ctx.fillStyle = o.type === 'self' ? '#44ffaa' : o.type === 'player' ? '#ff4444' : '#ffaa44';
  ctx.textAlign = 'center';
  ctx.fillText(o.name, 128, 40);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.position.set(o.x + 0.5, o.y + 0.5, 1.5);
  sprite.scale.set(3, 0.75, 1);
  scene.add(sprite);
}

// Self marker: a ring on the floor
if (SELF) {
  const ringGeo = new THREE.RingGeometry(0.5, 0.7, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x44ffaa, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI/2;
  ring.position.set(SELF.x + 0.5, SELF.y + 0.5, 0.02);
  scene.add(ring);
}

// Animate
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// Resize
addEventListener('resize', () => {
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
</script>
</body></html>`;
}
