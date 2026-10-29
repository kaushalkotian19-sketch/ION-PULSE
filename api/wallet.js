// api/wallet.js — Vercel Serverless Function for 100% Real ION Mainnet & LION Staking Data
export default async function handler(req, res) {
  // Enable CORS for your frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { address } = req.query;
  if (!address || typeof address !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid ION wallet address parameter.' });
  }

  const cleanAddr = address.trim();
  const LION_MASTER_CONTRACT = 'EQACbwI38RnvclU5Wv6H9zDr8Ao_tq9NWilXxBmoE8yroZlF';

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'ION-Prism-Analytics/3.0 (Vercel Serverless)'
  };

  // Helper to fetch first working endpoint from ION Mainnet Indexer candidates
  async function fetchFirstJson(urls) {
    const errors = [];
    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          return { data, sourceUrl: url };
        }
        errors.push(`${url} -> HTTP ${response.status}`);
      } catch (err) {
        errors.push(`${url} -> ${err.message}`);
      }
    }
    throw new Error(errors.join(' | '));
  }

  try {
    // 1. Fetch Native ION Account Balance & State
    const accountResult = await fetchFirstJson([
      `https://explorer.ice.io/api/v2/accounts/${encodeURIComponent(cleanAddr)}`,
      `https://api.mainnet.ice.io/v2/accounts/${encodeURIComponent(cleanAddr)}`,
      `https://explorer.ice.io/api/v2/getAddressInformation?address=${encodeURIComponent(cleanAddr)}`,
      `https://api.mainnet.ice.io/api/v2/getAddressInformation?address=${encodeURIComponent(cleanAddr)}`
    ]);

    // 2. Fetch Jetton Balances (Specifically $LION: EQACbwI38RnvclU5Wv6H9zDr8Ao_tq9NWilXxBmoE8yroZlF)
    let jettonsData = null;
    try {
      const jettonResult = await fetchFirstJson([
        `https://explorer.ice.io/api/v2/accounts/${encodeURIComponent(cleanAddr)}/jettons`,
        `https://api.mainnet.ice.io/v2/accounts/${encodeURIComponent(cleanAddr)}/jettons`,
        `https://explorer.ice.io/api/v2/jettons/balances?account=${encodeURIComponent(cleanAddr)}`
      ]);
      jettonsData = jettonResult.data;
    } catch (_) {
      jettonsData = { balances: [] };
    }

    // 3. Fetch Real On-Chain Transactions & Staking Events
    let txData = null;
    try {
      const txResult = await fetchFirstJson([
        `https://explorer.ice.io/api/v2/accounts/${encodeURIComponent(cleanAddr)}/events?limit=100`,
        `https://explorer.ice.io/api/v2/getTransactions?address=${encodeURIComponent(cleanAddr)}&limit=100`,
        `https://api.mainnet.ice.io/v2/accounts/${encodeURIComponent(cleanAddr)}/events?limit=100`
      ]);
      txData = txResult.data;
    } catch (_) {
      txData = { events: [] };
    }

    // 4. Fetch Global Staking Pool State for Live LION/ION Exchange Rate
    let poolRate = null;
    let poolApy = null;
    try {
      const poolResult = await fetchFirstJson([
        `https://explorer.ice.io/api/v2/jettons/${LION_MASTER_CONTRACT}`,
        `https://stake.ice.io/api/staking/stats`,
        `https://explorer.ice.io/api/v2/staking/pool`
      ]);
      if (poolResult.data) {
        poolRate = Number(poolResult.data.exchange_rate || poolResult.data.rate || 0) || null;
        poolApy = Number(poolResult.data.apy || poolResult.data.nominal_apy || 0) || null;
      }
    } catch (_) {
      // Handled downstream if pool stats endpoint requires calculation from events
    }

    // Parse Native ION Balance (9 decimals = nanoION)
    const acc = accountResult.data?.result || accountResult.data;
    const rawBalance = acc?.balance ?? acc?.amount ?? 0;
    const liquidIon = Number(rawBalance) / 1e9;

    // Parse $LION Balance from Jetton Wallets
    let lionBalance = 0;
    const balancesList = jettonsData?.balances || jettonsData?.jettons || (Array.isArray(jettonsData) ? jettonsData : []);
    for (const item of balancesList) {
      const symbol = (item?.jetton?.symbol || item?.symbol || '').toUpperCase();
      const masterAddr = item?.jetton?.address || item?.jetton_address || '';
      if (symbol.includes('LION') || masterAddr === LION_MASTER_CONTRACT) {
        const decimals = Number(item?.jetton?.decimals || item?.decimals || 9);
        lionBalance = Number(item?.balance || 0) / Math.pow(10, decimals);
      }
    }

    // Parse Real On-Chain Transactions
    const rawTxList = txData?.events || txData?.transactions || txData?.result || (Array.isArray(txData) ? txData : []);
    const transactions = rawTxList.map((tx, idx) => {
      const timestamp = (tx.timestamp || tx.utime || Math.floor(Date.now() / 1000)) * 1000;
      const dateStr = new Date(timestamp).toISOString().split('T')[0];
      const timeStr = new Date(timestamp).toISOString().slice(11, 16) + ' UTC';
      const txHash = tx.event_id || tx.hash || tx.transaction_id?.hash || `tx_${idx}`;

      let type = 'TRANSFER';
      let label = 'On-Chain Transaction';
      let deltaIon = 0;
      let counterparty = cleanAddr;

      if (tx.actions && Array.isArray(tx.actions) && tx.actions.length > 0) {
        const act = tx.actions[0];
        const actType = (act.type || '').toUpperCase();
        if (actType.includes('JETTON') || JSON.stringify(act).includes('LION')) {
          type = 'STAKE';
          label = act.JettonTransfer ? 'LION Liquid Staking Transfer' : 'LION Contract Interaction';
          const amt = act.JettonTransfer?.amount || act.amount || 0;
          deltaIon = Number(amt) / 1e9;
          counterparty = act.JettonTransfer?.recipient?.address || act.JettonTransfer?.sender?.address || LION_MASTER_CONTRACT;
        } else if (act.TonTransfer || act.IonTransfer) {
          const transfer = act.TonTransfer || act.IonTransfer;
          const isOutgoing = transfer.sender?.address === cleanAddr;
          deltaIon = (Number(transfer.amount || 0) / 1e9) * (isOutgoing ? -1 : 1);
          type = isOutgoing ? 'SENT' : 'RECEIVED';
          counterparty = isOutgoing ? (transfer.recipient?.address || '') : (transfer.sender?.address || '');
          label = isOutgoing ? 'ION Sent' : 'ION Received';
        }
      } else if (tx.in_msg || tx.out_msgs) {
        const outMsg = Array.isArray(tx.out_msgs) && tx.out_msgs[0];
        if (outMsg && Number(outMsg.value) > 0) {
          deltaIon = -(Number(outMsg.value) / 1e9);
          type = 'SENT';
          counterparty = outMsg.destination || '';
          label = 'ION Sent';
        } else if (tx.in_msg && Number(tx.in_msg.value) > 0) {
          deltaIon = Number(tx.in_msg.value) / 1e9;
          type = 'RECEIVED';
          counterparty = tx.in_msg.source || '';
          label = 'ION Received';
        }
      }

      return {
        id: txHash,
        date: dateStr,
        time: timeStr,
        timestamp,
        type,
        label,
        deltaIon,
        counterparty,
        txHash
      };
    });

    return res.status(200).json({
      ok: true,
      address: cleanAddr,
      sourceUrl: accountResult.sourceUrl,
      status: acc?.status || 'active',
      liquidIon,
      lionBalance,
      poolRate,
      poolApy,
      transactions
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'Unable to reach ION Mainnet Indexer for this address.',
      details: error.message
    });
  }
}
