// ═══════════════════════════════════════════════
//   DANZAD MALDITOS — BROADCAST v3
//   Rutas sync con panel_de_control.js
// ═══════════════════════════════════════════════

import { initializeApp }             from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfig = {
  apiKey:            "AIzaSyCxd2sdNJZaQ0Rq_mF6Sn1wLQra4Eabp1U",
  authDomain:        "danzad-maldit0s.firebaseapp.com",
  databaseURL:       "https://danzad-maldit0s-default-rtdb.firebaseio.com",
  projectId:         "danzad-maldit0s",
  storageBucket:     "danzad-maldit0s.firebasestorage.app",
  messagingSenderId: "774607843671",
  appId:             "1:774607843671:web:ec64876ba81b6b50acce12"
};

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ── Rutas Firebase (igual que panel_de_control.js) ──
// /state         → votingOpen, votingEnded, currentRound, timerEnd, totalVotes
// /participants  → { participant_1..10: { name, image, number } }
// /results/pairs → { pair_1..5: { participants:[n,n], eliminated, votes } }
// /results/winner → "pair_X"  (key string)

// ── Estados ─────────────────────────────────────
const S = { WAITING:'waiting', VOTING:'voting', CONSOLIDATION:'consolidation', PAIRS:'pairs', WINNER:'winner' };

// ── App state ────────────────────────────────────
let currentState = null;
let participants = {};   // { participant_1: {name, image, number} }
let pairs        = {};   // { pair_1: {participants:[n,n], eliminated, votes} }
let winner       = null; // "pair_X" o null

let votingOpen  = false;
let votingEnded = false;
let timerEnd    = 0;

// Para detectar eliminaciones
let prevPairs = {};   // snapshot anterior de /results/pairs

// ── DOM ──────────────────────────────────────────
const screens = {
  waiting:       document.getElementById("screen-waiting"),
  voting:        document.getElementById("screen-voting"),
  consolidation: document.getElementById("screen-consolidation"),
  pairs:         document.getElementById("screen-pairs"),
  winner:        document.getElementById("screen-winner")
};

const overlayElim     = document.getElementById("overlay-elim");
const connDot         = document.getElementById("conn-dot");
const connLabel       = document.getElementById("conn-label");
const timerNumberEl   = document.getElementById("timer-number");
const ringProgressEl  = document.getElementById("ring-progress");
const votingChipsEl   = document.getElementById("voting-chips");
const waitingPiecesEl = document.getElementById("waiting-pieces");
const votingPiecesEl  = document.getElementById("voting-pieces");
const pairsGridEl     = document.getElementById("pairs-grid");
const pairRevealEl    = document.getElementById("pair-reveal");
const winnerCardsEl   = document.getElementById("winner-cards");
const winnerParticles = document.getElementById("winner-particles");
const consTitleEl     = document.getElementById("cons-title");

// Timer local
let timerInterval    = null;
let RING_CIRCUMF     = 2 * Math.PI * 52;  // r=52
let timerDurationRef = 300; // se captura en el momento que votingOpen se activa
let timerStartedAt   = 0;   // timestamp cuando se capturó la duración real

// Reveal flags
let pairRevealRunning = false;
let particleLoop      = null;

// Eliminación en cola (evitar overlays simultáneos)
let elimQueue   = [];
let elimRunning = false;

// ═══════════════════════════════════════════════
//   STATE MANAGER
// ═══════════════════════════════════════════════

function goTo(newState) {
  if (currentState === newState) return;
  console.log(`[Broadcast] ${currentState||'boot'} → ${newState}`);

  // Limpiar recursos del estado anterior
  if (currentState === S.VOTING) cleanVoting();

  Object.values(screens).forEach(s => s.classList.remove("active"));
  currentState = newState;
  if (screens[newState]) screens[newState].classList.add("active");

  switch (newState) {
    case S.WAITING:       initWaiting();       break;
    case S.VOTING:        initVoting();        break;
    case S.CONSOLIDATION: initConsolidation(); break;
    case S.PAIRS:         initPairs();         break;
    case S.WINNER:        initWinner();        break;
  }
}

function evaluate() {
  if (winner) { goTo(S.WINNER); return; }
  if (votingOpen  && !votingEnded) { goTo(S.VOTING);  return; }
  if (votingEnded && !votingOpen)  {
    if (currentState !== S.CONSOLIDATION && currentState !== S.PAIRS) {
      goTo(S.CONSOLIDATION);
    }
    return;
  }
  goTo(S.WAITING);
}

// ═══════════════════════════════════════════════
//   HELPERS
// ═══════════════════════════════════════════════

function byNumber(num) {
  if (num == null) return null;
  const n = parseInt(num, 10);
  return Object.values(participants).find(p => parseInt(p.number,10) === n) || null;
}

function sorted() {
  return Object.values(participants).sort((a,b) =>
    (parseInt(a.number,10)||0) - (parseInt(b.number,10)||0)
  );
}

function fallback() {
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E";
}

function img(p, cls='') {
  const src = p?.image || fallback();
  const alt = p?.name  || '';
  return `<img src="${src}" alt="${alt}" class="${cls}" onerror="this.src='${fallback()}'">`;
}

function sleep(ms) { return new Promise(r => setTimeout(r,ms)); }

function sortedPairEntries() {
  return Object.entries(pairs)
    .filter(([,p]) => p)
    .sort(([a],[b]) =>
      parseInt(a.replace('pair_',''),10) - parseInt(b.replace('pair_',''),10)
    );
}

// ═══════════════════════════════════════════════
//   LISTENERS FIREBASE
// ═══════════════════════════════════════════════

function listenAll() {
  // /state — flags globales
  onValue(ref(db, 'state'), snap => {
    const s = snap.val() || {};
    console.log('[Broadcast] /state ->', JSON.stringify(s));

    votingOpen  = !!s.votingOpen;
    votingEnded = !!s.votingEnded;
    timerEnd    = s.timerEnd || 0;

    if (votingOpen && timerEnd) {
      // Capturar duración real solo cuando acaba de activarse la votación
      // (si timerStartedAt es 0 o hay un timerEnd nuevo)
      const nowRemaining = Math.max(0, (timerEnd - Date.now()) / 1000);
      if (timerStartedAt === 0 || timerStartedAt !== timerEnd) {
        // timerDurationRef = segundos totales desde AHORA hasta timerEnd
        // El panel pone timerEnd = Date.now() + duration*1000 cuando abre la votación.
        // Leemos /state/votingDuration si existe, si no estimamos con el remaining actual.
        timerDurationRef = s.votingDuration
          ? parseInt(s.votingDuration, 10)
          : Math.round(nowRemaining);
        if (timerDurationRef < 5) timerDurationRef = nowRemaining || 300;
        timerStartedAt = timerEnd;
      }
      startTimer();
    } else {
      timerStartedAt = 0;
      stopTimer();
      resetRing();
    }

    evaluate();
  });

  // /participants
  onValue(ref(db, 'participants'), snap => {
    participants = snap.val() || {};
    console.log('[Broadcast] /participants ->', Object.keys(participants).length);
    refreshParticipantUI();
  });

  // /results/pairs — también detecta eliminaciones
  onValue(ref(db, 'results/pairs'), snap => {
    const newPairs = snap.val() || {};
    detectEliminations(prevPairs, newPairs);
    prevPairs = JSON.parse(JSON.stringify(newPairs)); // deep clone
    pairs = newPairs;
    console.log('[Broadcast] /results/pairs ->', Object.keys(pairs).length);
    if (currentState === S.PAIRS) renderPairsGrid();
  });

  // /results/winner
  onValue(ref(db, 'results/winner'), snap => {
    const val = snap.val();
    if (val && val !== winner) {
      winner = val;
      console.log('[Broadcast] /results/winner ->', winner);
      evaluate();
      renderWinner();
    } else if (!val) {
      winner = null;
    }
  });

  // conexión
  onValue(ref(db, '.info/connected'), snap => {
    const ok = !!snap.val();
    connDot.className   = 'conn-dot ' + (ok ? 'live' : 'error');
    connLabel.textContent = ok ? 'EN VIVO' : 'RECONECTANDO';
  });
}

// ═══════════════════════════════════════════════
//   DETECCIÓN DE ELIMINACIONES
//   Compara snapshot anterior vs nuevo para detectar:
//   1) pair.eliminated pasó a true → eliminar pareja
//   2) participants[i] pasó de número a null → eliminar participante
// ═══════════════════════════════════════════════

function detectEliminations(prev, next) {
  Object.entries(next).forEach(([key, pair]) => {
    if (!pair) return;
    const oldPair = prev[key] || {};
    const oldPts  = oldPair.participants || [null, null];
    const newPts  = pair.participants    || [null, null];

    // Pareja completa eliminada
    if (pair.eliminated && !oldPair.eliminated) {
      const pA = byNumber(newPts[0] ?? oldPts[0]);
      const pB = byNumber(newPts[1] ?? oldPts[1]);
      const num = parseInt(key.replace('pair_',''),10);
      queueElim({
        type: 'pair',
        label: `Pareja ${String(num).padStart(2,'0')} — Eliminada`,
        names: [pA?.name||'—', pB?.name||'—'],
        photos: [pA, pB]
      });
      return; // no procesar slots individuales si ya se eliminó la pareja
    }

    // Participante individual eliminado (slot pasó de número a null)
    [0,1].forEach(i => {
      if (oldPts[i] != null && newPts[i] == null) {
        const p   = byNumber(oldPts[i]);
        const num = parseInt(key.replace('pair_',''),10);
        queueElim({
          type:  'participant',
          label: 'Participante Eliminado',
          names: [p?.name || '—'],
          photos: [p],
          sub:   `De Pareja ${String(num).padStart(2,'0')}`
        });
      }
    });
  });
}

function queueElim(data) {
  elimQueue.push(data);
  if (!elimRunning) runElimQueue();
}

async function runElimQueue() {
  if (elimRunning || elimQueue.length === 0) return;
  elimRunning = true;
  while (elimQueue.length > 0) {
    await showElim(elimQueue.shift());
    await sleep(500);
  }
  elimRunning = false;
}

function showElim(data) {
  return new Promise(resolve => {
    overlayElim.innerHTML = `
      <div class="elim-flash"></div>
      <div class="elim-tag">${data.label}</div>
      <div class="elim-photos">
        ${data.photos.map(p => `<div class="elim-photo">${img(p)}</div>`).join('')}
      </div>
      <div class="elim-name">${data.names.join(' · ')}</div>
      ${data.sub ? `<div class="elim-sub">${data.sub}</div>` : ''}
    `;

    overlayElim.classList.remove('hide');
    overlayElim.classList.add('show');

    // Auto-cerrar
    setTimeout(() => {
      overlayElim.classList.remove('show');
      overlayElim.classList.add('hide');
      setTimeout(() => {
        overlayElim.style.cssText = '';
        overlayElim.classList.remove('hide');
        resolve();
      }, 600);
    }, 5000);
  });
}

// ═══════════════════════════════════════════════
//   REFRESH PARTICIPANTES EN ESTADO ACTUAL
// ═══════════════════════════════════════════════



function refreshParticipantUI() {
  if (currentState === S.WAITING) renderWaitingPieces(false);
  if (currentState === S.VOTING)  { cleanVoting(); buildCoverFlow(); }
  if (currentState === S.PAIRS)   renderPairsGrid();
}

// ═══════════════════════════════════════════════
//   TIMER LOCAL
// ═══════════════════════════════════════════════

function startTimer() {
  stopTimer();
  tick();
  timerInterval = setInterval(tick, 500);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function resetRing() {
  if (timerNumberEl)  timerNumberEl.textContent = '00:00';
  if (ringProgressEl) {
    ringProgressEl.style.strokeDasharray  = RING_CIRCUMF;
    ringProgressEl.style.strokeDashoffset = 0;
  }
}

function tick() {
  if (!timerEnd) return;
  const rem  = Math.max(0, Math.round((timerEnd - Date.now()) / 1000));
  const mins = Math.floor(rem / 60);
  const secs = rem % 60;

  if (timerNumberEl) {
    timerNumberEl.textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
    timerNumberEl.classList.toggle('urgent', rem <= 10);
  }

  // Ring: llena completo al inicio, vacía hasta cero
  if (ringProgressEl) {
    // Estimamos duración máxima como 5min si no la tenemos
    const total  = timerDurationRef || 300;
    const ratio  = Math.min(1, rem / total);
    const offset = RING_CIRCUMF * (1 - ratio);
    ringProgressEl.style.strokeDasharray  = RING_CIRCUMF;
    ringProgressEl.style.strokeDashoffset = offset;
  }
}

// ═══════════════════════════════════════════════
//   STATE: WAITING — tarjetas flotando de fondo
// ═══════════════════════════════════════════════

function initWaiting() {
  renderWaitingPieces(false);
}

function renderWaitingPieces(settled) {
  if (!waitingPiecesEl) return;
  const list  = sorted();
  const W     = window.innerWidth;
  const H     = window.innerHeight;
  const piece_w = Math.max(70, Math.min(130, W * 0.09));
  const piece_h = piece_w * 1.5;

  // Calcular posiciones distribuidas en zona periferia (no tapan el título central)
  // Dividir pantalla en zonas y asignar posiciones aleatorias dentro
  const zones = generateZones(W, H, list.length, piece_w, piece_h);

  if (!settled) {
    waitingPiecesEl.innerHTML = '';
    const durs   = [7,8,9,7.5,8.5,9.5,8,7.5,9,8.5];
    const delays  = [0,0.7,1.4,2,0.4,1.1,1.8,0.3,1,1.6];
    const dxSets = [[-15,10,-8,12],[-10,-12,8,-5],[12,-8,15,-10]];
    const dySets = [[8,-12,5,-10],[-8,10,-5,12],[10,-5,8,-12]];

    list.forEach((p, i) => {
      const z    = zones[i] || { x: Math.random()*W, y: Math.random()*H };
      const dxi  = i % dxSets.length;
      const dyi  = i % dySets.length;
      const dx   = dxSets[dxi];
      const dy   = dySets[dyi];

      const el   = document.createElement('div');
      el.className = 'waiting-piece';
      el.style.cssText = `
        left: ${z.x}px;
        top:  ${z.y}px;
        width: ${piece_w}px;
        --dur:   ${durs[i % durs.length]}s;
        --delay: ${delays[i % delays.length]}s;
        --r:     ${(Math.random()*6 - 3).toFixed(1)}deg;
        --dx1: ${dx[0]}px; --dy1: ${dy[0]}px;
        --dx2: ${dx[1]}px; --dy2: ${dy[1]}px;
        --dx3: ${dx[2]}px; --dy3: ${dy[2]}px;
      `;
      el.innerHTML = `
        ${img(p)}
        <div class="waiting-piece-name">${p.name || '—'}</div>
      `;
      waitingPiecesEl.appendChild(el);
    });
  } else {
    // Settled: animar a posiciones finales (rompecabezas que encaja)
    const pieces = waitingPiecesEl.querySelectorAll('.waiting-piece');
    const finalZones = generatePuzzleGrid(W, H, list.length, piece_w, piece_h);
    pieces.forEach((el, i) => {
      const cur = { x: parseInt(el.style.left), y: parseInt(el.style.top) };
      const fin = finalZones[i] || cur;
      el.style.setProperty('--final-dx', `${fin.x - cur.x}px`);
      el.style.setProperty('--final-dy', `${fin.y - cur.y}px`);
      el.style.setProperty('--final-r',  `${(Math.random()*4-2).toFixed(1)}deg`);
      el.classList.add('settled');
      el.style.opacity = '0.9';
    });
  }
}

function generateZones(W, H, count, pw, ph) {
  // Distribuir en corona perimetral (evitar zona central 40% x 40%)
  const cx = W * 0.5, cy = H * 0.5;
  const ex = W * 0.2, ey = H * 0.2; // exclusion zone half-size

  const positions = [];
  let attempts = 0;

  while (positions.length < count && attempts < 500) {
    attempts++;
    const x = Math.random() * (W - pw);
    const y = Math.random() * (H - ph);
    const inCenter = Math.abs(x + pw/2 - cx) < ex && Math.abs(y + ph/2 - cy) < ey;
    if (inCenter) continue;
    // Check no overlap with existing
    const overlap = positions.some(p =>
      Math.abs(p.x - x) < pw * 0.9 && Math.abs(p.y - y) < ph * 0.9
    );
    if (!overlap) positions.push({x, y});
  }

  // Fill remaining slots if needed
  while (positions.length < count) {
    positions.push({ x: Math.random()*(W-pw), y: Math.random()*(H-ph) });
  }

  return positions;
}

function generatePuzzleGrid(W, H, count, pw, ph) {
  // Grid 5x2 centrado
  const cols = 5, rows = Math.ceil(count/cols);
  const gapX = (W - cols*pw) / (cols+1);
  const gapY = (H - rows*ph) / (rows+1);
  const result = [];
  for (let r=0; r<rows; r++) {
    for (let c=0; c<cols; c++) {
      if (result.length >= count) break;
      result.push({
        x: gapX + c*(pw+gapX),
        y: gapY + r*(ph+gapY)
      });
    }
  }
  return result;
}



// ── Inyectar keyframes únicos por tarjeta en un <style> dedicado ──
let votingStyleEl = null;

function renderVotingPieces() {
  if (!votingPiecesEl) return;
  votingPiecesEl.innerHTML = '';

  // Limpiar keyframes anteriores
  if (votingStyleEl) { votingStyleEl.remove(); votingStyleEl = null; }

  const list = sorted();
  if (list.length === 0) return;

  const W  = window.innerWidth;
  const H  = window.innerHeight;

  // Tamaños grandes y variables — de 18% a 28% del ancho de pantalla
  const minW = Math.round(W * 0.14);
  const maxW = Math.round(W * 0.26);

  let cssText = '';

  list.forEach((p, i) => {
    const pw = minW + Math.floor(Math.random() * (maxW - minW));
    const ph = Math.round(pw * 1.45);

    // Generar 4-6 waypoints que atraviesan toda la pantalla de extremo a extremo
    const steps = 4 + Math.floor(Math.random() * 3); // 4,5,6
    const waypoints = [];

    // Primer waypoint: posición inicial aleatoria real
    waypoints.push({
      x: Math.random() * (W - pw),
      y: Math.random() * (H - ph),
      r: (Math.random() * 20 - 10).toFixed(1)
    });

    // Waypoints intermedios: forzamos que crucen a zonas opuestas de la pantalla
    for (let s = 1; s < steps; s++) {
      const side = (i + s) % 4; // 0=izq, 1=der, 2=arr, 3=abajo
      let x, y;
      switch (side) {
        case 0: x = Math.random() * W * 0.25;               y = Math.random() * (H - ph); break;
        case 1: x = W * 0.75 + Math.random() * W * 0.25 - pw; y = Math.random() * (H - ph); break;
        case 2: x = Math.random() * (W - pw);               y = Math.random() * H * 0.2; break;
        default:x = Math.random() * (W - pw);               y = H * 0.75 + Math.random() * H * 0.25 - ph;
      }
      waypoints.push({
        x: Math.max(0, Math.min(W - pw, x)),
        y: Math.max(0, Math.min(H - ph, y)),
        r: (Math.random() * 24 - 12).toFixed(1)
      });
    }

    // Último waypoint = igual que el primero para loop suave
    waypoints.push({ ...waypoints[0] });

    // Generar keyframes CSS
    const animName = `vpiece_${i}`;
    const pct  = waypoints.map((wp, wi) => {
      const p = Math.round((wi / (waypoints.length - 1)) * 100);
      return `${p}% { transform: translate(${wp.x}px, ${wp.y}px) rotate(${wp.r}deg); }`;
    });

    cssText += `
      @keyframes ${animName} {
        ${pct.join('\n')}
      }
    `;

    const dur   = (9 + Math.random() * 8).toFixed(1);    // 9-17s
    const delay = (Math.random() * -12).toFixed(1);       // offset negativo = ya en marcha

    const el = document.createElement('div');
    el.className = 'vpiece';
    el.style.cssText = `
      position: absolute;
      left: 0; top: 0;
      width: ${pw}px;
      animation: ${animName} ${dur}s ${delay}s linear infinite;
      will-change: transform;
    `;
    el.innerHTML = img(p);
    votingPiecesEl.appendChild(el);
  });

  // Inyectar todos los keyframes de una vez
  votingStyleEl = document.createElement('style');
  votingStyleEl.textContent = cssText;
  document.head.appendChild(votingStyleEl);
}

// ═══════════════════════════════════════════════
//   STATE: VOTING — Cover Flow 3D Carousel
// ═══════════════════════════════════════════════

const cfWrap  = () => document.getElementById('coverflow-wrap');
const cfTrack = () => document.getElementById('coverflow-track');
const voteCountEl = () => document.getElementById('vote-count');

let cfAnimFrame  = null;  // requestAnimationFrame handle
let cfCards      = [];    // array de elementos DOM de las tarjetas
let cfAngle      = 0;     // ángulo actual (grados), avanza con el tiempo
let cfLastTime   = null;  // para cálculo de delta time
const CF_SPEED   = 360 / (10 * 12); // vuelta completa en (N_cards * 12s)

function initVoting() {
  buildCoverFlow();
}

function cleanVoting() {
  if (cfAnimFrame) { cancelAnimationFrame(cfAnimFrame); cfAnimFrame = null; }
  cfCards   = [];
  cfAngle   = 0;
  cfLastTime = null;
  const track = cfTrack();
  if (track) track.innerHTML = '';
}

function buildCoverFlow() {
  const track = cfTrack();
  if (!track) return;
  track.innerHTML = '';
  cfCards = [];

  const list = sorted();
  if (list.length === 0) return;

  // Calcular tamaño de tarjeta según viewport
  const wrap    = cfWrap();
  const wrapH   = wrap ? wrap.clientHeight : window.innerHeight * 0.55;
  const cardH   = Math.round(wrapH * 0.78);
  const cardW   = Math.round(cardH * (2 / 3));

  list.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'cf-card';
    card.style.width  = `${cardW}px`;
    card.style.height = `${cardH}px`;

    card.innerHTML = `
      ${img(p)}
      <div class="cf-card-info">
        <div class="cf-card-num">${String(p.number || '').padStart(2,'0')}</div>
        <div class="cf-card-name">${p.name || '—'}</div>
      </div>
    `;

    track.appendChild(card);
    cfCards.push({ el: card, w: cardW });
  });

  // Centrar el track en el wrap (overflow hidden lo recorta)
  track.style.left = '50%';
  track.style.transform = 'translateX(-50%)';

  // Iniciar loop de animación
  if (cfAnimFrame) cancelAnimationFrame(cfAnimFrame);
  cfLastTime = null;
  cfAnimFrame = requestAnimationFrame(cfLoop);
}

function cfLoop(timestamp) {
  if (!cfLastTime) cfLastTime = timestamp;
  const delta = (timestamp - cfLastTime) / 1000; // segundos
  cfLastTime  = timestamp;

  const n = cfCards.length;
  if (n === 0) return;

  // Avanzar ángulo continuamente
  cfAngle = (cfAngle + CF_SPEED * delta) % 360;

  const wrap   = cfWrap();
  const wrapW  = wrap ? wrap.clientWidth : window.innerWidth;
  const wrapH  = wrap ? wrap.clientHeight : window.innerHeight * 0.55;

  // Separación horizontal entre tarjetas (en px proyectados)
  const spacing = Math.round(wrapW * 0.16); // ajustable

  // Para cada tarjeta, calcular su posición angular en el anillo
  cfCards.forEach(({ el }, i) => {
    // Ángulo de esta tarjeta: distribuidas uniformemente + offset global
    const cardAngleDeg = cfAngle + (i / n) * 360;
    const cardAngleRad = (cardAngleDeg * Math.PI) / 180;

    // Proyección sinusoidal: sin → profundidad Z, cos → posición X
    const sinA = Math.sin(cardAngleRad); // -1 (fondo) a +1 (frente)
    const cosA = Math.cos(cardAngleRad); // posición lateral

    // Posición X: distribuir lateralmente según coseno
    const xOffset = cosA * spacing * (n / 2.2);

    // Escala y profundidad: tarjeta al frente (sinA ≈ 1) → grande
    // Mapeamos sinA de [-1,1] a [escalaMin, escalaMax]
    const scaleMin = 0.48;
    const scaleMax = 1.22;
    const t     = (sinA + 1) / 2;   // 0 = fondo, 1 = frente
    const scale = scaleMin + t * (scaleMax - scaleMin);

    // Opacidad
    const opMin = 0.18;
    const opMax = 1.0;
    const opacity = opMin + t * (opMax - opMin);

    // Z-index
    const zIdx = Math.round(t * 100);

    // Rotación Y ligera en perspectiva (tarjetas laterales giran un poco)
    const rotY = -cosA * 38; // ±38deg en los extremos

    // Posición Y: tarjetas del fondo ligeramente más arriba
    const yOffset = (1 - t) * 18;

    el.style.cssText = `
      width:   ${cfCards[i].w}px;
      transform: translateX(${xOffset}px) translateY(${yOffset}px)
                 scale(${scale.toFixed(3)})
                 perspective(900px) rotateY(${rotY.toFixed(1)}deg);
      opacity: ${opacity.toFixed(3)};
      z-index: ${zIdx};
      box-shadow: ${t > 0.85 ? '0 0 50px rgba(201,168,76,0.35), 0 25px 70px rgba(0,0,0,0.7)' : 'none'};
      transition: none;
    `;

    // Clases visuales para filtros de imagen (más eficiente que recalcular cada frame)
    const prevClass = el.dataset.cfClass || '';
    let newClass = '';
    if (t > 0.80)       newClass = 'cf-active';
    else if (t > 0.45)  newClass = 'cf-side';
    else                newClass = 'cf-back';

    if (newClass !== prevClass) {
      el.classList.remove('cf-active','cf-side','cf-back');
      el.classList.add(newClass);
      el.dataset.cfClass = newClass;
    }
  });

  cfAnimFrame = requestAnimationFrame(cfLoop);
}

// ── Listener de votos (totalVotes desde /state) ──────────
function listenVoteCount() {
  onValue(ref(db, 'state/totalVotes'), snap => {
    const el = voteCountEl();
    if (el) el.textContent = snap.val() || 0;
  });
}

// Stub eliminado — renderVotingChips ya no se usa
function renderVotingChips() {}
function renderVotingPieces() {}

// ═══════════════════════════════════════════════
//   STATE: CONSOLIDATION → reveal secuencial
// ═══════════════════════════════════════════════

function initConsolidation() {
  pairRevealRunning = false;
  if (consTitleEl) consTitleEl.style.display = '';
  if (pairRevealEl) { pairRevealEl.style.display = 'none'; pairRevealEl.className = 'pair-reveal'; }
  setTimeout(runRevealSequence, 3200);
}

async function runRevealSequence() {
  if (pairRevealRunning) return;
  pairRevealRunning = true;

  const list = sortedPairEntries().filter(([,p]) => !p.eliminated);

  if (list.length === 0) {
    pairRevealRunning = false;
    goTo(S.PAIRS);
    return;
  }

  // Ocultar título
  if (consTitleEl) {
    consTitleEl.style.opacity = '0';
    consTitleEl.style.transition = 'opacity 0.5s';
  }

  await sleep(500);

  for (let i = 0; i < list.length; i++) {
    const [, pair] = list[i];
    const num = parseInt(list[i][0].replace('pair_',''),10);
    await revealPair(pair, num, i+1, list.length);
    await sleep(700);
  }

  pairRevealRunning = false;
  goTo(S.PAIRS);
}

function revealPair(pair, pairNum, index, total) {
  return new Promise(resolve => {
    if (!pairRevealEl) { resolve(); return; }

    const pts = pair.participants || [null,null];
    const pA  = byNumber(pts[0]);
    const pB  = byNumber(pts[1]);

    pairRevealEl.innerHTML = `
      <div class="pr-number">Pareja ${String(pairNum).padStart(2,'0')} de ${total}</div>
      <div class="pr-label">Pareja ${String(pairNum).padStart(2,'0')}</div>
      <div class="pr-cards">
        <div class="pr-card">
          ${img(pA)}
          <div class="pr-name">${pA?.name||'—'}</div>
        </div>
        <div class="pr-vs">×</div>
        <div class="pr-card">
          ${img(pB)}
          <div class="pr-name">${pB?.name||'—'}</div>
        </div>
      </div>
    `;

    pairRevealEl.style.display = 'flex';
    pairRevealEl.classList.remove('hide');
    pairRevealEl.classList.add('show');

    setTimeout(() => {
      pairRevealEl.classList.remove('show');
      pairRevealEl.classList.add('hide');
      setTimeout(() => {
        pairRevealEl.style.display = 'none';
        pairRevealEl.className = 'pair-reveal';
        resolve();
      }, 700);
    }, 3800);
  });
}

// ═══════════════════════════════════════════════
//   STATE: PAIRS
// ═══════════════════════════════════════════════

function initPairs() {
  renderPairsGrid();
}

function renderPairsGrid() {
  if (!pairsGridEl) return;
  pairsGridEl.innerHTML = '';

  const list = sortedPairEntries();

  if (list.length === 0) {
    pairsGridEl.innerHTML = `
      <p style="grid-column:1/-1;text-align:center;font-family:var(--font-mono);
                font-size:0.7rem;letter-spacing:0.3em;color:var(--c-grey);padding:3rem">
        CARGANDO PAREJAS...
      </p>`;
    return;
  }

  list.forEach(([key, pair], i) => {
    const pts   = pair.participants || [null,null];
    const pA    = byNumber(pts[0]);
    const pB    = byNumber(pts[1]);
    const num   = parseInt(key.replace('pair_',''),10);
    const isElim = !!pair.eliminated;

    const card = document.createElement('div');
    card.className = 'pair-card' + (isElim ? ' eliminated' : '');
    card.style.setProperty('--delay', `${i * 0.12}s`);

    card.innerHTML = `
      <div class="pair-card-num">Pareja ${String(num).padStart(2,'0')}</div>
      <div class="pair-card-photos">
        ${img(pA)}
        ${img(pB)}
      </div>
      <div class="pair-card-names">
        <div class="pair-card-name">${pA?.name||'—'}</div>
        <div class="pair-card-name">${pB?.name||'—'}</div>
      </div>
    `;
    pairsGridEl.appendChild(card);
  });
}

// ═══════════════════════════════════════════════
//   STATE: WINNER
// ═══════════════════════════════════════════════

function initWinner() {
  spawnCelebration();
  renderWinner();
}

function renderWinner() {
  if (!winnerCardsEl || !winner) return;

  const pair = pairs[winner] || {};
  const pts  = pair.participants || [null,null];
  const pA   = byNumber(pts[0]);
  const pB   = byNumber(pts[1]);
  const num  = parseInt(winner.replace('pair_',''),10);

  winnerCardsEl.innerHTML = `
    <div class="winner-card">
      <div class="winner-photo-wrap" data-num="Pareja ${String(num).padStart(2,'0')}">
        ${img(pA)}
      </div>
      <div class="winner-name">${pA?.name||'—'}</div>
    </div>
    <div class="winner-amp">&</div>
    <div class="winner-card">
      <div class="winner-photo-wrap" data-num="">
        ${img(pB)}
      </div>
      <div class="winner-name">${pB?.name||'—'}</div>
    </div>
  `;
}

function spawnCelebration() {
  if (!winnerParticles) return;
  if (particleLoop) clearTimeout(particleLoop);
  winnerParticles.innerHTML = '';

  const cx = window.innerWidth  / 2;
  const cy = window.innerHeight * 0.4;
  const colors = ['#c9a84c','#f0d070','#ffffff','#e8c060','#d4b050'];

  // Partículas circulares
  for (let i = 0; i < 100; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const dist  = 100 + Math.random() * 500;
    const size  = 1.5 + Math.random() * 3.5;
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.cssText = `
      left:${cx}px; top:${cy}px;
      width:${size}px; height:${size}px;
      background:${colors[Math.floor(Math.random()*colors.length)]};
      --tx:${Math.cos(angle)*dist}px;
      --ty:${Math.sin(angle)*dist}px;
      --dur:${1.5 + Math.random()*2}s;
      --delay:${Math.random()*1.8}s;
    `;
    winnerParticles.appendChild(p);
  }

  // Confetti rectangulares
  for (let i = 0; i < 60; i++) {
    const c = document.createElement('div');
    c.className = 'confetti-piece';
    const startX = Math.random() * window.innerWidth;
    const startY = -20;
    c.style.cssText = `
      left:0; top:0;
      background:${colors[Math.floor(Math.random()*colors.length)]};
      --cx:${startX}px; --cy:${startY}px;
      --cdx:${(Math.random()-0.5)*300}px;
      --cdy:${window.innerHeight + 50}px;
      --cr:${Math.random()*720 - 360}deg;
      --dur:${2.5 + Math.random()*2}s;
      --delay:${Math.random()*2}s;
    `;
    winnerParticles.appendChild(c);
  }
}

// ═══════════════════════════════════════════════
//   BOOT
// ═══════════════════════════════════════════════

function boot() {
  console.log('[Broadcast] Danzad Malditos iniciando…');
  goTo(S.WAITING);

  try {
    listenAll();
    listenVoteCount();
  } catch (error) {
    console.error('[Broadcast] No se pudieron iniciar los listeners de Firebase:', error);
    connDot.className = 'conn-dot error';
    connLabel.textContent = 'SIN CONEXIÓN';
  }
}

boot();

