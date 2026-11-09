const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, OWNER_PASSWORD, SESSION_SECRET } = process.env;
const BUCKET = 'books';
const CATS = { cybersecurity: 'Cyber Security', programming: 'Programming' };
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const files = upload.fields([{ name: 'book', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.disable('powered-by:');

const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(String(v)).digest('hex');
const makeToken = () => { const exp = Date.now() + 7 * 864e5; return `${exp}.${sign(exp)}`; };
const valid = (tok = '') => {
  try {
    const [exp, sig] = tok.split('.');
    return Date.now() < Number(exp) && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(exp)));
  } catch { return false; }
};
const owner = (req, res, next) =>
  valid((req.headers.authorization || '').replace('Bearer ', '')) ? next() : res.status(401).json({ error: 'Owner login required' });

app.post('/api/login', (req, res) => {
  const a = Buffer.from(String(req.body.password || ''));
  const b = Buffer.from(OWNER_PASSWORD || '');
  if (a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b)) return res.json({ token: makeToken() });
  res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/books', async (req, res) => {
  const store = supabase.storage.from(BUCKET);
  const out = [];
  for (const cat of Object.keys(CATS)) {
    const { data, error } = await store.list(cat, { limit: 1000 });
    if (error) return res.status(500).json({ error: error.message });
    const names = new Set(data.map((f) => f.name));
    const url = (n) => store.getPublicUrl(`${cat}/${n}`).data.publicUrl;
    for (const f of data.filter((f) => f.name.endsWith('.pdf'))) {
      const slug = f.name.slice(0, -4);
      out.push({
        path: `${cat}/${f.name}`, category: cat, created: f.created_at, url: url(f.name),
        title: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        cover: names.has(`${slug}.jpg`) ? url(`${slug}.jpg`) : null,
      });
    }
  }
  out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  res.json(out);
});

app.post('/api/books', owner, files, async (req, res) => {
  const book = req.files.book && req.files.book[0];
  const cover = req.files.cover && req.files.cover[0];
  const cat = req.body.category;
  if (!CATS[cat]) return res.status(400).json({ error: 'Choose a category' });
  if (!book || book.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Choose a PDF file' });
  const raw = req.body.title || book.originalname.replace(/\.pdf$/i, '');
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'book';
  const store = supabase.storage.from(BUCKET);
  const up = await store.upload(`${cat}/${slug}.pdf`, book.buffer, { contentType: 'application/pdf', upsert: false });
  if (up.error) return res.status(400).json({ error: up.error.message });
  if (cover) await store.upload(`${cat}/${slug}.jpg`, cover.buffer, { contentType: 'image/jpeg', upsert: true });
  res.json({ ok: true });
});

app.delete('/api/books', owner, async (req, res) => {
  const p = String(req.query.path || '');
  const [cat, file] = p.split('/');
  if (!CATS[cat] || !/^[a-z0-9-]+\.pdf$/.test(file || '')) return res.status(400).json({ error: 'Bad path' });
  const { error } = await supabase.storage.from(BUCKET).remove([p, p.replace(/\.pdf$/, '.jpg')]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

const hits = new Map();
const msgStore = () => supabase.storage.from('messages');
let ready;
const ensureBucket = () => ready || (ready = supabase.storage.createBucket('messages', { public: false }).catch(() => {}));

app.post('/api/messages', async (req, res) => {
  const { name = '', contact = '', message = '', website = '' } = req.body;
  if (website) return res.json({ ok: true });
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < 36e5);
  if (recent.length >= 5) return res.status(429).json({ error: 'Too many messages. Try again later.' });
  if (String(message).trim().length < 3 || String(contact).trim().length < 3) {
    return res.status(400).json({ error: 'Please add your message and how to reach you.' });
  }
  hits.set(req.ip, [...recent, now]);
  await ensureBucket();
  const body = {
    name: String(name).slice(0, 80), contact: String(contact).slice(0, 120),
    message: String(message).slice(0, 2000), at: new Date().toISOString(),
  };
  const { error } = await msgStore().upload(`${now}-${crypto.randomBytes(3).toString('hex')}.json`,
    Buffer.from(JSON.stringify(body)), { contentType: 'application/json' });
  if (error) return res.status(500).json({ error: 'Could not send. Try again.' });
  res.json({ ok: true });
});

app.get('/api/messages', owner, async (req, res) => {
  await ensureBucket();
  const { data, error } = await msgStore().list('', { limit: 200, sortBy: { column: 'name', order: 'desc' } });
  if (error) return res.status(500).json({ error: error.message });
  const out = await Promise.all(data.filter((f) => f.name.endsWith('.json')).map(async (f) => {
    const d = await msgStore().download(f.name);
    return d.error ? null : { id: f.name, ...JSON.parse(await d.data.text()) };
  }));
  res.json(out.filter(Boolean));
});

app.delete('/api/messages/:id', owner, async (req, res) => {
  if (!/^[0-9a-f-]+\.json$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const { error } = await msgStore().remove([req.params.id]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000);
