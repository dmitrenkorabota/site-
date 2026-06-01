const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const crypto  = require('crypto');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── TELEGRAM ──
const TG_TOKEN   = process.env.TG_TOKEN   || '8978477738:AAFc67ACMEKds2gOmxxoNvzTQPlPemBXESs';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '5873169995';

function sendTelegram(text) {
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

// ── UPLOAD DIRS ──
const DIRS = {
  about: path.join(__dirname, 'uploads', 'about'),
  cases: path.join(__dirname, 'uploads', 'cases'),
  team:  path.join(__dirname, 'uploads', 'team'),
};
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── UPLOAD HELPERS ──
const imgFilter = (req, file, cb) =>
  /^image\/(jpeg|jpg|png|webp|gif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Images only'));

function makeUploader(dir, nameFn) {
  return multer({
    storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, dir), filename: nameFn }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: imgFilter,
  });
}

function clearSlot(dir, name) {
  fs.readdirSync(dir).filter(f => f.startsWith(name + '.')).forEach(f => {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  });
}

function readSlots(dir, pattern) {
  const photos = {};
  fs.readdirSync(dir).filter(f => pattern.test(f)).forEach(f => {
    const key = f.replace(/\.[^.]+$/, '').split('-').slice(1).join('-');
    photos[key] = { slot: key, filename: f, url: `/uploads/${path.basename(dir)}/${f}` };
  });
  return photos;
}

function slotUploader(dir, prefix) {
  return makeUploader(dir, (req, file, cb) => {
    const key = req.params.slot;
    const ext = path.extname(file.originalname).toLowerCase();
    clearSlot(dir, `${prefix}-${key}`);
    cb(null, `${prefix}-${key}${ext}`);
  });
}

function mountSlots(prefix, dir, pattern) {
  const up = slotUploader(dir, prefix);
  app.get(`/api/${prefix}-photos`, (req, res) => res.json({ photos: readSlots(dir, pattern) }));
  app.post(`/api/upload/${prefix}/:slot`, requireAdmin, up.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не отримано' });
    res.status(201).json({ success: true, url: `/uploads/${prefix}/${req.file.filename}` });
  });
  app.delete(`/api/${prefix}-photos/:slot`, requireAdmin, (req, res) => {
    clearSlot(dir, `${prefix}-${req.params.slot}`);
    res.json({ success: true });
  });
}

// ── AUTH ──
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) return res.json({ ok: true, token: ADMIN_TOKEN });
  res.status(401).json({ error: 'Невірний пароль' });
});

// ── LEADS ──
const CLIENTS_FILE = path.join(__dirname, 'clients.json');
const loadClients  = () => { try { return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); } catch { return []; } };
const saveClients  = (c) => fs.writeFileSync(CLIENTS_FILE, JSON.stringify(c, null, 2));
let leads = loadClients();

app.post('/api/lead', (req, res) => {
  const { name, phone, message } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "Ім'я та телефон обов'язкові" });
  const lead = { id: Date.now(), name, phone, message: message || '', createdAt: new Date().toISOString(), status: 'new' };
  leads.push(lead);
  saveClients(leads);
  const now = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' });
  sendTelegram(
    `🔔 <b>Нова заявка з сайту!</b>\n\n` +
    `👤 <b>Ім'я:</b> ${name}\n` +
    `📞 <b>Телефон:</b> ${phone}\n` +
    (message ? `💬 <b>Повідомлення:</b> ${message}\n` : '') +
    `\n⏰ ${now}`
  );
  res.status(201).json({ success: true, message: 'Заявку отримано' });
});

app.get('/api/clients', (req, res) => res.json({ total: leads.length, clients: [...leads].reverse() }));

app.put('/api/clients/:id', requireAdmin, (req, res) => {
  const c = leads.find(l => l.id === +req.params.id);
  if (!c) return res.status(404).json({ error: 'Не знайдено' });
  c.status = req.body.status || 'new';
  saveClients(leads);
  res.json({ success: true, client: c });
});

app.delete('/api/clients/:id', requireAdmin, (req, res) => {
  const idx = leads.findIndex(l => l.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Не знайдено' });
  leads.splice(idx, 1);
  saveClients(leads);
  res.json({ success: true });
});

// ── TEAM ──
const TEAM_FILE = path.join(__dirname, 'team.json');
const DEFAULT_TEAM = [
  { id: 1, name: 'Михайло Кравченко', role: 'Керуючий партнер', bio: '20 років досвіду в господарських та цивільних справах. Кандидат юридичних наук.', initials: 'МК' },
  { id: 2, name: 'Наталія Шевченко',  role: 'Адвокат',          bio: 'Сімейне право, спадщина, нерухомість. 12 років практики.', initials: 'НШ' },
  { id: 3, name: 'Олег Дорошенко',    role: 'Адвокат',          bio: 'Кримінальний захист, адміністративні справи. 10 років у правоохоронних органах.', initials: 'ОД' },
  { id: 4, name: 'Анна Петренко',     role: 'Юрист',            bio: 'Корпоративне право, договірна робота, бізнес-супровід. 8 років досвіду.', initials: 'АП' },
];
const loadTeam = () => { try { return JSON.parse(fs.readFileSync(TEAM_FILE, 'utf8')); } catch { return [...DEFAULT_TEAM]; } };
const saveTeam = (t) => fs.writeFileSync(TEAM_FILE, JSON.stringify(t, null, 2));

app.get('/api/team', (req, res) => {
  const team = loadTeam();
  const result = team.map(m => {
    const photo = fs.readdirSync(DIRS.team).find(f => new RegExp(`^team-${m.id}\\.[a-z]+$`, 'i').test(f));
    return { ...m, photoUrl: photo ? `/uploads/team/${photo}` : null };
  });
  res.json({ team: result });
});

app.put('/api/team/:id', requireAdmin, (req, res) => {
  const team = loadTeam();
  const idx  = team.findIndex(m => m.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { name, role, bio } = req.body;
  if (name !== undefined) {
    team[idx].name     = name;
    team[idx].initials = name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }
  if (role !== undefined) team[idx].role = role;
  if (bio  !== undefined) team[idx].bio  = bio;
  saveTeam(team);
  res.json({ success: true, member: team[idx] });
});

const teamPhotoUp = slotUploader(DIRS.team, 'team');
app.post('/api/upload/team/:slot', requireAdmin, teamPhotoUp.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не отримано' });
  res.status(201).json({ success: true, url: `/uploads/team/${req.file.filename}` });
});
app.delete('/api/team-photos/:slot', requireAdmin, (req, res) => {
  clearSlot(DIRS.team, `team-${req.params.slot}`);
  res.json({ success: true });
});

// ── ABOUT & CASE SLOTS ──
mountSlots('about', DIRS.about, /^about-[1-4]\.[a-z]+$/i);
mountSlots('case',  DIRS.cases, /^case-[123]\.[a-z]+$/i);

// ── ADMIN PAGE ──
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.listen(PORT, () => {
  console.log(`\n✅  http://localhost:${PORT}`);
  console.log(`🔑  Адмін: http://localhost:${PORT}/admin`);
  console.log(`🔐  Пароль: ${ADMIN_PASS}  (змінити: ADMIN_PASS=новий_пароль node server.js)\n`);
});
