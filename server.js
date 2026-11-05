const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 5060;
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `koi_${Date.now()}_${Math.round(Math.random() * 1E9)}${ext}`);
  }
});
const upload = multer({ storage });

const db = new sqlite3.Database(path.join(__dirname, 'koi_database.sqlite'));

// Setup & Auto-migration
db.serialize(() => {
  // Tabel Orders
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE NOT NULL,
    koi_id INTEGER,
    koi_name TEXT,
    koi_price INTEGER,
    shipping_courier TEXT,
    shipping_cost INTEGER DEFAULT 0,
    total_amount INTEGER,
    customer_name TEXT,
    customer_phone TEXT,
    customer_address TEXT,
    customer_city TEXT,
    payment_status TEXT DEFAULT 'UNPAID',
    shipping_status TEXT DEFAULT 'PENDING',
    tracking_number TEXT DEFAULT '',
    shipping_notes TEXT DEFAULT '',
    qris_string TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Timeline Posisi Pesanan Ala Shopee
  db.run(`CREATE TABLE IF NOT EXISTS order_timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    location TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Live Chat (Dual Mode: Bot & Admin)
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    customer_name TEXT DEFAULT 'Tamu Koi',
    sender_type TEXT NOT NULL, -- 'user', 'bot', 'admin'
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Kolom tambahan di store_settings
  const newCols = [
    { name: 'promo_active', type: 'INTEGER DEFAULT 1' },
    { name: 'promo_text', type: "TEXT DEFAULT '🏮 SPECIAL EVENT: Dapatkan Garansi Ikan Hidup & Free Box Blitar ke Seluruh Indonesia!'" },
    { name: 'promo_link', type: "TEXT DEFAULT '#auctions'" },
    { name: 'admin_password', type: "TEXT DEFAULT 'admin123'" },
    { name: 'casaku_license_key', type: "TEXT DEFAULT ''" },
    { name: 'casaku_qr_id', type: "TEXT DEFAULT ''" }
  ];
  newCols.forEach(col => {
    db.run(`ALTER TABLE store_settings ADD COLUMN ${col.name} ${col.type}`, () => {});
  });
});

let activeSessions = new Set();
const requireAdmin = (req, res, next) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token && activeSessions.has(token)) return next();
  return res.status(401).json({ success: false, message: 'Akses ditolak. Silakan login sebagai admin.' });
};

// ==================== AUTH & SETTINGS ====================

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  db.get('SELECT admin_password FROM store_settings WHERE id = 1', (err, row) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    const currentPass = row ? row.admin_password : 'admin123';
    if (password === currentPass) {
      const token = crypto.randomBytes(32).toString('hex');
      activeSessions.add(token);
      return res.json({ success: true, token });
    }
    return res.status(401).json({ success: false, message: 'Password salah!' });
  });
});

app.get('/api/settings', (req, res) => {
  db.get('SELECT * FROM store_settings WHERE id = 1', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || {});
  });
});

app.post('/api/settings', requireAdmin, (req, res) => {
  const { farm_name, tagline, wa_number, location, maps_url, tiktok_url, ig_url, promo_active, promo_text, promo_link, casaku_license_key, casaku_qr_id } = req.body;
  const sql = `UPDATE store_settings SET 
    farm_name = ?, tagline = ?, wa_number = ?, location = ?, maps_url = ?, 
    tiktok_url = ?, ig_url = ?, promo_active = ?, promo_text = ?, promo_link = ?,
    casaku_license_key = ?, casaku_qr_id = ? WHERE id = 1`;
  db.run(sql, [farm_name, tagline, wa_number, location, maps_url, tiktok_url, ig_url, promo_active ? 1 : 0, promo_text, promo_link, casaku_license_key || '', casaku_qr_id || ''], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ==================== ORDER, TIMELINE & CASAKU ====================

app.post('/api/orders/checkout', (req, res) => {
  const { koi_id, customer_name, customer_phone, customer_address, customer_city, shipping_courier, shipping_cost } = req.body;
  
  db.get('SELECT * FROM koi_products WHERE id = ?', [koi_id], (err, koi) => {
    if (err || !koi) return res.status(404).json({ success: false, message: 'Ikan tidak ditemukan' });
    if (koi.is_sold) return res.status(400).json({ success: false, message: 'Ikan ini sudah terjual' });

    const total = koi.price + (parseInt(shipping_cost) || 0);
    const order_id = `KOI-${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

    db.get('SELECT casaku_license_key, casaku_qr_id FROM store_settings WHERE id = 1', async (setErr, settings) => {
      let qrisData = null;
      if (settings && settings.casaku_license_key && settings.casaku_qr_id) {
        try {
          const casakuRes = await fetch('https://api.casaku.id/v1/qris/create', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-license-key': settings.casaku_license_key
            },
            body: JSON.stringify({
              qr_id: settings.casaku_qr_id,
              amount: total,
              qrType: 'dynamic',
              customer_name: customer_name,
              order_id: order_id
            })
          });
          const result = await casakuRes.json();
          if (result && result.data && result.data.qr_string) qrisData = result.data.qr_string;
        } catch (fetchErr) {
          console.error('Casaku Error:', fetchErr);
        }
      }

      const sql = `INSERT INTO orders (
        order_id, koi_id, koi_name, koi_price, shipping_courier, shipping_cost, 
        total_amount, customer_name, customer_phone, customer_address, customer_city, qris_string
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      db.run(sql, [order_id, koi.id, koi.name, koi.price, shipping_courier, shipping_cost || 0, total, customer_name, customer_phone, customer_address, customer_city, qrisData || ''], function(insErr) {
        if (insErr) return res.status(500).json({ success: false, message: insErr.message });

        // Buat Checkpoint Pertama
        db.run(`INSERT INTO order_timeline (order_id, stage, title, description, location) VALUES (?, ?, ?, ?, ?)`,
          [order_id, 'ORDER_CREATED', 'Pesanan Dibuat', 'Pesanan berhasil dibuat, menunggu pembayaran QRIS dari pembeli.', 'Farm Blitar']);

        res.json({
          success: true,
          order_id,
          total_amount: total,
          qris_string: qrisData,
          customer_name
        });
      });
    });
  });
});

app.get('/api/orders/check-status/:order_id', (req, res) => {
  db.get('SELECT order_id, payment_status, shipping_status, tracking_number FROM orders WHERE order_id = ?', [req.params.order_id], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });
    res.json({ success: true, order: row });
  });
});

// Ambil riwayat timeline perjalanan pesanan ala Shopee
app.get('/api/orders/:order_id/details', (req, res) => {
  const orderId = req.params.order_id;
  db.get('SELECT * FROM orders WHERE order_id = ?', [orderId], (err, order) => {
    if (err || !order) return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });

    db.all('SELECT * FROM order_timeline WHERE order_id = ? ORDER BY id ASC', [orderId], (tErr, timeline) => {
      res.json({ success: true, order, timeline: timeline || [] });
    });
  });
});

// Ambil semua pesanan milik customer berdasarkan nomor WA
app.get('/api/customer/orders', (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ success: false, message: 'Nomor WhatsApp dibutuhkan' });
  db.all('SELECT * FROM orders WHERE customer_phone LIKE ? ORDER BY id DESC', [`%${phone}%`], (err, orders) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, orders: orders || [] });
  });
});

// Admin menambahkan Checkpoint Perjalanan Manual (Diantar sampai mana)
app.post('/api/admin/orders/add-checkpoint', requireAdmin, (req, res) => {
  const { order_id, stage, title, description, location } = req.body;
  db.run(`INSERT INTO order_timeline (order_id, stage, title, description, location) VALUES (?, ?, ?, ?, ?)`,
    [order_id, stage, title, description, location || 'Blitar'], function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      
      // Update juga stage di tabel orders jika perlu
      if (stage) {
        db.run('UPDATE orders SET shipping_status = ? WHERE order_id = ?', [stage, order_id]);
      }

      res.json({ success: true, message: 'Checkpoint posisi pesanan berhasil ditambahkan!' });
    });
});

// Admin Update Master Status Pesanan
app.post('/api/admin/orders/update-status', requireAdmin, (req, res) => {
  const { order_id, payment_status, shipping_status, tracking_number, shipping_notes } = req.body;
  const sql = `UPDATE orders SET 
    payment_status = ?, shipping_status = ?, tracking_number = ?, shipping_notes = ? 
    WHERE order_id = ?`;
  db.run(sql, [payment_status, shipping_status, tracking_number, shipping_notes, order_id], (err) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'Status pengiriman berhasil diperbarui!' });
  });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  db.all('SELECT * FROM orders ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Webhook Casaku
app.post('/api/payment/casaku/webhook', (req, res) => {
  const { order_id, status } = req.body;
  if (status === 'PAID' || status === 'SUCCESS') {
    db.run("UPDATE orders SET payment_status = 'PAID', shipping_status = 'QUARANTINE' WHERE order_id = ?", [order_id], () => {
      db.run("UPDATE koi_products SET is_sold = 1 WHERE id = (SELECT koi_id FROM orders WHERE order_id = ?)", [order_id]);
      db.run(`INSERT INTO order_timeline (order_id, stage, title, description, location) VALUES (?, ?, ?, ?, ?)`,
        [order_id, 'PAID', 'Pembayaran QRIS Terverifikasi', 'Dana telah diterima otomatis melalui Casaku. Ikan masuk tahap karantina & puasa.', 'Sabaku Farm Blitar']);
    });
  }
  res.status(200).json({ status: 'ok' });
});

// ==================== DUAL-MODE LIVE CHAT (BOT & ADMIN) ====================

// Ambil riwayat chat berdasarkan session_id pembeli
app.get('/api/chat/history/:session_id', (req, res) => {
  db.all('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC', [req.params.session_id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, messages: rows || [] });
  });
});

// Kirim pesan dari Pembeli
app.post('/api/chat/send', (req, res) => {
  const { session_id, customer_name, message, request_admin } = req.body;
  if (!message || !session_id) return res.status(400).json({ error: 'Data tidak lengkap' });

  // Simpan pesan user
  db.run(`INSERT INTO chat_messages (session_id, customer_name, sender_type, message) VALUES (?, ?, 'user', ?)`,
    [session_id, customer_name || 'Tamu Koi', message], function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Jika user klik "Minta Chat Admin", atau admin sudah pernah masuk di chat ini
      if (request_admin) {
        db.run(`INSERT INTO chat_messages (session_id, customer_name, sender_type, message) VALUES (?, ?, 'bot', ?)`,
          [session_id, customer_name, 'Sistem telah meneruskan percakapan ini ke Admin Official Sabaku. Mohon tunggu sejenak, Admin akan membalas langsung di sini.']);
        return res.json({ success: true, mode: 'admin_requested' });
      }

      // Jika masih mode bot basic
      const q = message.toLowerCase();
      let reply = "Halo! Sebagai Asisten Sabaku Nishikigoi, saya bisa bantu info jenis koi Blitar, lelang, ongkir box oksigen, dan garansi hidup. Atau klik tombol 'Hubungi Admin' jika ingin berbicara langsung dengan owner.";

      if (q.includes('admin') || q.includes('owner') || q.includes('kontak') || q.includes('manusia')) {
        reply = "Permintaan Anda telah kami catat. Anda juga bisa langsung klik tombol 'Hubungi Admin' di atas kolom chat untuk ditangani langsung oleh CS kami.";
      } else if (q.includes('ongkir') || q.includes('kirim') || q.includes('tiki') || q.includes('travel') || q.includes('kalog')) {
        reply = "Pengiriman kami menggunakan box stereofoam berlapis oksigen murni (Garansi 100% Hidup): 🚆 Kalog Kereta (1 malam se-Jawa), 🚐 Travel Door-to-Door langsung sampai rumah, 📦 TIKI ONS Khusus Hewan untuk luar pulau, dan 🚌 Bus AKAP.";
      } else if (q.includes('kohaku') || q.includes('sanke') || q.includes('showa')) {
        reply = "Koleksi kami berasal dari indukan juara Blitar dengan pola beni merah tebal dan shiroji putih salju. Silakan cek menu 'Katalog Resmi' untuk melihat ikan yang ready stok!";
      } else if (q.includes('lelang') || q.includes('bid')) {
        reply = "Untuk ikut lelang, cukup daftarkan nomor WA Anda satu kali di tab Arena Lelang. Lelang berjalan transparan dengan bid step kelipatan 50rb.";
      }

      db.run(`INSERT INTO chat_messages (session_id, customer_name, sender_type, message) VALUES (?, ?, 'bot', ?)`,
        [session_id, customer_name, reply], () => {
          res.json({ success: true, reply });
        });
    });
});

// Admin melihat semua daftar sesi chat aktif
app.get('/api/admin/chats', requireAdmin, (req, res) => {
  const sql = `
    SELECT session_id, customer_name, MAX(created_at) as last_time,
    (SELECT message FROM chat_messages m2 WHERE m2.session_id = m1.session_id ORDER BY id DESC LIMIT 1) as last_message,
    (SELECT sender_type FROM chat_messages m3 WHERE m3.session_id = m1.session_id ORDER BY id DESC LIMIT 1) as last_sender
    FROM chat_messages m1
    GROUP BY session_id
    ORDER BY last_time DESC LIMIT 30
  `;
  db.all(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Admin mengirim balasan ke pengunjung tertentu
app.post('/api/admin/chat/reply', requireAdmin, (req, res) => {
  const { session_id, message } = req.body;
  if (!session_id || !message) return res.status(400).json({ error: 'Pesan tidak boleh kosong' });

  db.run(`INSERT INTO chat_messages (session_id, customer_name, sender_type, message) VALUES (?, 'Admin Official', 'admin', ?)`,
    [session_id, message], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message_id: this.lastID });
    });
});

// ==================== KOI & AUCTIONS ====================

app.get('/api/koi', (req, res) => {
  db.all('SELECT * FROM koi_products ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/koi', requireAdmin, upload.single('imageFile'), (req, res) => {
  const { name, variety, size_cm, gender, breeder, price, desc } = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : (req.body.imageUrl || '');
  db.run(`INSERT INTO koi_products (name, variety, size_cm, gender, breeder, price, image, desc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
    [name, variety, size_cm, gender, breeder, price, image, desc], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true });
    });
});

app.post('/api/koi/toggle-sold/:id', requireAdmin, (req, res) => {
  db.run('UPDATE koi_products SET is_sold = CASE WHEN is_sold = 1 THEN 0 ELSE 1 END WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/koi/:id', requireAdmin, (req, res) => {
  db.run('DELETE FROM koi_products WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/auctions', (req, res) => {
  db.all('SELECT * FROM auctions ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/auctions', requireAdmin, upload.single('imageFile'), (req, res) => {
  const { code, koi_name, variety, size_cm, gender, breeder, open_bid, bid_step, end_time } = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : (req.body.imageUrl || '');
  db.run(`INSERT INTO auctions (code, koi_name, variety, size_cm, gender, breeder, open_bid, bid_step, current_bid, end_time, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, koi_name, variety, size_cm, gender, breeder, open_bid, bid_step, open_bid, end_time, image], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true });
    });
});

app.post('/api/auctions/bid', (req, res) => {
  const { auction_id, name, city, wa, amount } = req.body;
  db.get('SELECT * FROM auctions WHERE id = ?', [auction_id], (err, auction) => {
    if (err || !auction) return res.status(404).json({ success: false, message: 'Lelang tidak ditemukan' });
    if (auction.is_closed || new Date(auction.end_time) < new Date()) {
      return res.status(400).json({ success: false, message: 'Lelang sudah ditutup' });
    }
    const minBid = auction.current_bid + auction.bid_step;
    if (parseInt(amount) < minBid) {
      return res.status(400).json({ success: false, message: `Bid minimal Rp ${minBid.toLocaleString('id-ID')}` });
    }

    db.run('INSERT INTO bid_history (auction_id, name, city, wa, amount) VALUES (?, ?, ?, ?, ?)', [auction_id, name, city, wa, amount], () => {
      db.run('UPDATE auctions SET current_bid = ?, highest_bidder = ?, highest_city = ?, highest_wa = ? WHERE id = ?', [amount, name, city, wa, auction_id], () => {
        res.json({ success: true, current_bid: amount });
      });
    });
  });
});

app.post('/api/bidders/register', (req, res) => {
  const { name, phone, address, city } = req.body;
  db.run('INSERT INTO bidders (name, phone, address, city) VALUES (?, ?, ?, ?)', [name, phone, address, city], function(err) {
    if (err) return res.status(400).json({ success: false, message: 'Nomor WhatsApp sudah terdaftar' });
    res.json({ success: true, id: this.lastID });
  });
});

app.get(['/admin', '/admin-portal', '/admin/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sabaku Luxury Server running on port ${PORT}`);
});
