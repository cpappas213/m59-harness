// m59-room3d.mjs -- zero-dependency isometric room renderer.
//
// Canvas 2D isometric projection. No Three.js, no CDN, no imports.
// Renders: floor tiles, wall tiles (raised), entity markers, labels.
// The page auto-refreshes every 15 seconds.

export function renderRoom3D(name, rv) {
  if (!rv) return `<!doctype html><html><body style="background:#111;color:#ccc;font:14px system-ui;padding:20px">
    <a href="/hero/${name}" style="color:#4a9">&larr; ${name}</a>
    <p>No room data available.</p></body></html>`;

  const { cols, rows, objects, self } = rv;
  const walkable = rv.walkable ?? [];
  const hasWalls = walkable.length === cols * rows && walkable.some(v => v === 0);

  // Build the wall grid as a compact JSON array (0=wall, 1=floor)
  const wallData = hasWalls ? JSON.stringify(walkable) : 'null';
  const objectsJson = JSON.stringify(objects.map(o => ({
    x: o.col, y: o.row,
    t: o.is_self ? 0 : o.is_player ? 1 : 2,
    n: o.name,
  })));
  const selfJson = self ? JSON.stringify({ x: self.col, y: self.row }) : 'null';

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — Room</title>
<meta http-equiv="refresh" content="15">
<style>
  body { margin:0; background:#0a0a12; overflow:hidden; }
  canvas { display:block; }
  #hud { position:fixed; top:8px; left:8px; font:12px system-ui; color:#aaa;
    background:rgba(0,0,0,.7); padding:6px 12px; border-radius:6px; }
  #hud a { color:#4a9; text-decoration:none; }
  #legend { position:fixed; bottom:8px; left:8px; font:11px system-ui; color:#888;
    background:rgba(0,0,0,.7); padding:6px 12px; border-radius:6px; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; vertical-align:middle; margin-right:4px; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="hud"><a href="/hero/${name}">&larr; ${name}</a> &middot; ${cols}\\u00d7${rows}${hasWalls ? '' : ' &middot; <span style="color:#666">unmapped</span>'}</div>
<div id="legend">
  <span class="dot" style="background:#4fa"></span>self
  <span class="dot" style="background:#fa4;margin-left:12px"></span>player
  <span class="dot" style="background:#fa0;margin-left:12px"></span>npc
  <span class="dot" style="background:#556;margin-left:12px"></span>wall
</div>
<script>
// Isometric room renderer — zero dependencies.
const COLS = ${cols}, ROWS = ${rows};
const WALLS = ${wallData}; // null if unmapped
const OBJECTS = ${objectsJson};
const SELF = ${selfJson};

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H, scale, ox, oy;

// Isometric projection:
//   screenX = (x - y) * tileW/2 + ox
//   screenY = (x + y) * tileH/2 + oy
// tileW = 2 * tileH for standard 2:1 isometric.
const TILE_H = 12;
const TILE_W = TILE_H * 2;
const WALL_H = 10; // pixel height of wall blocks

function resize() {
  W = canvas.width = innerWidth;
  H = canvas.height = innerHeight;
  // Center the room in the viewport
  ox = W / 2;
  oy = H / 2 - (COLS + ROWS) * TILE_H / 4;
}
resize();
addEventListener('resize', resize);

function isoX(x, y) { return (x - y) * TILE_W / 2 + ox; }
function isoY(x, y) { return (x + y) * TILE_H / 2 + oy; }

function drawDiamond(cx, cy, w, h) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy);
  ctx.lineTo(cx, cy + h / 2);
  ctx.lineTo(cx - w / 2, cy);
  ctx.closePath();
}

function drawWallBlock(cx, cy) {
  const w = TILE_W, h = TILE_H, zh = WALL_H;
  // Top face
  ctx.fillStyle = '#556';
  drawDiamond(cx, cy - zh, w, h);
  ctx.fill();
  // Left face
  ctx.fillStyle = '#334';
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy - zh);
  ctx.lineTo(cx, cy - zh + h / 2);
  ctx.lineTo(cx, cy + h / 2);
  ctx.lineTo(cx - w / 2, cy);
  ctx.closePath();
  ctx.fill();
  // Right face
  ctx.fillStyle = '#445';
  ctx.beginPath();
  ctx.moveTo(cx + w / 2, cy - zh);
  ctx.lineTo(cx, cy - zh + h / 2);
  ctx.lineTo(cx, cy + h / 2);
  ctx.lineTo(cx + w / 2, cy);
  ctx.closePath();
  ctx.fill();
}

function drawFloor(cx, cy) {
  ctx.fillStyle = '#1a1a2e';
  drawDiamond(cx, cy, TILE_W, TILE_H);
  ctx.fill();
  ctx.strokeStyle = '#222233';
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

function drawEntity(x, y, type, label) {
  const cx = isoX(x + 0.5, y + 0.5);
  const cy = isoY(x + 0.5, y + 0.5);
  const color = type === 0 ? '#4fa' : type === 1 ? '#fa4' : '#fa0';
  const r = type === 0 ? 7 : 5;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, r, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy - 8, r, 0, Math.PI * 2);
  ctx.fill();

  // Self ring
  if (type === 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 10, 5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Label
  ctx.font = '11px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.fillText(label, cx, cy - 20);
}

function render() {
  ctx.clearRect(0, 0, W, H);

  // Draw floor and walls (back to front for correct overlap)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cx = isoX(x + 0.5, y + 0.5);
      const cy = isoY(x + 0.5, y + 0.5);
      const isWall = WALLS ? WALLS[y * COLS + x] === 0 : false;
      if (isWall) {
        drawFloor(cx, cy);
        drawWallBlock(cx, cy);
      } else {
        drawFloor(cx, cy);
      }
    }
  }

  // Draw entities sorted by y for correct overlap
  const sorted = [...OBJECTS].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const o of sorted) {
    drawEntity(o.x, o.y, o.t, o.n);
  }
}

render();
// Re-render on resize
addEventListener('resize', () => { resize(); render(); });
</script>
</body></html>`;
}
