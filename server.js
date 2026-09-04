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
function computeScores(prices, session) {
  const valid = Object.values(prices).filter((p) => p != null && p > 0);
  const lowestBid = valid.length ? Math.min(...valid) : null;
  const referencePrices = [];
  if (session?.nilaiWajar != null) {
    referencePrices.push(session.nilaiWajar);
    if (session.hps != null) referencePrices.push(session.hps);
  }
  const minimumReference = referencePrices.length ? Math.min(...referencePrices) : null;
  const lowest = minimumReference == null ? lowestBid : Math.max(lowestBid || minimumReference, minimumReference);
  const scores = {};
  for (const [id, price] of Object.entries(prices)) {
    scores[id] = price != null && lowest != null && price >= lowest ? lowest / price : 0;
  }
  return { lowest, scores };
}
function totalMerit(teknisTertimbang, hargaScore, hasPrice) {
  return teknisTertimbang + (hasPrice ? hargaScore : 0);
}
function hpsStatus(price, hps) {
  if (hps == null) return { label: 'Tanpa HPS', eligible: true };
  if (price == null) return { label: 'Belum ada harga', eligible: false };
  return price <= hps
    ? { label: 'Memenuhi HPS', eligible: true }
    : { label: 'Melebihi HPS', eligible: false };
}
function fairValueStatus(price, nilaiWajar) {
  if (nilaiWajar == null || price == null) return { label: null, eligible: true };
  return price >= nilaiWajar
    ? { label: 'Memenuhi nilai wajar', eligible: true }
    : { label: 'Di bawah nilai wajar', eligible: false };
}
function priceStatus(price, session) {
  const hps = hpsStatus(price, session.hps);
  const fair = fairValueStatus(price, session.nilaiWajar);
  return { label: fair.label || hps.label, eligible: hps.eligible && fair.eligible };
}
function parseMoney(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const normalized = value.trim().replace(/^Rp\s*/i, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  return normalized ? parseFloat(normalized) : NaN;
}
function logActivity(session, actor, action, detail) {
  session.activityLog.push({ at: Date.now(), actor, action, detail });
}

function vendorForToken(session, token) {
  return session.vendors.find((vendor) => vendor.token === token) || null;
}

function lastClosedPrice(session, vendorId, excludeRound) {
  for (let i = session.rounds.length - 1; i >= 0; i--) {
    const r = session.rounds[i];
    if (r === excludeRound) continue;
    if (r.status === 'closed' && r.bids[vendorId] != null) return r.bids[vendorId];
  }
  return null;
}
function currentRound(session) {
  return session.rounds[session.rounds.length - 1] || null;
}
function effectivePrice(session, vendorId) {
  const r = currentRound(session);
  if (r && r.bids[vendorId] != null) return r.bids[vendorId];
  return lastClosedPrice(session, vendorId);
}

function evaluateRound(session, round) {
  const sc = computeScores(round.bids, session);
  const candidates = session.vendors.map((vendor) => {
    const price = round.bids[vendor.id];
    return { id: vendor.id, name: vendor.name, total: totalMerit(vendor.teknis, sc.scores[vendor.id], price != null), hps: priceStatus(price, session), price };
  });
  const ranked = candidates.sort((a, b) => {
    if (a.hps.eligible !== b.hps.eligible) return a.hps.eligible ? -1 : 1;
    return b.total - a.total;
  });
  const eligible = ranked.filter((c) => c.hps.eligible && c.price != null);
  let leaderLabel;
  if (eligible.length === 0) leaderLabel = 'Tidak ada yang memenuhi HPS';
  else if (eligible.length === 1 || eligible[0].total !== eligible[1].total)
    leaderLabel = eligible[0].name + ' (' + eligible[0].total.toFixed(2) + ')';
  else leaderLabel = 'Imbang';
  return { leaderLabel, candidates };
}

function closeRoundInternal(session, round) {
  if (round.timer) clearTimeout(round.timer);
  round.timer = null;
  if (round.status !== 'active') return;
  round.status = 'closed';
  round.closedAt = Date.now();
  for (const vendor of session.vendors) {
    if (round.bids[vendor.id] == null) round.bids[vendor.id] = lastClosedPrice(session, vendor.id, round);
  }
  const sc = computeScores(round.bids, session);
  round.scores = Object.fromEntries(session.vendors.map((vendor) => [vendor.id, round.bids[vendor.id] != null ? sc.scores[vendor.id] : null]));
}

// ---------------------------------------------------------------------------
// BANGUN RESPON UNTUK PANITIA (data lengkap kedua vendor)
// ---------------------------------------------------------------------------
function buildAdminView(session) {
  const prices = Object.fromEntries(session.vendors.map((vendor) => [vendor.id, effectivePrice(session, vendor.id)]));
  const sc = computeScores(prices, session);
  const leaderboard = session.vendors.map((vendor) => ({ id: vendor.id, name: vendor.name, teknis: vendor.teknis, price: prices[vendor.id], score: prices[vendor.id] != null ? sc.scores[vendor.id] : null, total: totalMerit(vendor.teknis, sc.scores[vendor.id], prices[vendor.id] != null) }))
    .map((r) => ({ ...r, hps: priceStatus(r.price, session) }))
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
    bids: r.bids,
    scores: r.scores,
    bidLog: r.bidLog,
    leaderLabel: r.status === 'closed' ? evaluateRound(session, r).leaderLabel : null,
  }));

  return {
    code: session.code,
    title: session.title,
    description: session.description,
    vendors: session.vendors.map(({ id, name, teknis }) => ({ id, name, teknis })),
    vendorLinks: Object.fromEntries(session.vendors.map((vendor) => [vendor.id, vendor.token])),
    durasiSec: session.durasiSec,
    hps: session.hps,
    nilaiWajar: session.nilaiWajar,
    hpsRevealed: session.hpsRevealed,
    teknisRevealed: session.teknisRevealed,
    phase: session.phase,
    currentRound: round ? { num: round.num, status: round.status, openedAt: round.openedAt, deadlineAt: round.deadlineAt } : null,
    leaderboard,
    rounds,
    result: session.result || null,
    activityLog: session.activityLog,
    now: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// BANGUN RESPON UNTUK VENDOR (hanya data miliknya sendiri)
// ---------------------------------------------------------------------------
function buildVendorView(session, vendor) {
  const priceKey = vendor.id;
  const round = currentRound(session);
  const ownHistory = session.rounds
    .filter((r) => r.status === 'closed')
    .map((r) => ({ num: r.num, price: r.bids[priceKey] }));

  let lastStatus = null;
  let liveStatus = null;
  if (round && round.status === 'active') {
    const ev = evaluateRound(session, round);
    const mine = ev.candidates.find((candidate) => candidate.id === vendor.id);
    const eligible = ev.candidates.filter((candidate) => candidate.hps.eligible && candidate.price != null);
    const submitted = mine.price != null;
    liveStatus = {
      round: round.num,
      submitted,
      unggulSementara: submitted && mine.hps.eligible && eligible[0]?.id === vendor.id,
      label: !submitted ? 'Belum mengirim penawaran' : !mine.hps.eligible ? 'Harga belum memenuhi HPS' : eligible[0]?.id === vendor.id ? 'Unggul sementara' : 'Belum unggul',
    };
  }
  const lastClosed = [...session.rounds].reverse().find((r) => r.status === 'closed');
  if (lastClosed) {
    const ev = evaluateRound(session, lastClosed);
    const mine = ev.candidates.find((candidate) => candidate.id === vendor.id);
    const eligible = ev.candidates.filter((candidate) => candidate.hps.eligible && candidate.price != null);
    const mineWins = mine.hps.eligible && mine.price != null && eligible[0]?.id === vendor.id;
    let hpsLabel = 'Tercatat';
    if (session.hpsRevealed) hpsLabel = mine.hps.label;
    else if (session.hps != null && !mine.hps.eligible) hpsLabel = 'Perlu perbaikan harga';
    lastStatus = {
      round: lastClosed.num,
      price: lastClosed.bids[priceKey],
      hpsLabel,
      unggulSementara: mineWins,
    };
  }

  return {
    code: session.code,
    title: session.title,
    description: session.description,
    vendorLetter: vendor.id,
    vendorName: vendor.name,
    teknis: session.teknisRevealed ? vendor.teknis : null,
    teknisRevealed: session.teknisRevealed,
    hps: session.hpsRevealed ? session.hps : null,
    hpsRevealed: session.hpsRevealed,
    nilaiWajar: session.nilaiWajar,
    hargaAwal: vendor.hargaAwal,
    durasiSec: session.durasiSec,
    phase: session.phase,
    currentRound: round ? { num: round.num, status: round.status, deadlineAt: round.deadlineAt, mySubmitted: round.bids[priceKey] != null, currentPrice: round.bids[priceKey] } : null,
    ownPriceHistory: ownHistory,
    liveStatus,
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
    const { vendors: vendorInput, title, description, durasiMenit, hps, nilaiWajar, hpsRevealed, teknisRevealed } = body;
    if (!Array.isArray(vendorInput) || vendorInput.length < 2)
      return sendJson(res, 400, { error: 'Minimal dua vendor wajib diisi.' });
    const vendors = vendorInput.map((vendor, index) => ({
      id: 'V' + (index + 1),
      name: String(vendor.name || '').trim(),
      teknis: parseFloat(vendor.teknis),
      hargaAwal: parseMoney(vendor.hargaAwal),
      token: genToken(),
    }));
    if (vendors.some((vendor) => !vendor.name)) return sendJson(res, 400, { error: 'Nama semua vendor wajib diisi.' });
    if (vendors.some((vendor) => isNaN(vendor.teknis) || vendor.teknis < 0 || vendor.teknis > 4))
      return sendJson(res, 400, { error: 'Skor teknis semua vendor wajib 0–4.' });
    if (vendors.some((vendor) => isNaN(vendor.hargaAwal) || vendor.hargaAwal <= 0))
      return sendJson(res, 400, { error: 'Harga penawaran awal semua vendor wajib diisi dan lebih besar dari 0.' });
    const durasi = parseFloat(durasiMenit);
    if (isNaN(durasi) || durasi <= 0) return sendJson(res, 400, { error: 'Durasi ronde tidak valid.' });
    const parsedHps = hps != null && hps !== '' ? parseMoney(hps) : null;
    const parsedNilaiWajar = nilaiWajar != null && nilaiWajar !== '' ? parseMoney(nilaiWajar) : null;
    if (parsedHps == null || !Number.isFinite(parsedHps) || parsedHps <= 0) return sendJson(res, 400, { error: 'HPS / Pagu Harga wajib diisi dan harus lebih besar dari 0.' });
    if (parsedNilaiWajar != null && (!Number.isFinite(parsedNilaiWajar) || parsedNilaiWajar <= 0)) return sendJson(res, 400, { error: 'Nilai wajar harus lebih besar dari 0.' });

    let code;
    do { code = genCode(); } while (sessions.has(code));
    const session = {
      code,
      adminToken: genToken(),
      title: String(title || '').trim() || 'Pengadaan BNU',
      description: String(description || '').trim() || 'Panitia mengontrol ronde; setiap vendor mengirim penawaran dari perangkat masing-masing melalui link Peserta.',
      vendors,
      durasiSec: Math.round(durasi * 60),
      hps: parsedHps,
      nilaiWajar: parsedNilaiWajar,
      hpsRevealed: !!hpsRevealed,
      teknisRevealed: !!teknisRevealed,
      phase: 'running',
      rounds: [],
      activityLog: [],
      result: null,
    };
    sessions.set(code, session);
    logActivity(session, 'Panitia', 'Membuat sesi bidding', session.title);
    return sendJson(res, 200, {
      code,
      adminToken: session.adminToken,
      title: session.title,
      description: session.description,
      vendors: session.vendors.map(({ id, name, token, hargaAwal }) => ({ id, name, token, hargaAwal })),
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
        bids: Object.fromEntries(session.vendors.map((vendor) => [vendor.id, null])),
        scores: Object.fromEntries(session.vendors.map((vendor) => [vendor.id, null])),
        bidLog: [],
        timer: null,
      };
      round.timer = setTimeout(() => {
        closeRoundInternal(session, round);
        logActivity(session, 'Sistem', 'Menutup ronde otomatis', 'Ronde ' + round.num + ' selesai karena waktu habis');
      }, session.durasiSec * 1000);
      session.rounds.push(round);
      logActivity(session, 'Panitia', 'Membuka ronde', 'Ronde ' + round.num);
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
      logActivity(session, 'Panitia', 'Menutup ronde', 'Ronde ' + r.num);
      return sendJson(res, 200, { ok: true });
    }

    // POST finish session
    if (sub === '/admin/finish' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Body invalid.' }); }
      if (body.adminToken !== session.adminToken) return sendJson(res, 403, { error: 'Token admin salah.' });
      const active = currentRound(session);
      if (active && active.status === 'active') return sendJson(res, 400, { error: 'Tutup ronde aktif dahulu.' });

      const prices = Object.fromEntries(session.vendors.map((vendor) => [vendor.id, lastClosedPrice(session, vendor.id)]));
      const sc = computeScores(prices, session);
      const rows = session.vendors.map((vendor) => ({ id: vendor.id, name: vendor.name, teknis: vendor.teknis, price: prices[vendor.id], score: prices[vendor.id] != null ? sc.scores[vendor.id] : null, total: totalMerit(vendor.teknis, sc.scores[vendor.id], prices[vendor.id] != null) }))
        .map((r) => ({ ...r, hps: priceStatus(r.price, session) }))
        .sort((a, b) => {
          if (a.hps.eligible !== b.hps.eligible) return a.hps.eligible ? -1 : 1;
          return b.total - a.total;
        });
      const eligibleRows = rows.filter((r) => r.hps.eligible && r.price != null);
      let headline, subline;
      if (eligibleRows.length === 0) {
        headline = 'Tidak Ada Vendor yang Memenuhi Syarat HPS';
        subline = 'Semua harga penawaran akhir melebihi HPS. Perlu tindak lanjut Panitia Pengadaan.';
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
          num: r.num, bids: r.bids,
          leaderLabel: evaluateRound(session, r).leaderLabel,
        })),
      };
      session.phase = 'finished';
      logActivity(session, 'Panitia', 'Mengakhiri sesi bidding', 'Hasil akhir ditampilkan');
      return sendJson(res, 200, { ok: true, result: session.result });
    }

    // GET vendor view
    if (sub === '/vendor' && req.method === 'GET') {
      const token = u.searchParams.get('token');
      const vendor = vendorForToken(session, token);
      if (!vendor) return sendJson(res, 403, { error: 'Token akses tidak valid.' });
      return sendJson(res, 200, buildVendorView(session, vendor));
    }

    // POST vendor bid
    if (sub === '/vendor/bid' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Body invalid.' }); }
      const vendor = vendorForToken(session, body.token);
      if (!vendor) return sendJson(res, 403, { error: 'Token akses tidak valid.' });
      const r = currentRound(session);
      if (!r || r.status !== 'active') return sendJson(res, 400, { error: 'Belum ada ronde aktif untuk menerima penawaran.' });
      const val = parseMoney(body.price);
      if (isNaN(val) || val <= 0) return sendJson(res, 400, { error: 'Masukkan angka harga yang valid.' });
      const currentPrice = r.bids[vendor.id];
      const previousClosedPrice = lastClosedPrice(session, vendor.id);
      const previousPrice = currentPrice != null ? currentPrice : (previousClosedPrice != null ? previousClosedPrice : vendor.hargaAwal);
      if (val >= previousPrice) {
        return sendJson(res, 400, { error: 'Harga harus lebih rendah dari penawaran sebelumnya (Rp ' + Number(previousPrice).toLocaleString('id-ID') + ').' });
      }
      r.bids[vendor.id] = val;
      const evaluation = evaluateRound(session, r);
      r.bidLog.push({
        at: Date.now(),
        vendorId: vendor.id,
        vendorName: vendor.name,
        price: val,
        leaderLabel: evaluation.leaderLabel,
      });
      logActivity(session, vendor.name, 'Mengirim penawaran', 'Ronde ' + r.num + ': Rp ' + Number(val).toLocaleString('id-ID'));
      let warning = null;
      if (session.hps != null && val > session.hps) warning = 'Peringatan: harga di atas HPS, tetap tersimpan.';
      if (session.nilaiWajar != null && val < session.nilaiWajar) warning = 'Peringatan: harga di bawah nilai wajar, tidak memenuhi syarat skor.';
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
