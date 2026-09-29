const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, '/')));
app.use('/workshop/frames', express.static(path.join(__dirname, 'workshop', 'frames')));

// ---------- PATHS ----------
const USERS_DIR = path.join(__dirname, 'users');
const USERS_FILE = path.join(USERS_DIR, 'users.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const THEMES_DIR = path.join(__dirname, 'themes');
const WORKSHOP_DIR = path.join(__dirname, 'workshop');
const PLUGINS_DIR = path.join(WORKSHOP_DIR, 'plugins');
const UNOFFICIAL_DIR = path.join(WORKSHOP_DIR, 'unofficial');
const UGC_DIR = path.join(WORKSHOP_DIR, 'ugc');
const TALK_DIR = path.join(__dirname, 'talk');
const TALK_FILE = path.join(TALK_DIR, 'posts.json');
const UPLOADS_DIR = path.join(TALK_DIR, 'uploads');
const BOOKS_DIR = path.join(__dirname, 'books');
const FRAMES_DIR = path.join(__dirname, 'workshop', 'frames');
const DEVREQ_FILE = path.join(__dirname, 'devrequests.json');
const ALERTS_FILE = path.join(__dirname, 'alerts.json');
const REQUEST_QUEUE_FILE = path.join(__dirname, 'pubrequests.json');
const RATINGS_FILE = path.join(__dirname, 'ratings.json');
const ACTIVITY_FILE = path.join(__dirname, 'activity.json');
const SESSION_SECRET = crypto.randomBytes(32);
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// ---------- SETUP ----------
function ensureDirs() {
    [USERS_DIR, THEMES_DIR, WORKSHOP_DIR, PLUGINS_DIR, UNOFFICIAL_DIR, UGC_DIR,
     TALK_DIR, UPLOADS_DIR, BOOKS_DIR, FRAMES_DIR].forEach(d => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
    const files = [
        [USERS_FILE, { users: [] }],
        [CONFIG_FILE, { loggedUser: null, theme: 'default', music: false, volume: 0.4 }],
        [TALK_FILE, { posts: [] }],
        [DEVREQ_FILE, { requests: [] }],
        [ALERTS_FILE, { alerts: [] }],
        [REQUEST_QUEUE_FILE, { requests: [] }],
        [RATINGS_FILE, { ratings: {} }],
        [ACTIVITY_FILE, { sessions: {} }]
    ];
    files.forEach(([f, def]) => {
        if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(def, null, 2));
    });
}
ensureDirs();

function readJSON(file, fallback = {}) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ---------- TYPES ----------
const INTERNAL_TYPES = ['owner', 'admin', 'dev', 'teacher'];
const ADMIN_TYPES = ['owner', 'admin'];
function normalizeAccountType(type) {
    const value = String(type || '').trim().toLowerCase();
    if (['professor', 'teatcher', 'teacher'].includes(value)) return 'teacher';
    if (['administrator', 'admin'].includes(value)) return 'admin';
    if (value === 'owner') return 'owner';
    if (value === 'developer') return 'dev';
    return value || 'aluno';
}
function isInternal(t) { return INTERNAL_TYPES.includes(normalizeAccountType(t)); }
function isAdmin(t) { return ADMIN_TYPES.includes(normalizeAccountType(t)); }
function isTeacher(t) { return normalizeAccountType(t) === 'teacher'; }

function createSessionToken(email) {
    const payload = Buffer.from(`${email}\n${Date.now() + SESSION_MAX_AGE}`).toString('base64url');
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function getSessionEmail(req) {
    const cookie = String(req.headers.cookie || '').split(';').map(value => value.trim())
        .find(value => value.startsWith('session='));
    if (!cookie) return null;
    const [payload, signature] = cookie.slice('session='.length).split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const [email, expiresAt] = Buffer.from(payload, 'base64url').toString().split('\n');
    return email && Number(expiresAt) > Date.now() ? email.toLowerCase() : null;
}

function sanitizeRichText(html) {
    const allowedTags = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'p', 'div', 'br', 'ul', 'ol', 'li', 'h2', 'h3']);
    return String(html || '').replace(/<[^>]*>|[^<]+|</g, token => {
        if (!token.startsWith('<')) return token.replace(/&/g, '&amp;').replace(/>/g, '&gt;');
        const match = token.match(/^<\s*(\/?)\s*([a-z0-9]+)[^>]*>$/i);
        if (!match || !allowedTags.has(match[2].toLowerCase())) {
            return token.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        const tag = match[2].toLowerCase();
        return match[1] ? `</${tag}>` : `<${tag}>`;
    });
}

// ---------- PERMISSÕES ----------
function canDeletePost(actorType, actorEmail, post) {
    if (!actorType || !actorEmail || !post || !post.author) return false;
    if (isAdmin(actorType)) return true;
    if (post.author.email === actorEmail) return true;
    if (isTeacher(actorType) && normalizeAccountType(post.author.accountType) === 'aluno') return true;
    return false;
}
function canEditItem(actorType) { return isAdmin(actorType); }

// ---------- "REDE NEURAL" HEURÍSTICA ----------
function analyzeCode(code) {
    const findings = [];
    const patterns = [
        { re: /\beval\s*\(/g, level: 'high', msg: 'Uso de eval() — execução arbitrária' },
        { re: /new\s+Function\s*\(/g, level: 'high', msg: 'new Function() — execução dinâmica' },
        { re: /document\.cookie/g, level: 'high', msg: 'Acesso a cookies' },
        { re: /localStorage|sessionStorage/g, level: 'medium', msg: 'Acesso a storage' },
        { re: /fetch\s*\(\s*['"]https?:\/\//g, level: 'medium', msg: 'Requisição externa' },
        { re: /XMLHttpRequest/g, level: 'medium', msg: 'XHR manual' },
        { re: /WebSocket/g, level: 'medium', msg: 'WebSocket' },
        { re: /navigator\.sendBeacon/g, level: 'medium', msg: 'sendBeacon' },
        { re: /window\.location\s*=/g, level: 'high', msg: 'Redirecionamento' },
        { re: /document\.write/g, level: 'medium', msg: 'document.write' },
        { re: /innerHTML\s*=/g, level: 'low', msg: 'innerHTML (XSS possível)' },
        { re: /process\.env/g, level: 'high', msg: 'Tentativa de ler env' },
        { re: /require\s*\(/g, level: 'high', msg: 'require() no cliente' },
        { re: /child_process|exec\s*\(|spawn/g, level: 'high', msg: 'Comando shell' },
        { re: /fs\.(read|write|unlink)/g, level: 'high', msg: 'Acesso a filesystem' },
        { re: /atob\s*\(|btoa\s*\(/g, level: 'low', msg: 'Ofuscação base64' },
        { re: /\\x[0-9a-f]{2}/gi, level: 'low', msg: 'Bytes escapados (ofuscação)' },
        { re: /setInterval\s*\(\s*[^,]{100,}/g, level: 'low', msg: 'Intervalo com payload grande' }
    ];
    patterns.forEach(p => {
        const m = code.match(p.re);
        if (m) findings.push({ level: p.level, msg: p.msg, count: m.length });
    });

    let score = 0;
    findings.forEach(f => { score += f.level === 'high' ? 30 : f.level === 'medium' ? 12 : 4; });
    score = Math.min(100, score);
    const verdict = score >= 60 ? 'danger' : score >= 25 ? 'warn' : 'safe';
    return { score, verdict, findings };
}

function analyzeZip(zipObj) {
    const allFindings = [];
    let score = 0;
    zipObj.getEntries().forEach(entry => {
        if (entry.isDirectory) return;
        const name = entry.entryName.toLowerCase();
        if (name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.ts')) {
            try {
                const code = entry.getData().toString('utf8');
                const res = analyzeCode(code);
                if (res.findings.length) {
                    allFindings.push({ file: entry.entryName, ...res });
                    score = Math.max(score, res.score);
                }
            } catch (e) {}
        }
        if (name.endsWith('.exe') || name.endsWith('.bat') || name.endsWith('.sh') || name.endsWith('.cmd')) {
            allFindings.push({ file: entry.entryName, score: 90, verdict: 'danger',
                findings: [{ level: 'high', msg: 'Executável/binário suspeito', count: 1 }] });
            score = Math.max(score, 90);
        }
    });
    const verdict = score >= 60 ? 'danger' : score >= 25 ? 'warn' : 'safe';
    return { score, verdict, findings: allFindings };
}

// ---------- LIVROS ----------
app.get('/api/books', (req, res) => {
    const booksDir = path.join(__dirname, 'books');
    const data = {};
    if (!fs.existsSync(booksDir)) return res.json(data);

    const categories = fs.readdirSync(booksDir, { withFileTypes: true }).filter(d => d.isDirectory());

    categories.forEach(category => {
        const catName = category.name;
        data[catName] = [];
        const catPath = path.join(booksDir, catName);
        const books = fs.readdirSync(catPath, { withFileTypes: true }).filter(d => d.isDirectory());

        books.forEach(book => {
            const bookPath = path.join(catPath, book.name);
            const files = fs.readdirSync(bookPath);
            let manifest = {};
            if (files.includes('manifest.json')) {
                manifest = { ...manifest, ...readJSON(path.join(bookPath, 'manifest.json'), {}) };
            }
            const coverFile = files.find(f => f.match(/^cover\.(png|jpe?g|webp)$/i));
            const pdfFile = files.find(f => f.toLowerCase().endsWith('.pdf'));

            data[catName].push({
                folder: book.name,
                nome: manifest.Nome || manifest.title || manifest.name,
                autor: manifest.Autor || manifest.author,
                coinsPerMinute: manifest.coinsPerMinute ?? 1,
                coverUrl: coverFile ? `/books/${catName}/${book.name}/${coverFile}` : null,
                pdfUrl: pdfFile ? `/books/${catName}/${book.name}/${pdfFile}` : null
            });
        });
    });
    res.json(data);
});

// ---------- CONFIG ----------
app.get('/api/config', (req, res) => res.json(readJSON(CONFIG_FILE)));
app.post('/api/config', (req, res) => {
    const c = readJSON(CONFIG_FILE);
    writeJSON(CONFIG_FILE, { ...c, ...req.body });
    res.json(readJSON(CONFIG_FILE));
});

function safeUser(u) {
    if (!u) return null;
    if (typeof u.coins !== 'number' || isNaN(u.coins)) u.coins = Number(u.coins) || 0;
    if (!Array.isArray(u.ownedThemes)) u.ownedThemes = ['default'];
    return {
        name: u.name || 'Sem nome', email: u.email,
        photo: u.photo || null, coins: u.coins,
        ownedThemes: u.ownedThemes,
        equippedFrame: u.equippedFrame || null,
        accountType: normalizeAccountType(u.accountType),
        devRequested: !!u.devRequested,
        isDev: isInternal(u.accountType),
        isAdmin: isAdmin(u.accountType),
        isOwner: normalizeAccountType(u.accountType) === 'owner'
    };
}

app.post('/api/login', (req, res) => {
    const { name, email, password, photo } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos.' });
    const db = readJSON(USERS_FILE, { users: [] });
    let user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());

    if (user) {
        if (user.password !== password) return res.status(401).json({ error: 'Senha incorreta.' });
        if (typeof user.coins !== 'number' || isNaN(user.coins)) user.coins = 100;
        if (!Array.isArray(user.ownedThemes)) user.ownedThemes = ['default'];
        user.accountType = normalizeAccountType(user.accountType);
    } else {
        user = { name, email, password, photo: photo || null, coins: 100,
                 ownedThemes: ['default'], accountType: 'aluno', devRequested: false };
        db.users.push(user);
    }
    writeJSON(USERS_FILE, db);
    const cfg = readJSON(CONFIG_FILE);
    cfg.loggedUser = safeUser(user);
    writeJSON(CONFIG_FILE, cfg);
    res.setHeader('Set-Cookie', `session=${createSessionToken(user.email)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE / 1000}`);
    res.json({ success: true, user: safeUser(user) });
});

app.post('/api/logout', (req, res) => {
    const c = readJSON(CONFIG_FILE); c.loggedUser = null;
    writeJSON(CONFIG_FILE, c);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ success: true });
});

// ---------- DEV REQUEST ----------
app.post('/api/dev-request', (req, res) => {
    const { email, message } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (isInternal(user.accountType)) return res.json({ success: true, alreadyDev: true });

    const reqs = readJSON(DEVREQ_FILE, { requests: [] });
    if (reqs.requests.find(r => r.email === email && r.status === 'pending'))
        return res.json({ success: true, alreadyRequested: true });

    reqs.requests.push({ email, name: user.name, message: message || '',
                         status: 'pending', date: new Date().toISOString() });
    writeJSON(DEVREQ_FILE, reqs);
    user.devRequested = true;
    writeJSON(USERS_FILE, db);
    res.json({ success: true, requested: true });
});

app.post('/api/dev-approve', (req, res) => {
    const { approverEmail, targetEmail, accountType } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const a = db.users.find(u => u.email === approverEmail);
    if (!a || !isAdmin(a.accountType)) return res.status(403).json({ error: 'Sem permissão.' });
    const t = db.users.find(u => u.email === targetEmail);
    if (!t) return res.status(404).json({ error: 'Alvo não encontrado.' });
    t.accountType = accountType || 'dev';
    const reqs = readJSON(DEVREQ_FILE, { requests: [] });
    const r = reqs.requests.find(x => x.email === targetEmail && x.status === 'pending');
    if (r) r.status = 'approved';
    writeJSON(DEVREQ_FILE, reqs); writeJSON(USERS_FILE, db);
    res.json({ success: true, user: safeUser(t) });
});

// ---------- MOEDAS ----------
app.post('/api/earn-coins', (req, res) => {
    const { email, amount } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (typeof user.coins !== 'number' || isNaN(user.coins)) user.coins = 0;
    const inc = Math.max(0, Math.floor(Number(amount) || 0));
    user.coins += inc;
    writeJSON(USERS_FILE, db);
    const cfg = readJSON(CONFIG_FILE);
    if (cfg.loggedUser && cfg.loggedUser.email === email) {
        cfg.loggedUser = safeUser(user); writeJSON(CONFIG_FILE, cfg);
    }
    res.json({ success: true, user: safeUser(user) });
});

app.post('/api/admin/give-coins', (req, res) => {
    const ownerEmail = getSessionEmail(req);
    const targetEmail = String(req.body.targetEmail || '').trim().toLowerCase();
    const amount = Number(req.body.amount);
    const title = String(req.body.title || '').trim().slice(0, 120);
    const html = sanitizeRichText(req.body.html);
    const plainText = html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt);/g, ' ').trim();
    if (!Number.isSafeInteger(amount) || amount <= 0)
        return res.status(400).json({ error: 'Informe uma quantidade inteira positiva.' });
    if (!targetEmail || !title || !plainText)
        return res.status(400).json({ error: 'Informe o destinatário, o título e a mensagem do popup.' });

    const db = readJSON(USERS_FILE, { users: [] });
    const owner = db.users.find(user => String(user.email || '').toLowerCase() === ownerEmail);
    if (!owner || normalizeAccountType(owner.accountType) !== 'owner')
        return res.status(403).json({ error: 'Somente o dono pode conceder moedas grátis.' });
    const recipient = db.users.find(user => String(user.email || '').toLowerCase() === targetEmail);
    if (!recipient) return res.status(404).json({ error: 'Destinatário não encontrado.' });
    if (!Number.isSafeInteger((Number(recipient.coins) || 0) + amount))
        return res.status(400).json({ error: 'A quantidade excede o limite permitido.' });

    recipient.coins = (Number(recipient.coins) || 0) + amount;
    writeJSON(USERS_FILE, db);

    const alerts = readJSON(ALERTS_FILE, { alerts: [] });
    const popup = {
        id: 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type: 'popup',
        target: recipient.email,
        title,
        html,
        date: new Date().toISOString(),
        expires: null
    };
    alerts.alerts.push(popup);
    writeJSON(ALERTS_FILE, alerts);

    const config = readJSON(CONFIG_FILE);
    if (config.loggedUser && String(config.loggedUser.email || '').toLowerCase() === targetEmail) {
        config.loggedUser = safeUser(recipient);
        writeJSON(CONFIG_FILE, config);
    }
    res.json({ success: true, user: safeUser(recipient), alert: popup });
});

// ---------- WORKSHOP ----------
function scanThemeDir(baseDir, type) {
    const out = [];
    if (!fs.existsSync(baseDir)) return out;
    const ratings = readJSON(RATINGS_FILE, { ratings: {} }).ratings || {};

    fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .forEach(d => {
            const themeDir = path.join(baseDir, d.name);
            const manifestPath = path.join(themeDir, 'manifest.json');
            if (!fs.existsSync(manifestPath)) return;
            const manifest = readJSON(manifestPath, {});
            const files = fs.readdirSync(themeDir);
            const cover = files.find(f => f.match(/^cover\.(png|jpe?g|webp)$/i));
            const id = manifest.id || d.name;

            const r = ratings[id] || { sum: 0, count: 0 };
            const avg = r.count ? (r.sum / r.count) : 0;

            // frameUrl para UGC com moldura
            let frameUrl = null;
            if (type === 'ugc' && manifest.frameImage) {
                frameUrl = `/workshop/ugc/${d.name}/${manifest.frameImage}`;
            }

            out.push({
                id, name: manifest.name || d.name,
                description: manifest.description || '',
                author: manifest.author || 'Desconhecido',
                price: manifest.price || 0, type, folder: d.name,
                coverUrl: cover ? `/${type === 'theme' ? 'themes' : `workshop/${type === 'plugin' ? 'plugins' : type === 'ugc' ? 'ugc' : 'unofficial'}`}/${d.name}/${cover}` : null,
                entry: manifest.entry || null,
                ugcModules: manifest.ugcModules || null,
                frameUrl,
                rating: { avg: +avg.toFixed(2), count: r.count || 0 }
            });
        });
    return out;
}
app.get('/api/user/:email', (req, res) => {
    const db = readJSON(USERS_FILE, { users: [] });
    const email = String(req.params.email || '').toLowerCase();
    const u = db.users.find(x => String(x.email || '').toLowerCase() === email);
    if (!u) return res.status(404).json({ error: 'Não encontrado.' });
    res.json(safeUser(u));
});

app.get('/api/themes', (req, res) => {
    res.json([
        ...scanThemeDir(THEMES_DIR, 'theme'),
        ...scanThemeDir(PLUGINS_DIR, 'plugin'),
        ...scanThemeDir(UGC_DIR, 'ugc'),
        ...scanThemeDir(UNOFFICIAL_DIR, 'unofficial')
    ]);
});
// Equipar/desequipar moldura
app.post('/api/equip-frame', (req, res) => {
    const { email, frameId } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    if (frameId && !user.ownedThemes.includes(frameId)) {
        return res.status(403).json({ error: 'Você não possui esta moldura.' });
    }
    user.equippedFrame = frameId || null;
    writeJSON(USERS_FILE, db);

    const cfg = readJSON(CONFIG_FILE);
    if (cfg.loggedUser && cfg.loggedUser.email === email) {
        cfg.loggedUser = safeUser(user);
        writeJSON(CONFIG_FILE, cfg);
    }
    res.json({ success: true, user: safeUser(user) });
});
// ---------- RATINGS ----------
app.post('/api/rate-item', (req, res) => {
    const { email, itemId, stars } = req.body;
    if (!email || !itemId || !stars || stars < 1 || stars > 5)
        return res.status(400).json({ error: 'Dados inválidos.' });

    const data = readJSON(RATINGS_FILE, { ratings: {} });
    if (!data.ratings[itemId]) data.ratings[itemId] = { sum: 0, count: 0, byUser: {} };
    const r = data.ratings[itemId];
    r.byUser = r.byUser || {};

    const prev = r.byUser[email];
    if (prev) { r.sum -= prev; r.count -= 1; }
    r.byUser[email] = stars;
    r.sum += stars; r.count += 1;
    writeJSON(RATINGS_FILE, data);

    res.json({ success: true, avg: +(r.sum / r.count).toFixed(2), count: r.count, your: stars });
});

// ---------- PUBLISH REQUEST QUEUE ----------
app.post('/api/request-publish', (req, res) => {
    const { email, item, zip } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const q = readJSON(REQUEST_QUEUE_FILE, { requests: [] });
    const entry = {
        id: 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        author: { name: user.name, email: user.email, photo: user.photo, accountType: user.accountType },
        item: item || null,
        zip: zip || null,
        analysis: null,
        status: 'pending',
        date: new Date().toISOString()
    };

    if (zip && zip.dataUrl) {
        try {
            const match = zip.dataUrl.match(/^data:(.+?);base64,(.+)$/);
            const z = new AdmZip(Buffer.from(match[2], 'base64'));
            entry.analysis = analyzeZip(z);
        } catch (e) { entry.analysis = { score: 0, verdict: 'unknown', findings: [] }; }
    } else if (item && item.code) {
        entry.analysis = analyzeCode(item.code);
    }

    q.requests.push(entry);
    writeJSON(REQUEST_QUEUE_FILE, q);
    res.json({ success: true, request: entry });
});

app.get('/api/pubrequests', (req, res) => {
    const { email } = req.query;
    const db = readJSON(USERS_FILE, { users: [] });
    const u = db.users.find(x => x.email === email);
    if (!u || !isAdmin(u.accountType)) return res.status(403).json({ error: 'Sem permissão.' });
    const q = readJSON(REQUEST_QUEUE_FILE, { requests: [] });
    res.json(q.requests.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

// Aprovar → efetivamente instala o item
app.post('/api/pubrequests/:id/approve', (req, res) => {
    const { email } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const u = db.users.find(x => x.email === email);
    if (!u || !isAdmin(u.accountType)) return res.status(403).json({ error: 'Sem permissão.' });

    const q = readJSON(REQUEST_QUEUE_FILE, { requests: [] });
    const r = q.requests.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: 'Solicitação não encontrada.' });

    installItemFromRequest(r).then(() => {
        r.status = 'approved';
        writeJSON(REQUEST_QUEUE_FILE, q);
        res.json({ success: true });
    }).catch(err => res.status(400).json({ error: err.message }));
});

app.post('/api/pubrequests/:id/reject', (req, res) => {
    const { email, reason } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const u = db.users.find(x => x.email === email);
    if (!u || !isAdmin(u.accountType)) return res.status(403).json({ error: 'Sem permissão.' });
    const q = readJSON(REQUEST_QUEUE_FILE, { requests: [] });
    const r = q.requests.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: 'Não encontrada.' });
    r.status = 'rejected';
    r.reason = reason || '';
    writeJSON(REQUEST_QUEUE_FILE, q);
    res.json({ success: true });
});

async function installItemFromRequest(r) {
    const { zip, item } = r;

    if (zip && zip.dataUrl) {
        const match = zip.dataUrl.match(/^data:(.+?);base64,(.+)$/);
        if (!match) throw new Error('ZIP inválido.');
        const z = new AdmZip(Buffer.from(match[2], 'base64'));
        const manifestEntry = z.getEntry('manifest.json');
        if (!manifestEntry) throw new Error('ZIP precisa de manifest.json na raiz.');
        let manifest;
        try { manifest = JSON.parse(manifestEntry.getData().toString('utf8')); }
        catch (e) { throw new Error('manifest.json inválido.'); }

        const type = manifest.type || 'plugin';
        const id = manifest.id || ('item_' + Date.now());
        let baseDir = type === 'theme' ? THEMES_DIR
                    : type === 'plugin' ? PLUGINS_DIR
                    : type === 'ugc' ? UGC_DIR
                    : UNOFFICIAL_DIR;
        const dir = path.join(baseDir, id);
        if (fs.existsSync(dir)) throw new Error('Já existe item com esse ID.');

        fs.mkdirSync(dir, { recursive: true });
        z.getEntries().forEach(e => {
            if (e.isDirectory) return;
            const n = e.entryName.replace(/\\/g, '/');
            if (n.includes('..')) return;
            const dest = path.join(dir, n);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, e.getData());
        });
        const fm = { ...manifest, id, type,
            author: manifest.author || r.author.name,
            price: type === 'theme' ? 0 : (manifest.price ?? 50),
            version: manifest.version || '1.0.0' };
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(fm, null, 2));
        return;
    }

if (item) {
    const { id, name, description, type, price, code, ugcModules, frameImage } = item;
    if (!id || !name) throw new Error('ID e nome obrigatórios.');
    let baseDir = type === 'theme' ? THEMES_DIR
                : type === 'plugin' ? PLUGINS_DIR
                : type === 'ugc' ? UGC_DIR
                : UNOFFICIAL_DIR;
    const dir = path.join(baseDir, id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const manifest = { id, name, description: description || '',
        author: r.author.name,
        price: type === 'theme' ? 0 : (price || 50),
        type, version: '1.0.0' };
    if (type === 'plugin' && code) {
        fs.writeFileSync(path.join(dir, 'plugin.js'), code);
        manifest.entry = 'plugin.js';
    }
    if (type === 'ugc' && Array.isArray(ugcModules)) {
        manifest.ugcModules = ugcModules;
    }
    // Salvar imagem da moldura
    if (type === 'ugc' && Array.isArray(ugcModules) && ugcModules.includes('profile-frame') && frameImage && frameImage.dataUrl) {
        const m = frameImage.dataUrl.match(/^data:(.+?);base64,(.+)$/);
        if (m) {
            const ext = (frameImage.name || 'frame.png').split('.').pop().toLowerCase();
            const safeExt = ['png','jpg','jpeg','webp','gif','svg'].includes(ext) ? ext : 'png';
            const filename = `frame.${safeExt}`;
            const subdir = path.join(dir, 'frames');
            if (!fs.existsSync(subdir)) fs.mkdirSync(subdir, { recursive: true });
            fs.writeFileSync(path.join(subdir, filename), Buffer.from(m[2], 'base64'));
            manifest.frameImage = `frames/${filename}`;
            manifest.frameThumb = `frames/${filename}`;
        }
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
}

// PUBLISH direto (dev/admin/owner) — sem fila
app.post('/api/publish-item', async (req, res) => {
    const { email, item, zip } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (!isInternal(user.accountType))
        return res.status(403).json({ error: 'Somente dev/admin/owner podem publicar direto.' });

    try {
        await installItemFromRequest({ author: { name: user.name }, item, zip });
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// ADMIN: editar item (manifest)
app.post('/api/admin/edit-item', (req, res) => {
    const { email, type, id, manifest } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const u = db.users.find(x => x.email === email);
    if (!u || !isAdmin(u.accountType)) return res.status(403).json({ error: 'Sem permissão.' });

    let baseDir = type === 'theme' ? THEMES_DIR
                : type === 'plugin' ? PLUGINS_DIR
                : type === 'ugc' ? UGC_DIR
                : UNOFFICIAL_DIR;
    const mPath = path.join(baseDir, id, 'manifest.json');
    if (!fs.existsSync(mPath)) return res.status(404).json({ error: 'Item não encontrado.' });

    const current = readJSON(mPath, {});
    writeJSON(mPath, { ...current, ...manifest, id });
    res.json({ success: true });
});

// ADMIN: apagar item inteiro
app.delete('/api/admin/delete-item', (req, res) => {
    const { email, type, id } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const u = db.users.find(x => x.email === email);
    if (!u || !isAdmin(u.accountType)) return res.status(403).json({ error: 'Sem permissão.' });

    let baseDir = type === 'theme' ? THEMES_DIR
                : type === 'plugin' ? PLUGINS_DIR
                : type === 'ugc' ? UGC_DIR
                : UNOFFICIAL_DIR;
    const dir = path.join(baseDir, id);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Não existe.' });
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ success: true });
});

// ---------- COMPRAR ----------
app.post('/api/buy-theme', (req, res) => {
    const { email, themeId } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (typeof user.coins !== 'number' || isNaN(user.coins)) user.coins = 0;

    const all = [
        ...scanThemeDir(THEMES_DIR, 'theme'),
        ...scanThemeDir(PLUGINS_DIR, 'plugin'),
        ...scanThemeDir(UGC_DIR, 'ugc'),
        ...scanThemeDir(UNOFFICIAL_DIR, 'unofficial')
    ];
    const theme = all.find(t => t.id === themeId);
    if (!theme) return res.status(404).json({ error: 'Item não encontrado.' });
    if (user.ownedThemes.includes(themeId)) return res.json({ success: true, user: safeUser(user) });
    if (user.coins < theme.price) return res.status(400).json({ error: 'Moedas insuficientes.' });

    user.coins -= theme.price;
    user.ownedThemes.push(themeId);
    writeJSON(USERS_FILE, db);
    const cfg = readJSON(CONFIG_FILE);
    if (cfg.loggedUser && cfg.loggedUser.email === email) {
        cfg.loggedUser = safeUser(user); writeJSON(CONFIG_FILE, cfg);
    }
    res.json({ success: true, user: safeUser(user) });
});

// ---------- TALK ----------
app.get('/api/posts', (req, res) => {
    const data = readJSON(TALK_FILE, { posts: [] });
    res.json(data.posts.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.post('/api/posts', (req, res) => {
    const { email, html, media } = req.body;
    if (!email || !html) return res.status(400).json({ error: 'Conteúdo vazio.' });
    const db = readJSON(USERS_FILE, { users: [] });
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const data = readJSON(TALK_FILE, { posts: [] });
    data.posts.push({
        id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        author: {
    name: user.name,
    email: user.email,
    photo: user.photo,
    equippedFrame: user.equippedFrame || null,
    accountType: user.accountType || 'aluno'
},
        html, media: Array.isArray(media) ? media : [],
        likes: 0, likedBy: [], comments: [], date: new Date().toISOString()
    });
    writeJSON(TALK_FILE, data);
    res.json({ success: true });
});

app.post('/api/posts/:id/like', (req, res) => {
    const { email } = req.body;
    const data = readJSON(TALK_FILE, { posts: [] });
    const post = data.posts.find(p => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: 'Post não encontrado.' });
    post.likedBy = post.likedBy || [];
    if (post.likedBy.includes(email)) { post.likedBy = post.likedBy.filter(e => e !== email); post.likes = Math.max(0, post.likes - 1); }
    else { post.likedBy.push(email); post.likes = (post.likes || 0) + 1; }
    writeJSON(TALK_FILE, data);
    res.json({ success: true, likes: post.likes });
});

app.delete('/api/posts/:id', (req, res) => {
    const { email } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const actor = db.users.find(u => u.email === email);
    if (!actor) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const data = readJSON(TALK_FILE, { posts: [] });
    const idx = data.posts.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Post não encontrado.' });
    const post = data.posts[idx];
    if (!canDeletePost(actor.accountType, actor.email, post))
        return res.status(403).json({ error: 'Sem permissão.' });
    data.posts.splice(idx, 1);
    writeJSON(TALK_FILE, data);
    res.json({ success: true });
});

// ---------- COMMENTS ----------
app.post('/api/posts/:id/comments', (req, res) => {
    const { email, html } = req.body;
    if (!email || !html || !html.trim()) return res.status(400).json({ error: 'Comentário vazio.' });
    const db = readJSON(USERS_FILE, { users: [] });
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const data = readJSON(TALK_FILE, { posts: [] });
    const post = data.posts.find(p => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: 'Post não encontrado.' });

    post.comments = post.comments || [];
    post.comments.push({
        id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        author: {
    name: user.name,
    email: user.email,
    photo: user.photo,
    equippedFrame: user.equippedFrame || null,
    accountType: user.accountType || 'aluno'
},
        html, date: new Date().toISOString()
    });
    writeJSON(TALK_FILE, data);
    res.json({ success: true });
});

app.delete('/api/posts/:postId/comments/:commentId', (req, res) => {
    const { email } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const actor = db.users.find(u => u.email === email);
    if (!actor) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const data = readJSON(TALK_FILE, { posts: [] });
    const post = data.posts.find(p => p.id === req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post não encontrado.' });
    const idx = (post.comments || []).findIndex(c => c.id === req.params.commentId);
    if (idx === -1) return res.status(404).json({ error: 'Comentário não encontrado.' });
    if (!canDeletePost(actor.accountType, actor.email, post.comments[idx]))
        return res.status(403).json({ error: 'Sem permissão.' });
    post.comments.splice(idx, 1);
    writeJSON(TALK_FILE, data);
    res.json({ success: true });
});

// ---------- UPLOAD ----------
function slugifyBookName(value) {
    return String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 80) || 'livro';
}

app.post('/api/books/upload', (req, res) => {
    const { email, category, name, author, coinsPerMinute, cover, pdf } = req.body;
    if (!email || !name || !author || !cover || !pdf) {
        return res.status(400).json({ error: 'Preencha capa, PDF, nome e autor.' });
    }

    const db = readJSON(USERS_FILE, { users: [] });
    const user = db.users.find(u => u.email === email);
    if (!user || (!isTeacher(user.accountType) && !isAdmin(user.accountType))) {
        return res.status(403).json({ error: 'Sem permissão para adicionar livros.' });
    }

    const safeCategory = String(category || 'Geral').replace(/[<>:"/\\|?*]/g, '').trim() || 'Geral';
    const safeName = String(name).trim();
    const safeAuthor = String(author).trim();
    const value = Number(coinsPerMinute) || 2;

    const baseDir = path.join(BOOKS_DIR, safeCategory);
    fs.mkdirSync(baseDir, { recursive: true });

    const slug = slugifyBookName(safeName);
    const bookDir = path.join(baseDir, slug);
    if (fs.existsSync(bookDir)) {
        return res.status(409).json({ error: 'Já existe um livro com esse nome nesta categoria.' });
    }
    fs.mkdirSync(bookDir, { recursive: true });

    const coverMatch = String(cover.dataUrl || '').match(/^data:(image\/(png|jpeg|jpg|webp|gif|svg\+xml));base64,(.+)$/i);
    const pdfMatch = String(pdf.dataUrl || '').match(/^data:(application\/pdf);base64,(.+)$/i);
    if (!coverMatch || !pdfMatch) {
        fs.rmSync(bookDir, { recursive: true, force: true });
        return res.status(400).json({ error: 'Capa deve ser uma imagem e PDF deve ser válido.' });
    }

    const coverExt = (cover.name || 'cover.png').split('.').pop().toLowerCase();
    const coverSafeExt = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(coverExt) ? coverExt : 'png';
    const pdfExt = (pdf.name || 'book.pdf').split('.').pop().toLowerCase() === 'pdf' ? 'pdf' : 'pdf';

    fs.writeFileSync(path.join(bookDir, `cover.${coverSafeExt}`), Buffer.from(coverMatch[3], 'base64'));
    fs.writeFileSync(path.join(bookDir, `book.${pdfExt}`), Buffer.from(pdfMatch[2], 'base64'));

    const manifest = {
        name: safeName,
        author: safeAuthor,
        coinsPerMinute: value
    };
    fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    res.json({ success: true, category: safeCategory, folder: slug, book: manifest });
});

app.post('/api/upload', (req, res) => {
    const { filename, dataUrl } = req.body;
    if (!filename || !dataUrl) return res.status(400).json({ error: 'Dados inválidos.' });
    const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Formato inválido.' });
    const ext = path.extname(filename) || '';
    const safeName = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + ext;
    fs.writeFileSync(path.join(UPLOADS_DIR, safeName), Buffer.from(match[2], 'base64'));
    res.json({ success: true, url: `/talk/uploads/${safeName}` });
});

// ---------- ALERTS ----------
app.get('/api/alerts', (req, res) => {
    const { email } = req.query;
    const data = readJSON(ALERTS_FILE, { alerts: [] });
    const now = Date.now();
    const visible = data.alerts.filter(a => {
        if (a.expires && new Date(a.expires).getTime() < now) return false;
        if (!a.target || a.target === 'global') return true;
        if (Array.isArray(a.target)) return a.target.includes(email);
        return a.target === email;
    });
    res.json(visible);
});

app.post('/api/alerts', (req, res) => {
    const { email, alert } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const u = db.users.find(x => x.email === email);
    if (!u || !isAdmin(u.accountType)) return res.status(403).json({ error: 'Sem permissão.' });

    const data = readJSON(ALERTS_FILE, { alerts: [] });
    const entry = {
        id: 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type: alert.type || 'toast', // 'toast' | 'popup'
        target: alert.target || 'global',
        title: alert.title || '',
        html: alert.html || '',
        date: new Date().toISOString(),
        expires: alert.expires || null
    };
    data.alerts.push(entry);
    writeJSON(ALERTS_FILE, data);
    res.json({ success: true, alert: entry });
});

app.get('/api/alerts/all', (req, res) => {
    const { email } = req.query;
    const db = readJSON(USERS_FILE, { users: [] });
    const u = db.users.find(x => x.email === email);
    if (!u || !isAdmin(u.accountType)) return res.status(403).json({ error: 'Sem permissão.' });
    res.json(readJSON(ALERTS_FILE, { alerts: [] }).alerts);
});

app.delete('/api/alerts/:id', (req, res) => {
    const { email } = req.body;
    const db = readJSON(USERS_FILE, { users: [] });
    const u = db.users.find(x => x.email === email);
    if (!u || !isAdmin(u.accountType)) return res.status(403).json({ error: 'Sem permissão.' });
    const data = readJSON(ALERTS_FILE, { alerts: [] });
    data.alerts = data.alerts.filter(a => a.id !== req.params.id);
    writeJSON(ALERTS_FILE, data);
    res.json({ success: true });
});

// ---------- TEACHER: ACTIVITY ----------
app.post('/api/activity', (req, res) => {
    const { email, event, bookFolder, seconds } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

    const db = readJSON(ACTIVITY_FILE, { sessions: {} });
    const now = new Date().toISOString();
    if (!db.sessions[email]) db.sessions[email] = { events: [], totals: {}, lastSeen: now };
    const s = db.sessions[email];

    s.events.push({ event, bookFolder: bookFolder || null, seconds: seconds || 0, date: now });
    if (s.events.length > 500) s.events = s.events.slice(-500);
    s.lastSeen = now;

    if (bookFolder && event === 'read-time') {
        s.totals[bookFolder] = (s.totals[bookFolder] || 0) + (seconds || 0);
    }
    writeJSON(ACTIVITY_FILE, db);
    res.json({ success: true });
});

app.get('/api/activity/all', (req, res) => {
    const { email } = req.query;
    const db = readJSON(USERS_FILE, { users: [] });
    const u = db.users.find(x => x.email === email);
    if (!u || (!isTeacher(u.accountType) && !isAdmin(u.accountType)))
        return res.status(403).json({ error: 'Sem permissão.' });

    const data = readJSON(ACTIVITY_FILE, { sessions: {} });
    const usersDb = readJSON(USERS_FILE, { users: [] });

    const students = usersDb.users
        .filter(x => x.accountType === 'aluno')
        .map(x => {
            const s = data.sessions[x.email] || { events: [], totals: {}, lastSeen: null };
            const lastEvents = s.events.slice(-20);
            return {
                name: x.name, email: x.email, photo: x.photo,
                coins: x.coins,
                totals: s.totals, lastSeen: s.lastSeen,
                lastEvents
            };
        });
    res.json(students);
});

// ---------- FALLBACK ----------
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));