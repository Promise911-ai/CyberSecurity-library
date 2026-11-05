const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, OWNER_PASSWORD, SESSION_SECRET } = process.env;
const BUCKET = 'books';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const { data, error } = await supabase.storage.from(BUCKET).list('', {
    limit: 1000, sortBy: { column: 'created_at', order: 'desc' },
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.filter((f) => f.name.endsWith('.pdf')).map((f) => ({
    name: f.name,
    title: f.name.replace(/\.pdf$/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    url: supabase.storage.from(BUCKET).getPublicUrl(f.name).data.publicUrl,
  })));
});

app.post('/api/books', owner, upload.single('book'), async (req, res) => {
  if (!req.file || req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Choose a PDF file' });
  const raw = req.body.title || req.file.originalname.replace(/\.pdf$/i, '');
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'book';
  const { error } = await supabase.storage.from(BUCKET).upload(`${slug}.pdf`, req.file.buffer, {
    contentType: 'application/pdf', upsert: false,
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/books/:name', owner, async (req, res) => {
  const { error } = await supabase.storage.from(BUCKET).remove([req.params.name]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000);
