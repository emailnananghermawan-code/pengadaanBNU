// ============================================================================
// Server Ruang Bidding — Tender Terbatas
// Backend sederhana (Node.js, tanpa dependency eksternal) yang menjembatani
// Panel Panitia dan Panel Vendor secara online, lintas perangkat/lokasi.
//
// Cara menjalankan:
//   node server.js
// Lalu buka:
//   http://localhost:8080/panitia   -> untuk Panitia Pengadaan
//   http://localhost:8080/vendor    -> untuk peserta (Vendor A / Vendor B)
//
// Untuk dipakai lintas lokasi (vendor di kantor/rumah berbeda), server ini
// perlu di-deploy ke layanan hosting Node.js (Render, Railway, Fly.io, VPS
// internal BNI, dsb.) agar punya alamat URL yang bisa diakses semua pihak.
// Lihat README.md untuk instruksi lebih lanjut.
// ============================================================================

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------------------
// PENYIMPANAN SESI (in-memory). Data akan hilang jika server di-restart.
// Untuk kebutuhan produksi jangka panjang, ganti dengan database (mis. SQLite).
// ---------------------------------------------------------------------------
const sessions = new Map(); // code -> session object

function genCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa karakter ambigu
  let s = '';
  for (let i = 0; i < len; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}
function genToken() {
  return crypto.randomBytes(9).toString('base64url'); // token akses acak
}

// ---------------------------------------------------------------------------
// LOGIKA SKOR (identik dengan tools Panitia sebelumnya)
// ---------------------------------------------------------------------------
function computeScores(priceA, priceB) {
  const valid = [priceA, priceB].filter((p) => p != null && p > 0);
  const lowest = valid.length ? Math.min(...valid) : null;
  const scoreA = priceA != null && lowest != null ? (lowest / priceA) * 5 : 0;
  const scoreB = priceB != null && lowest != null ? (lowest / priceB) * 5 : 0;
  return { lowest, scoreA, scoreB };
}
function totalMerit(teknisTertimbang, hargaScore, hasPrice) {
  return teknisTertimbang + (hasPrice ? hargaScore * 0.2 : 0);
}
function hpsStatus(price, hps) {
  if (hps == null) return { label: 'Tanpa HPS', eligible: true };
  if (price == null) return { label: 'Belum ada harga', eligible: false };
  return price <= hps
    ? { label: 'Memenuhi HPS', eligible: true }
    : { label: 'Melebihi HPS', eligible: false };
}

function vendorKeyForToken(session, token) {
  if (token === session.tokenA) return 'A';
  if (token === session.tokenB) return 'B';
  return null;
}

function lastClosedPrice(session, vendorLetter, excludeRound) {
  const key = 'price' + vendorLetter;
  for (let i = session.rounds.length - 1; i >= 0; i--) {
    const r = session.rounds[i];
    if (r === excludeRound) continue;
    if (r.status === 'closed' && r[key] != null) return r[key];
  }
  return null;
}
function currentRound(session) {
  return session.rounds[session.rounds.length - 1] || null;
}
function effectivePrice(session, vendorLetter) {
  const r = currentRound(session);
  const key = 'price' + vendorLetter;
  if (r && r[key] != null) return r[key];
  return lastClosedPrice(session, vendorLetter);
}

function evaluateRound(session, round) {
  const sc = computeScores(round.priceA, round.priceB);
  const totalA = totalMerit(session.vendorA.teknis, sc.scoreA, round.priceA != null);
  const totalB = totalMerit(session.vendorB.teknis, sc.scoreB, round.priceB != null);
  const candA = { name: session.vendorA.name, total: totalA, hps: hpsStatus(round.priceA, session.hps), price: round.priceA };
  const candB = { name: session.vendorB.name, total: totalB, hps: hpsStatus(round.priceB, session.hps), price: round.priceB };
  const ranked = [candA, candB].sort((a, b) => {
    if (a.hps.eligible !== b.hps.eligible) return a.hps.eligible ? -1 : 1;
    return b.total - a.total;
  });
  const eligible = ranked.filter((c) => c.hps.eligible && c.price != null);
  let leaderLabel;
  if (eligible.length === 0) leaderLabel = 'Tidak ada yang memenuhi HPS';
  else if (eligible.length === 1 || eligible[0].total !== eligible[1].total)
    leaderLabel = eligible[0].name + ' (' + eligible[0].total.toFixed(2) + ')';
  else leaderLabel = 'Imbang';
  return { totalA, totalB, leaderLabel, candA, candB };
}

function closeRoundInternal(session, round) {
  if (round.timer) clearTimeout(round.timer);
  round.timer = null;
  if (round.status !== 'active') return;
  round.status = 'closed';
  round.closedAt = Date.now();
  if (round.priceA == null) round.priceA = lastClosedPrice(session, 'A', round);
  if (round.priceB == null) round.priceB = lastClosedPrice(session, 'B', round);
  const sc = computeScores(round.priceA, round.priceB);
  round.scoreA = round.priceA != null ? sc.scoreA : null;
  round.scoreB = round.priceB != null ? sc.scoreB : null;
}

// ---------------------------------------------------------------------------
// BANGUN RESPON UNTUK PANITIA (data lengkap kedua vendor)
// ---------------------------------------------------------------------------
function buildAdminView(session) {
  const pA = effectivePrice(session, 'A');
  const pB = effectivePrice(session, 'B');
  const sc = computeScores(pA, pB);
  const totalA = totalMerit(session.vendorA.teknis, sc.scoreA, pA != null);
  const totalB = totalMerit(session.vendorB.teknis, sc.scoreB, pB != null);
  const leaderboard = [
    { name: session.vendorA.name, teknis: session.vendorA.teknis, price: pA, score: pA != null ? sc.scoreA : null, total: totalA },
    { name: session.vendorB.name, teknis: session.vendorB.teknis, price: pB, score: pB != null ? sc.scoreB : null, total: totalB },
  ]
    .map((r) => ({ ...r, hps: hpsStatus(r.price, session.hps) }))
    .sort((a, b) => {
      if (a.hps.eligible !== b.hps.eligible) return a.hps.eligible ? -1 : 1;
      return b.total - a.total;
    });

  const round = currentRound(session);
  const rounds = session.rounds.map((r) => ({
    num: r.num,
    status: r.status,
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    priceA: r.priceA,
    priceB: r.priceB,
    scoreA: r.scoreA,
    scoreB: r.scoreB,
    leaderLabel: r.status === 'closed' ? evaluateRound(session, r).leaderLabel : null,
  }));

  return {
    code: session.code,
    vendorLinks: { A: session.tokenA, B: session.tokenB },
    vendorA: session.vendorA,
    vendorB: session.vendorB,
    durasiSec: session.durasiSec,
    hps: session.hps,
    hpsRevealed: session.hpsRevealed,
    teknisRevealed: session.teknisRevealed,
    phase: session.phase,
    currentRound: round ? { num: round.num, status: round.status, openedAt: round.openedAt, deadlineAt: round.deadlineAt } : null,
    leaderboard,
    rounds,
    result: session.result || null,
    now: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// BANGUN RESPON UNTUK VENDOR (hanya data miliknya sendiri)
// ---------------------------------------------------------------------------
function buildVendorView(session, letter) {
  const vendor = letter === 'A' ? session.vendorA : session.vendorB;
  const priceKey = 'price' + letter;
  const round = currentRound(session);
  const ownHistory = session.rounds
    .filter((r) => r.status === 'closed')
    .map((r) => ({ num: r.num, price: r[priceKey] }));

  let lastStatus = null;
  const lastClosed = [...session.rounds].reverse().find((r) => r.status === 'closed');
  if (lastClosed) {
    const ev = evaluateRound(session, lastClosed);
    const mine = letter === 'A' ? ev.candA : ev.candB;
    const opp = letter === 'A' ? ev.candB : ev.candA;
    const mineWins = mine.hps.eligible && mine.price != null && (!opp.hps.eligible || opp.price == null || mine.total >= opp.total);
    let hpsLabel = 'Tercatat';
    if (session.hpsRevealed) hpsLabel = mine.hps.label;
    else if (session.hps != null && !mine.hps.eligible) hpsLabel = 'Perlu perbaikan harga';
    lastStatus = {
      round: lastClosed.num,
      price: lastClosed[priceKey],
      hpsLabel,
      unggulSementara: mineWins,
    };
  }

  return {
    code: session.code,
    vendorLetter: letter,
    vendorName: vendor.name,
    teknis: session.teknisRevealed ? vendor.teknis : null,
    teknisRevealed: session.teknisRevealed,
    hps: session.hpsRevealed ? session.hps : null,
    hpsRevealed: session.hpsRevealed,
    durasiSec: session.durasiSec,
    phase: session.phase,
    currentRound: round ? { num: round.num, status: round.status, deadlineAt: round.deadlineAt, mySubmitted: round[priceKey] != null } : null,
    ownPriceHistory: ownHistory,
    lastStatus,
    result: session.phase === 'finished' ? session.result : null,
    now: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// HTTP HELPERS
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// ROUTER
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host);
  const p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ---- Static pages ----
  if (p === '/' || p === '/panitia') {
    return serveStatic(res, path.join(__dirname, 'panitia.html'), 'text/html; charset=utf-8');
  }
  if (p === '/vendor') {
    return serveStatic(res, path.join(__dirname, 'vendor.html'), 'text/html; charset=utf-8');
  }

  // ---- API: buat sesi baru (Panitia) ----
  if (p === '/api/sessions' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Body tidak valid.' });
    }
    const { vendorAName, vendorBName, teknisA, teknisB, durasiMenit, hps, hpsRevealed, teknisRevealed } = body;
    if (!vendorAName || !vendorBName) return sendJson(res, 400, { error: 'Nama kedua vendor wajib diisi.' });
    const tA = parseFloat(teknisA), tB = parseFloat(teknisB);
    if (isNaN(tA) || isNaN(tB) || tA < 0 || tA > 4 || tB < 0 || tB > 4)
      return sendJson(res, 400, { error: 'Skor teknis wajib 0–4.' });
    const durasi = parseFloat(durasiMenit);
    if (isNaN(durasi) || durasi <= 0) return sendJson(res, 400, { error: 'Durasi ronde tidak valid.' });

    let code;
    do { code = genCode(); } while (sessions.has(code));
    const session = {
      code,
      adminToken: genToken(),
      tokenA: genToken(),
      tokenB: genToken(),
      vendorA: { name: vendorAName, teknis: tA },
      vendorB: { name: vendorBName, teknis: tB },
      durasiSec: Math.round(durasi * 60),
      hps: hps != null && hps !== '' ? parseFloat(hps) : null,
      hpsRevealed: !!hpsRevealed,
      teknisRevealed: !!teknisRevealed,
      phase: 'running',
      rounds: [],
      result: null,
    };
    sessions.set(code, session);
    return sendJson(res, 200, {
      code,
      adminToken: session.adminToken,
      tokenA: session.tokenA,
      tokenB: session.tokenB,
    });
  }

  // ---- Match /api/sessions/:code/... ----
  const m = p.match(/^\/api\/sessions\/([A-Z0-9]+)(\/.*)?$/);
  if (m) {
    const code = m[1];
    const sub = m[2] || '';
    const session = sessions.get(code);
    if (!session) return sendJson(res, 404, { error: 'Kode sesi tidak ditemukan.' });

    // GET admin view
    if (sub === '/admin' && req.method === 'GET') {
      if (u.searchParams.get('adminToken') !== session.adminToken)
        return sendJson(res, 403, { error: 'Token admin salah.' });
      return sendJson(res, 200, buildAdminView(session));
    }

    // POST open round
    if (sub === '/admin/round/open' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Body invalid.' }); }
      if (body.adminToken !== session.adminToken) return sendJson(res, 403, { error: 'Token admin salah.' });
      const active = currentRound(session);
      if (active && active.status === 'active') return sendJson(res, 400, { error: 'Masih ada ronde aktif.' });
      const round = {
        num: session.rounds.length + 1,
        status: 'active',
        openedAt: Date.now(),
        closedAt: null,
        deadlineAt: Date.now() + session.durasiSec * 1000,
        priceA: null, priceB: null, scoreA: null, scoreB: null,
        timer: null,
      };
      round.timer = setTimeout(() => closeRoundInternal(session, round), session.durasiSec * 1000);
      session.rounds.push(round);
      return sendJson(res, 200, { ok: true, round: round.num });
    }

    // POST close round
    if (sub === '/admin/round/close' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Body invalid.' }); }
      if (body.adminToken !== session.adminToken) return sendJson(res, 403, { error: 'Token admin salah.' });
      const r = currentRound(session);
      if (!r || r.status !== 'active') return sendJson(res, 400, { error: 'Tidak ada ronde aktif.' });
      closeRoundInternal(session, r);
      return sendJson(res, 200, { ok: true });
    }

    // POST finish session
    if (sub === '/admin/finish' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Body invalid.' }); }
      if (body.adminToken !== session.adminToken) return sendJson(res, 403, { error: 'Token admin salah.' });
      const active = currentRound(session);
      if (active && active.status === 'active') return sendJson(res, 400, { error: 'Tutup ronde aktif dahulu.' });

      const pA = lastClosedPrice(session, 'A');
      const pB = lastClosedPrice(session, 'B');
      const sc = computeScores(pA, pB);
      const totalA = totalMerit(session.vendorA.teknis, sc.scoreA, pA != null);
      const totalB = totalMerit(session.vendorB.teknis, sc.scoreB, pB != null);
      const rows = [
        { name: session.vendorA.name, teknis: session.vendorA.teknis, price: pA, score: pA != null ? sc.scoreA : null, total: totalA },
        { name: session.vendorB.name, teknis: session.vendorB.teknis, price: pB, score: pB != null ? sc.scoreB : null, total: totalB },
      ]
        .map((r) => ({ ...r, hps: hpsStatus(r.price, session.hps) }))
        .sort((a, b) => {
          if (a.hps.eligible !== b.hps.eligible) return a.hps.eligible ? -1 : 1;
          return b.total - a.total;
        });
      const eligibleRows = rows.filter((r) => r.hps.eligible && r.price != null);
      let headline, subline;
      if (eligibleRows.length === 0) {
        headline = 'Tidak Ada Vendor yang Memenuhi Syarat HPS';
        subline = 'Kedua harga penawaran akhir melebihi HPS. Perlu tindak lanjut Panitia Pengadaan.';
      } else if (eligibleRows.length === 1 || eligibleRows[0].total !== eligibleRows[1]?.total) {
        const w = eligibleRows[0];
        headline = w.name;
        subline = 'Total merit point: ' + w.total.toFixed(2) + ' dari 5 — harga akhir Rp ' + Number(w.price).toLocaleString('id-ID') + ' (memenuhi HPS)';
      } else {
        headline = 'Skor Imbang di Antara Vendor yang Memenuhi HPS';
        subline = 'Perlu keputusan tambahan dari Panitia Pengadaan.';
      }
      const closedRounds = session.rounds.filter((r) => r.status === 'closed');
      session.result = {
        headline, subline,
        summary: rows,
        roundHistory: closedRounds.map((r) => ({
          num: r.num, priceA: r.priceA, priceB: r.priceB,
          leaderLabel: evaluateRound(session, r).leaderLabel,
        })),
      };
      session.phase = 'finished';
      return sendJson(res, 200, { ok: true, result: session.result });
    }

    // GET vendor view
    if (sub === '/vendor' && req.method === 'GET') {
      const token = u.searchParams.get('token');
      const letter = vendorKeyForToken(session, token);
      if (!letter) return sendJson(res, 403, { error: 'Token akses tidak valid.' });
      return sendJson(res, 200, buildVendorView(session, letter));
    }

    // POST vendor bid
    if (sub === '/vendor/bid' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Body invalid.' }); }
      const letter = vendorKeyForToken(session, body.token);
      if (!letter) return sendJson(res, 403, { error: 'Token akses tidak valid.' });
      const r = currentRound(session);
      if (!r || r.status !== 'active') return sendJson(res, 400, { error: 'Belum ada ronde aktif untuk menerima penawaran.' });
      const val = parseFloat(body.price);
      if (isNaN(val) || val <= 0) return sendJson(res, 400, { error: 'Masukkan angka harga yang valid.' });
      const prevPrice = lastClosedPrice(session, letter);
      if (prevPrice != null && val >= prevPrice) {
        return sendJson(res, 400, { error: 'Harga harus lebih rendah dari ronde sebelumnya (Rp ' + Number(prevPrice).toLocaleString('id-ID') + ').' });
      }
      r['price' + letter] = val;
      let warning = null;
      if (session.hps != null && val > session.hps) warning = 'Peringatan: harga di atas HPS, tetap tersimpan.';
      return sendJson(res, 200, { ok: true, message: warning || 'Harga diterima.', warning: !!warning });
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Server Ruang Bidding berjalan di http://localhost:' + PORT);
  console.log('  Panitia: http://localhost:' + PORT + '/panitia');
  console.log('  Vendor : http://localhost:' + PORT + '/vendor');
});
