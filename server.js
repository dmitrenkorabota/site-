require('dotenv').config();

const express  = require('express');
const path     = require('path');
const https    = require('https');
const crypto   = require('crypto');
const multer   = require('multer');
const Minio    = require('minio');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MINIO ──
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'lexodessa';

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port:     parseInt(process.env.MINIO_PORT) || 443,
  useSSL:   process.env.MINIO_USE_SSL !== 'false',
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});

const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL || `https://${process.env.MINIO_ENDPOINT}/${MINIO_BUCKET}`;

async function initMinio() {
  const exists = await minioClient.bucketExists(MINIO_BUCKET);
  if (!exists) await minioClient.makeBucket(MINIO_BUCKET);
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${MINIO_BUCKET}/*`] }],
  });
  await minioClient.setBucketPolicy(MINIO_BUCKET, policy);
}

async function uploadToMinio(buffer, mimetype, folder) {
  const ext = (mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const objectName = `${folder}/${Date.now()}.${ext}`;
  await minioClient.putObject(MINIO_BUCKET, objectName, buffer, buffer.length, { 'Content-Type': mimetype });
  return { url: `${MINIO_PUBLIC_URL}/${objectName}`, public_id: objectName };
}

async function deleteFromMinio(objectName) {
  if (!objectName) return;
  try { await minioClient.removeObject(MINIO_BUCKET, objectName); } catch {}
}

// ── DATABASE ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DATABASE_URL || '').includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      message TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      status TEXT DEFAULT 'new'
    );
    CREATE TABLE IF NOT EXISTS team (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      bio TEXT DEFAULT '',
      initials TEXT DEFAULT '',
      photo_url TEXT,
      photo_public_id TEXT
    );
    CREATE TABLE IF NOT EXISTS photo_slots (
      prefix TEXT NOT NULL,
      slot TEXT NOT NULL,
      url TEXT NOT NULL,
      public_id TEXT,
      PRIMARY KEY (prefix, slot)
    );
  `);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM team');
  if (rows[0].cnt === 0) {
    const defaults = [
      { id: 1, name: 'Михайло Кравченко', role: 'Керуючий партнер', bio: '20 років досвіду в господарських та цивільних справах. Кандидат юридичних наук.', initials: 'МК' },
      { id: 2, name: 'Наталія Шевченко',  role: 'Адвокат',          bio: 'Сімейне право, спадщина, нерухомість. 12 років практики.', initials: 'НШ' },
      { id: 3, name: 'Олег Дорошенко',    role: 'Адвокат',          bio: 'Кримінальний захист, адміністративні справи. 10 років у правоохоронних органах.', initials: 'ОД' },
      { id: 4, name: 'Анна Петренко',     role: 'Юрист',            bio: 'Корпоративне право, договірна робота, бізнес-супровід. 8 років досвіду.', initials: 'АП' },
    ];
    for (const m of defaults) {
      await pool.query(
        'INSERT INTO team (id,name,role,bio,initials) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [m.id, m.name, m.role, m.bio, m.initials]
      );
    }
  }
}

// ── TELEGRAM ──
const TG_TOKEN   = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' });
  const req  = https.request({
    hostname: 'api.telegram.org',
    path:     `/bot${TG_TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', err => console.error('Telegram error:', err.message));
  req.write(body);
  req.end();
}

// ── ADMIN AUTH ──
const ADMIN_PASS  = process.env.ADMIN_PASS || 'admin';
const ADMIN_TOKEN = crypto.createHash('sha256').update('lex:' + ADMIN_PASS).digest('hex').slice(0, 40);

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] === ADMIN_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── UPLOAD ──
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function errMsg(e) { return e?.message || JSON.stringify(e); }

// ── PHOTO SLOT HELPERS ──
async function getSlots(prefix) {
  const { rows } = await pool.query('SELECT slot, url FROM photo_slots WHERE prefix=$1', [prefix]);
  const photos = {};
  rows.forEach(r => { photos[r.slot] = { slot: r.slot, url: r.url }; });
  return photos;
}

async function upsertSlot(prefix, slot, url, publicId) {
  const { rows } = await pool.query('SELECT public_id FROM photo_slots WHERE prefix=$1 AND slot=$2', [prefix, slot]);
  await deleteFromMinio(rows[0]?.public_id);
  await pool.query(
    `INSERT INTO photo_slots (prefix,slot,url,public_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (prefix,slot) DO UPDATE SET url=$3, public_id=$4`,
    [prefix, slot, url, publicId]
  );
}

async function removeSlot(prefix, slot) {
  const { rows } = await pool.query('SELECT public_id FROM photo_slots WHERE prefix=$1 AND slot=$2', [prefix, slot]);
  await deleteFromMinio(rows[0]?.public_id);
  await pool.query('DELETE FROM photo_slots WHERE prefix=$1 AND slot=$2', [prefix, slot]);
}

// ── AUTH ──
app.post('/api/auth', (req, res) => {
  if (req.body.password === ADMIN_PASS) return res.json({ ok: true, token: ADMIN_TOKEN });
  res.status(401).json({ error: 'Невірний пароль' });
});

// ── LEADS ──
app.post('/api/lead', async (req, res) => {
  const { name, phone, message } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "Ім'я та телефон обов'язкові" });
  try {
    await pool.query('INSERT INTO leads (id,name,phone,message) VALUES ($1,$2,$3,$4)', [Date.now(), name, phone, message || '']);
    const now = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' });
    sendTelegram(`🔔 <b>Нова заявка з сайту!</b>\n\n👤 <b>Ім'я:</b> ${name}\n📞 <b>Телефон:</b> ${phone}\n${message ? `💬 <b>Повідомлення:</b> ${message}\n` : ''}\n⏰ ${now}`);
    res.status(201).json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Помилка сервера' }); }
});

app.get('/api/clients', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
    res.json({ total: rows.length, clients: rows.map(r => ({ id: Number(r.id), name: r.name, phone: r.phone, message: r.message, createdAt: r.created_at, status: r.status })) });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', requireAdmin, async (req, res) => {
  try { await pool.query('UPDATE leads SET status=$1 WHERE id=$2', [req.body.status || 'new', req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id', requireAdmin, async (req, res) => {
  try { await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TEAM ──
app.get('/api/team', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM team ORDER BY id');
    res.json({ team: rows.map(r => ({ ...r, photoUrl: r.photo_url })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/team/:id', requireAdmin, async (req, res) => {
  try {
    const { name, role, bio } = req.body;
    const initials = name ? name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2) : null;
    await pool.query(
      `UPDATE team SET name=COALESCE($1,name), role=COALESCE($2,role), bio=COALESCE($3,bio), initials=COALESCE($4,initials) WHERE id=$5`,
      [name || null, role || null, bio ?? null, initials, req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM team WHERE id=$1', [req.params.id]);
    res.json({ success: true, member: { ...rows[0], photoUrl: rows[0].photo_url } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload/team/:slot', requireAdmin, memUpload.single('photo'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT photo_public_id FROM team WHERE id=$1', [req.params.slot]);
    await deleteFromMinio(rows[0]?.photo_public_id);
    const { url, public_id } = await uploadToMinio(req.file.buffer, req.file.mimetype, 'team');
    await pool.query('UPDATE team SET photo_url=$1, photo_public_id=$2 WHERE id=$3', [url, public_id, req.params.slot]);
    res.status(201).json({ success: true, url });
  } catch (e) { console.error('team upload:', errMsg(e)); res.status(500).json({ error: errMsg(e) }); }
});

app.delete('/api/team-photos/:slot', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT photo_public_id FROM team WHERE id=$1', [req.params.slot]);
    await deleteFromMinio(rows[0]?.photo_public_id);
    await pool.query('UPDATE team SET photo_url=NULL, photo_public_id=NULL WHERE id=$1', [req.params.slot]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ABOUT SLOTS ──
app.get('/api/about-photos', async (req, res) => {
  try { res.json({ photos: await getSlots('about') }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/upload/about/:slot', requireAdmin, memUpload.single('photo'), async (req, res) => {
  try {
    const { url, public_id } = await uploadToMinio(req.file.buffer, req.file.mimetype, 'about');
    await upsertSlot('about', req.params.slot, url, public_id);
    res.status(201).json({ success: true, url });
  } catch (e) { console.error('about upload:', errMsg(e)); res.status(500).json({ error: errMsg(e) }); }
});
app.delete('/api/about-photos/:slot', requireAdmin, async (req, res) => {
  try { await removeSlot('about', req.params.slot); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CASE SLOTS ──
app.get('/api/case-photos', async (req, res) => {
  try { res.json({ photos: await getSlots('case') }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/upload/case/:slot', requireAdmin, memUpload.single('photo'), async (req, res) => {
  try {
    const { url, public_id } = await uploadToMinio(req.file.buffer, req.file.mimetype, 'cases');
    await upsertSlot('case', req.params.slot, url, public_id);
    res.status(201).json({ success: true, url });
  } catch (e) { console.error('case upload:', errMsg(e)); res.status(500).json({ error: errMsg(e) }); }
});
app.delete('/api/case-photos/:slot', requireAdmin, async (req, res) => {
  try { await removeSlot('case', req.params.slot); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN PAGE ──
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ── GLOBAL ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message || err);
  res.status(500).json({ error: err.message || 'Помилка' });
});

// ── START ──
Promise.all([
  initDB(),
  initMinio().catch(e => console.error('⚠️  MinIO init error (non-fatal):', e.message)),
]).then(() => {
    app.listen(PORT, () => {
      console.log(`\n✅  http://localhost:${PORT}`);
      console.log(`🔑  Адмін: http://localhost:${PORT}/admin`);
      console.log(`🔐  Пароль: ${ADMIN_PASS}`);
      console.log(`📦  DATABASE_URL:    ${process.env.DATABASE_URL ? '✅' : '❌'}`);
      console.log(`🪣  MINIO_ENDPOINT:  ${process.env.MINIO_ENDPOINT ? '✅ ' + process.env.MINIO_ENDPOINT : '❌ НЕ ВСТАНОВЛЕНО'}`);
      console.log(`✈️   TG_TOKEN:        ${process.env.TG_TOKEN ? '✅' : '❌'}\n`);
    });
  })
  .catch(err => {
    console.error('❌ Init error:', err.message || err);
    process.exit(1);
  });
