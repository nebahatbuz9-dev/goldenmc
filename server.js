const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const net = require('net');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ════════════════════════════════════════
//  AYARLAR — .env dosyasından gelir
// ════════════════════════════════════════
const RCON_HOST     = process.env.RCON_HOST     || 'sunucu.falixservers.com';
const RCON_PORT     = parseInt(process.env.RCON_PORT)     || 25575;
const RCON_PASSWORD = process.env.RCON_PASSWORD || 'goldenmc2025';

const PAYTR_MERCHANT_ID  = process.env.PAYTR_MERCHANT_ID  || '';
const PAYTR_MERCHANT_KEY = process.env.PAYTR_MERCHANT_KEY || '';
const PAYTR_MERCHANT_SALT= process.env.PAYTR_MERCHANT_SALT|| '';
const BACKEND_URL        = process.env.BACKEND_URL        || 'https://goldenmc-backend.onrender.com';

// ════════════════════════════════════════
//  VIP PAKETLERİ
// ════════════════════════════════════════
const PACKAGES = {
  'VIP':        { price: 6000,  luckpermsGroup: 'vip',        display: 'VIP'        },
  'VIP+':       { price: 8000,  luckpermsGroup: 'vipplus',     display: 'VIP+'       },
  'KVIP':       { price: 12000, luckpermsGroup: 'kvip',        display: 'KVIP'       },
  'KVIP+':      { price: 16000, luckpermsGroup: 'kvipplus',    display: 'KVIP+'      },
  'GoldenVIP':  { price: 20000, luckpermsGroup: 'goldenvip',   display: 'GoldenVIP'  },
  'GoldenVIP+': { price: 24000, luckpermsGroup: 'goldenvipplus',display: 'GoldenVIP+'},
};

// Bekleyen siparişler (production'da DB kullan)
const pendingOrders = new Map();

// ════════════════════════════════════════
//  RCON — Minecraft sunucusuna komut gönder
// ════════════════════════════════════════
function rconSend(command) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let authenticated = false;
    let buf = Buffer.alloc(0);

    const buildPacket = (id, type, body) => {
      const bodyBuf = Buffer.from(body + '\x00', 'utf8');
      const len = 4 + 4 + bodyBuf.length + 1;
      const pkt = Buffer.alloc(4 + len);
      pkt.writeInt32LE(len, 0);
      pkt.writeInt32LE(id, 4);
      pkt.writeInt32LE(type, 8);
      bodyBuf.copy(pkt, 12);
      pkt.writeUInt8(0, 12 + bodyBuf.length);
      return pkt;
    };

    socket.setTimeout(8000);
    socket.connect(RCON_PORT, RCON_HOST, () => {
      // Auth paketi gönder (type=3)
      socket.write(buildPacket(1, 3, RCON_PASSWORD));
    });

    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 14) {
        const len = buf.readInt32LE(0);
        if (buf.length < 4 + len) break;
        const id   = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.slice(12, 4 + len - 2).toString('utf8');
        buf = buf.slice(4 + len);

        if (!authenticated) {
          if (id === -1) { socket.destroy(); reject(new Error('RCON auth failed')); return; }
          authenticated = true;
          // Komut gönder (type=2)
          socket.write(buildPacket(2, 2, command));
        } else {
          socket.destroy();
          resolve(body);
        }
      }
    });

    socket.on('timeout', () => { socket.destroy(); reject(new Error('RCON timeout')); });
    socket.on('error', (err) => reject(err));
  });
}

// LuckPerms ile rank ver
async function giveRank(username, luckpermsGroup) {
  const cmd = `lp user ${username} parent set ${luckpermsGroup}`;
  console.log(`[RCON] Komut: ${cmd}`);
  const result = await rconSend(cmd);
  console.log(`[RCON] Sonuç: ${result}`);
  return result;
}

// ════════════════════════════════════════
//  RCON TEST ENDPOINTİ
// ════════════════════════════════════════
app.get('/api/rcon-test', async (req, res) => {
  try {
    const result = await rconSend('list');
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════
//  ONLINE OYUNCU SAYISI
// ════════════════════════════════════════
app.get('/api/players', async (req, res) => {
  try {
    const result = await rconSend('list');
    // "There are X of a max of Y players online: ..."
    const match = result.match(/There are (\d+) of a max of (\d+)/i);
    if (match) {
      res.json({ online: parseInt(match[1]), max: parseInt(match[2]) });
    } else {
      res.json({ online: 0, max: 500, raw: result });
    }
  } catch (err) {
    res.json({ online: 0, max: 500, error: err.message });
  }
});

// ════════════════════════════════════════
//  KULLANICI RANK SORGU
// ════════════════════════════════════════
app.get('/api/user/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const result = await rconSend(`lp user ${username} info`);
    let rank = 'Üye';
    // LuckPerms çıktısından parent group'u çek
    const match = result.match(/parent groups:\s*([^\n]+)/i) ||
                  result.match(/Groups:\s*([^\n]+)/i);
    if (match) {
      const groups = match[1].trim().split(/[\s,]+/);
      // En yüksek rankı bul
      const rankOrder = ['goldenvipplus','goldenvip','kvipplus','kvip','vipplus','vip','default'];
      for (const r of rankOrder) {
        if (groups.map(g=>g.toLowerCase()).includes(r)) {
          rank = PACKAGES[Object.keys(PACKAGES).find(k =>
            PACKAGES[k].luckpermsGroup === r
          )]?.display || r.toUpperCase();
          break;
        }
      }
    }
    res.json({ ok: true, username, rank, raw: result });
  } catch (err) {
    res.json({ ok: false, username, rank: 'Üye', error: err.message });
  }
});

// ════════════════════════════════════════
//  ÖDEME BAŞLAT — PayTR iFrame
// ════════════════════════════════════════
app.post('/api/payment/start', async (req, res) => {
  const { username, packageName, email, userIp } = req.body;

  if (!username || !packageName || !email) {
    return res.status(400).json({ ok: false, error: 'Eksik bilgi' });
  }

  const pkg = PACKAGES[packageName];
  if (!pkg) return res.status(400).json({ ok: false, error: 'Geçersiz paket' });

  const orderId = `GM-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

  // Siparişi kaydet
  pendingOrders.set(orderId, { username, packageName, pkg, email, createdAt: Date.now() });

  const merchantId   = PAYTR_MERCHANT_ID;
  const userIpAddr   = userIp || '127.0.0.1';
  const userBasket   = Buffer.from(JSON.stringify([[pkg.display, (pkg.price/100).toFixed(2), 1]])).toString('base64');
  const noInstallment= 1;
  const maxInstallment = 0;
  const currency     = 'TL';
  const testMode     = 0; // Canlıda 0 yap
  const lang         = 'tr';

  const hashStr = `${merchantId}${userIpAddr}${orderId}${email}${pkg.price}${userBasket}${noInstallment}${maxInstallment}${currency}${testMode}`;
  const token   = crypto.createHmac('sha256', PAYTR_MERCHANT_KEY + PAYTR_MERCHANT_SALT)
                        .update(hashStr)
                        .digest('base64');

  try {
    const params = new URLSearchParams({
      merchant_id:      merchantId,
      user_ip:          userIpAddr,
      merchant_oid:     orderId,
      email:            email,
      payment_amount:   pkg.price,
      paytr_token:      token,
      user_basket:      userBasket,
      debug_on:         0,
      no_installment:   noInstallment,
      max_installment:  maxInstallment,
      user_name:        username,
      user_address:     'GoldenMC',
      user_phone:       '05000000000',
      merchant_ok_url:  `${BACKEND_URL}/payment/success`,
      merchant_fail_url:`${BACKEND_URL}/payment/fail`,
      timeout_limit:    30,
      currency,
      test_mode:        testMode,
      lang,
    });

    const response = await axios.post('https://www.paytr.com/odeme/api/get-token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (response.data.status === 'success') {
      res.json({ ok: true, token: response.data.token, orderId });
    } else {
      res.status(500).json({ ok: false, error: response.data.reason || 'PayTR hatası' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════
//  PayTR CALLBACK — Ödeme sonucu
// ════════════════════════════════════════
app.post('/api/payment/callback', async (req, res) => {
  const { merchant_oid, status, total_amount, hash } = req.body;

  // Hash doğrula
  const hashStr = `${merchant_oid}${PAYTR_MERCHANT_SALT}${status}${total_amount}`;
  const expectedHash = crypto.createHmac('sha256', PAYTR_MERCHANT_KEY)
                             .update(hashStr)
                             .digest('base64');

  if (hash !== expectedHash) {
    console.error('[PAYTR] Hash doğrulama başarısız!');
    return res.send('PAYTR_ERROR');
  }

  const order = pendingOrders.get(merchant_oid);
  if (!order) {
    console.error('[PAYTR] Sipariş bulunamadı:', merchant_oid);
    return res.send('OK'); // PayTR tekrar denemez
  }

  if (status === 'success') {
    console.log(`[PAYTR] ✅ Ödeme başarılı: ${merchant_oid} | ${order.username} → ${order.pkg.display}`);
    try {
      await giveRank(order.username, order.pkg.luckpermsGroup);
      console.log(`[RCON] ✅ Rank verildi: ${order.username} → ${order.pkg.luckpermsGroup}`);
    } catch (err) {
      console.error('[RCON] ❌ Rank verilemedi:', err.message);
      // Tekrar dene
      setTimeout(async () => {
        try { await giveRank(order.username, order.pkg.luckpermsGroup); } catch(e) {}
      }, 10000);
    }
    pendingOrders.delete(merchant_oid);
  } else {
    console.log(`[PAYTR] ❌ Ödeme başarısız: ${merchant_oid}`);
    pendingOrders.delete(merchant_oid);
  }

  res.send('OK'); // PayTR bu cevabı bekler
});

// ════════════════════════════════════════
//  ÖDEME SONUÇ SAYFALARI
// ════════════════════════════════════════
app.get('/payment/success', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Ödeme Başarılı</title>
  <style>body{background:#0a0a0a;color:#FFD700;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}h1{font-size:3rem}p{color:#aaa}</style>
  </head><body>
  <div><div style="font-size:4rem">🎉</div><h1>Ödeme Başarılı!</h1>
  <p>Rankın birkaç saniye içinde oyuna yansıyacak.</p>
  <p style="margin-top:20px"><a href="/" style="color:#FFD700">Ana Sayfaya Dön</a></p></div>
  </body></html>`);
});

app.get('/payment/fail', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Ödeme Başarısız</title>
  <style>body{background:#0a0a0a;color:#ff5252;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}h1{font-size:3rem}p{color:#aaa}</style>
  </head><body>
  <div><div style="font-size:4rem">❌</div><h1>Ödeme Başarısız</h1>
  <p>Bir sorun oluştu. Tekrar deneyin.</p>
  <p style="margin-top:20px"><a href="/" style="color:#FFD700">Ana Sayfaya Dön</a></p></div>
  </body></html>`);
});

// ════════════════════════════════════════
//  SUNUCU BAŞLAT
// ════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ GoldenMC Backend çalışıyor → port ${PORT}`);
  console.log(`🔗 RCON: ${RCON_HOST}:${RCON_PORT}`);
});