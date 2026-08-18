// m59-room3d.mjs -- Three.js 3D room view.
//
// Coordinate mapping:
//   room (col, row)  ->  Three.js (x, 0, z)
//   Three.js Y is UP (height). Floor is at Y=0.
//   Camera looks down from above.

export function renderRoom3D(name, rv) {
  if (!rv) return `<!doctype html><html><body style="background:#111;color:#ccc;font:14px system-ui;padding:20px">
    <a href="/hero/${name}" style="color:#4a9">&larr; ${name}</a>
    <p>No room data available.</p></body></html>`;

  const { cols, rows, objects, self } = rv;
  const walkable = rv.walkable ?? [];
  const hasWalls = walkable.length === cols * rows && walkable.some(v => v === 0);

  const wallData = hasWalls ? JSON.stringify(walkable) : 'null';
  const objectsJson = JSON.stringify(objects.map(o => ({
    x: Math.min(Math.max(o.col, 0), cols - 1),
    z: Math.min(Math.max(o.row, 0), rows - 1),
    t: o.is_self ? 0 : o.is_player ? 1 : 2,
    n: o.name,
  })));
  const selfJson = self ? JSON.stringify({
    x: Math.min(Math.max(self.col, 0), cols - 1),
    z: Math.min(Math.max(self.row, 0), rows - 1),
  }) : 'null';

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
    padding:8px 14px; border-radius:8px; z-index:10; pointer-events:none; }
  #hud a { color:#4a9; text-decoration:none; pointer-events:auto; }
  #hud .dim { color:#666; font-size:11px; }
  #err { display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    color:#f88; font:13px system-ui; text-align:center; max-width:85vw; white-space:pre-wrap; z-index:20; }
</style>
</head>
<body>
<div id="hud">
  <a href="/hero/${name}">&larr; ${name}</a>
  <span class="dim"> &middot; ${cols}\\u00d7${rows}${hasWalls ? '' : ' &middot; unmapped'}</span>
</div>
<div id="err"></div>
<canvas id="c"></canvas>
<script type="module">
try {
const THREE = await import('/vendor/three.module.js');
const { OrbitControls } = await import('/vendor/OrbitControls.js');

const COLS = ${cols}, ROWS = ${rows};
const WALLS = ${wallData};
const OBJECTS = ${objectsJson};
const SELF = ${selfJson};

// Room (col, row) -> Three.js (x, z). Y is up.
// Floor center in Three.js: (COLS/2, 0, ROWS/2)
const FCX = COLS / 2, FCZ = ROWS / 2;

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a12);

// Camera: above and behind the room center, looking down at it
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 500);
camera.position.set(FCX, 50, FCZ + 40);
camera.lookAt(FCX, 0, FCZ);

const controls = new OrbitControls(camera, canvas);
controls.target.set(FCX, 0, FCZ);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.maxPolarAngle = Math.PI / 2.05;  // don't go under the floor
controls.minDistance = 15;
controls.maxDistance = 120;
controls.update();

// Lights
scene.add(new THREE.AmbientLight(0x8888aa, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(FCX + 30, 50, FCZ + 20);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
scene.add(sun);
const fill = new THREE.DirectionalLight(0x4466aa, 0.4);
fill.position.set(FCX - 30, 30, FCZ - 20);
scene.add(fill);

// Floor (XZ plane at Y=0)
const floorGeo = new THREE.PlaneGeometry(COLS, ROWS);
const floorMat = new THREE.MeshLambertMaterial({ color: 0x1e1e30 });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.set(FCX, 0, FCZ);
floor.receiveShadow = true;
scene.add(floor);

// Grid lines on the floor
const gridVerts = [];
for (let x = 0; x <= COLS; x++) {
  gridVerts.push(x, 0.01, 0, x, 0.01, ROWS);
}
for (let z = 0; z <= ROWS; z++) {
  gridVerts.push(0, 0.01, z, COLS, 0.01, z);
}
const gridGeo = new THREE.BufferGeometry();
gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridVerts, 3));
const gridMat = new THREE.LineBasicMaterial({ color: 0x2a2a40, transparent: true, opacity: 0.6 });
const grid = new THREE.LineSegments(gridGeo, gridMat);
grid.position.set(0, 0, 0);
scene.add(grid);

// Walls
if (WALLS) {
  const wallGeo = new THREE.BoxGeometry(1, 2, 1);
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x4a4a6a });
  let count = 0;
  for (let z = 0; z < ROWS; z++)
    for (let x = 0; x < COLS; x++)
      if (WALLS[z * COLS + x] === 0) count++;

  const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, count);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let i = 0;
  for (let z = 0; z < ROWS; z++) {
    for (let x = 0; x < COLS; x++) {
      if (WALLS[z * COLS + x] !== 0) continue;
      dummy.position.set(x + 0.5, 1, z + 0.5);
      dummy.updateMatrix();
      wallMesh.setMatrixAt(i++, dummy.matrix);
    }
  }
  wallMesh.instanceMatrix.needsUpdate = true;
  scene.add(wallMesh);
} else {
  // Unmapped room: border outline
  const b = 0.1;
  const borderGeo = new THREE.BufferGeometry();
  borderGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.1, 0, COLS, 0.1, 0,
    COLS, 0.1, 0, COLS, 0.1, ROWS,
    COLS, 0.1, ROWS, 0, 0.1, ROWS,
    0, 0.1, ROWS, 0, 0.1, 0,
  ], 3));
  const borderMat = new THREE.LineBasicMaterial({ color: 0x5566aa });
  scene.add(new THREE.LineSegments(borderGeo, borderMat));
}

// Entities
const colors = [0x44ffaa, 0xff4444, 0xffaa44];
for (const o of OBJECTS) {
  const x = o.x + 0.5;
  const z = o.z + 0.5;

  // Body (sphere)
  const r = o.t === 0 ? 0.45 : 0.3;
  const bodyGeo = new THREE.SphereGeometry(r, 16, 12);
  const bodyMat = new THREE.MeshLambertMaterial({
    color: colors[o.t],
    emissive: o.t === 0 ? 0x228844 : 0x000000,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.set(x, r + 0.1, z);
  body.castShadow = true;
  scene.add(body);

  // Self: ring on floor
  if (o.t === 0) {
    const ringGeo = new THREE.RingGeometry(0.5, 0.75, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x44ffaa, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.02, z);
    scene.add(ring);
  }

  // Label (sprite, always faces camera)
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 28px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#' + colors[o.t].toString(16).padStart(6, '0');
  ctx.fillText(o.n, 128, 44);
  const tex = new THREE.CanvasTexture(cv);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false,
  }));
  sprite.position.set(x, 2.0, z);
  sprite.scale.set(3.5, 0.9, 1);
  scene.add(sprite);
}

// Animate
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

// Resize
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

} catch (e) {
  document.getElementById('err').textContent =
    '3D error: ' + e.message + '\\n' + (e.stack || '').split('\\n').slice(0, 3).join('\\n');
  document.getElementById('err').style.display = 'block';
}
</script>
</body></html>`;
}
