# usdt-lab

Flash-USDT fraud-mechanics research lab (**testnet only**) + defensive
payment-verification toolkit.

Built to study how "flash USDT / fake Tether" scams work at the transaction
level — and to prove that a small set of on-chain checks detects every
variant. All offensive demonstrations run on the **TRON Nile testnet**
where tokens are worthless by design.

## Modules

- **Mempool ghost (Nile)** — broadcasts a TRC-20 transfer with a starved
  `feeLimit`: visible as PENDING in wallets/explorers, then dies
  `OUT_OF_ENERGY`. The exact "flash" vector, contained on testnet.
- **Lookalike token (Nile)** — deploys a TRC-20 with identical metadata
  (`Tether USD`/`USDT`/6 decimals) on a different contract address.
  Demonstrates counterfeit-by-metadata.
- **Verifier** — `GET /api/verify/:txid` → verdicts `REAL_USDT`,
  `COUNTERFEIT_TOKEN`, `FAILED`, `PENDING_UNCONFIRMED`, `NOT_ON_CHAIN`.
- **Credit-check** — `GET /api/credit-check/:txid?for=<addr>&amount=<n>` —
  gateway-grade pipeline: solidified block + SUCCESS + `Transfer` event
  emitted by the real contract to the expected address/amount.
- **Attack suite** — `POST /api/attack-suite` — fires real attack txs
  (including counterfeit USDT found live on mainnet) at the credit-check
  and reports what slips through.
- **Mainnet tryout** — two lab wallets, real 1 USDT transfer A→B, shows the
  pending-vs-finality gap with a genuine transaction.

## Run

```bash
docker compose up -d --build
# http://localhost:8080
```

Fund the lab's Nile account via https://nileex.io/join/getJoinPage (free
testnet TRX) to enable modules 1–2.

## Boundary

Testnet-only by design. Nothing here sends anything on mainnet except the
read-only verifier and the wallet A→B demo using your own funds.
