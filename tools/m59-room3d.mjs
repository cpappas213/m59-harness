// m59-room3d.mjs -- Three.js 3D room view with mobile touch support.
//
// Uses Three.js from CDN (jsdelivr). Falls back to a message if the
// CDN is unreachable. Mobile: touch-drag to orbit, pinch to zoom.

export function renderRoom3D(name, rv) {
  if (!rv) return `<!doctype html><html><body style="background:#111;color:#ccc;font:14px system-ui;padding:20px">
    <a href="/hero/${name}" style="color:#4a9">&larr; ${name}</a>
    <p>No room data available.</p></body></html>`;

  const { cols, rows, objects, self } = rv;
  const walkable = rv.walkable ?? [];
  const hasWalls = walkable.length === cols * rows && walkable.some(v => v === 0);

  const wallData = hasWalls ? JSON.stringify(walkable) : 'null';
  const objectsJson = JSON.stringify(objects.map(o => ({
    x: o.col, y: o.row,
    t: o.is_self ? 0 : o.is_player ? 1 : 2,
    n: o.name,
  })));
  const selfJson = self ? JSON.stringify({ x: Math.min(self.col, cols - 1), y: Math.min(self.row, rows - 1) }) : 'null';

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${name} — 3D Room</title>
<meta http-equiv="refresh" content="15">
<style>
  * { margin:0; padding:0; }
  body { background:#0a0a12; overflow:hidden; touch-action:none; }
  canvas { display:block; width:100vw; height:100vh; }
  #hud { position:fixed; top:env(safe-area-inset-top,8px); left:8px;
    font:13px system-ui; color:#aaa; background:rgba(0,0,0,.75);
    padding:8px 14px; border-radius:8px; z-index:10; }
  #hud a { color:#4a9; text-decoration:none; }
  #hud .dim { color:#666; font-size:11px; }
  #err { display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    color:#f88; font:14px system-ui; text-align:center; max-width:80vw; }
</style>
</head>
<body>
<div id="hud">
  <a href="/hero/${name}">&larr; ${name}</a>
  <span class="dim"> &middot; ${cols}\\u00d7${rows}${hasWalls ? '' : ' &middot; unmapped'}</span>
</div>
<div id="err">Failed to load 3D renderer.<br>Check your internet connection.</div>
<canvas id="c"></canvas>

<script type="module">
try {
const THREE = await import('/vendor/three.module.js');
const { OrbitControls } = await import('/vendor/OrbitControls.js');

const COLS = ${cols}, ROWS = ${rows};
const WALLS = ${wallData};
const OBJECTS = ${objectsJson};
const SELF = ${selfJson};

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a12);

const cx = COLS / 2, cy = ROWS / 2;
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 500);
camera.position.set(cx, cy - 40, 30);
camera.lookAt(cx, cy, 0);

const controls = new OrbitControls(camera, canvas);
controls.target.set(cx, cy, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.maxPolarAngle = Math.PI / 2.1;
controls.minDistance = 10;
controls.maxDistance = 100;
controls.update();

// Lights
scene.add(new THREE.AmbientLight(0x8888aa, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(cx + 20, cy - 20, 40);
dir.castShadow = true;
scene.add(dir);
const dir2 = new THREE.DirectionalLight(0x4444ff, 0.3);
dir2.position.set(cx - 20, cy + 20, 20);
scene.add(dir2);

// Floor
const floorGeo = new THREE.PlaneGeometry(COLS, ROWS);
const floorMat = new THREE.MeshLambertMaterial({ color: 0x1a1a2e });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.set(cx, cy, -0.05);
floor.receiveShadow = true;
scene.add(floor);

// Grid
const gridGeo = new THREE.BufferGeometry();
const gridVerts = [];
for (let x = 0; x <= COLS; x++) {
  gridVerts.push(x, 0, 0, x, 0, ROWS);
}
for (let y = 0; y <= ROWS; y++) {
  gridVerts.push(0, y, 0, COLS, y, 0);
}
gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridVerts, 3));
const gridMat = new THREE.LineBasicMaterial({ color: 0x222233, transparent: true, opacity: 0.5 });
scene.add(new THREE.LineSegments(gridGeo, gridMat));

// Walls (instanced)
if (WALLS) {
  const wallGeo = new THREE.BoxGeometry(1, 1.5, 1);
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x4a4a6a });
  let count = 0;
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (WALLS[y * COLS + x] === 0) count++;

  const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, count);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let i = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (WALLS[y * COLS + x] !== 0) continue;
      dummy.position.set(x + 0.5, cy + 0.75, y + 0.5);
      dummy.updateMatrix();
      wallMesh.setMatrixAt(i++, dummy.matrix);
    }
  }
  wallMesh.instanceMatrix.needsUpdate = true;
  scene.add(wallMesh);
} else {
  // Unmapped room: draw a border so the room shape is visible
  const borderGeo = new THREE.BufferGeometry();
  const b = 0.25;
  borderGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, COLS, 0, 0,
    COLS, 0, 0, COLS, 0, ROWS,
    COLS, 0, ROWS, 0, 0, ROWS,
    0, 0, ROWS, 0, 0, 0,
  ], 3));
  const borderMat = new THREE.LineBasicMaterial({ color: 0x4a4a6a, linewidth: 2 });
  const border = new THREE.LineSegments(borderGeo, borderMat);
  border.position.set(0, cy + 0.1, 0);
  scene.add(border);
}

// Entities
const colors = { 0: 0x44ffaa, 1: 0xff4444, 2: 0xffaa44 };
for (const o of OBJECTS) {
  const x = Math.min(o.x, COLS - 1) + 0.5;
  const z = Math.min(o.y, ROWS - 1) + 0.5;

  // Body
  const geo = new THREE.SphereGeometry(o.t === 0 ? 0.4 : 0.3, 16, 16);
  const mat = new THREE.MeshLambertMaterial({
    color: colors[o.t],
    emissive: o.t === 0 ? 0x228844 : 0x000000,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, cy + 0.5, z);
  mesh.castShadow = true;
  scene.add(mesh);

  // Self: floor ring
  if (o.t === 0) {
    const ringGeo = new THREE.RingGeometry(0.5, 0.7, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x44ffaa, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, cy + 0.02, z);
    scene.add(ring);
  }

  // Label sprite
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 28px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#' + colors[o.t].toString(16).padStart(6, '0');
  ctx.fillText(o.n, 128, 44);
  const tex = new THREE.CanvasTexture(cv);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.position.set(x, cy + 1.8, z);
  sprite.scale.set(3, 0.75, 1);
  scene.add(sprite);
}

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// Resize
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

} catch (e) {
  document.getElementById('err').style.display = 'block';
  console.error('3D render failed:', e);
}
</script>
</body></html>`;
}
