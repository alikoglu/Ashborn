// Ashborn Studios Content Lab — API server (Express + PostgreSQL)
// Replaces the Cloudflare Worker (index_v2.js). Same routes, same response shapes.
//
// Env vars:
//   DATABASE_URL       (auto-injected by Railway when Postgres is linked)
//   ANTHROPIC_API_KEY  (required for /ai and /analyze-intro)
//   AI_MODEL           (optional, default 'claude-sonnet-4-6')
//   ADMIN_PASSWORD     (optional, first-boot admin password; default ashborn2025)
//   PORT               (auto-injected by Railway; default 3000)

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const { q, one, migrate, seed } = require('./db');
const { startCron, runStatsRefresh, runChannelMonitor } = require('./cron');


const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy
app.use(express.json({ limit: '10mb' })); // AI chat can include base64 thumbnails

const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

// ── Helpers (same semantics as the Worker) ────────────────────
const bool = v => (v === true || v === 1 || v === 'true' || v === 'yes') ? 1 : 0;
const str = v => v == null ? '' : String(v);
const genToken = () => crypto.randomBytes(32).toString('hex');
const genId = () => crypto.randomBytes(5).toString('hex').slice(0, 8);
const sendErr = (res, m, s = 400) => res.status(s).json({ error: m });

// ── CORS (wildcard, bearer-token auth — same as the Worker) ───
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── Session middleware ────────────────────────────────────────
app.use(async (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  req.session = null;
  if (token) {
    try {
      req.session = await one(
        `SELECT s.token, u.id AS uid, u.username, u.role, u.daily_ai_limit
         FROM sessions s JOIN users u ON s.user_id = u.id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );
    } catch (e) {
      console.error('session lookup failed:', e.message);
      return sendErr(res, 'Database error', 500);
    }
  }
  next();
});

function requireAuth(req, res) {
  if (!req.session) { sendErr(res, 'Unauthorized', 401); return false; }
  return true;
}
function requireRole(req, res, role) {
  const roles = ['viewer', 'editor', 'admin'];
  if (roles.indexOf(req.session.role) < roles.indexOf(role)) { sendErr(res, 'Forbidden', 403); return false; }
  return true;
}

// ── Login rate limiting (per-IP, in-memory) ───────────────────
const loginAttempts = new Map(); // ip -> {count, resetAt}
function loginLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) { loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 }); return false; }
  rec.count++;
  return rec.count > 8;
}
setInterval(() => { // prune stale entries hourly
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) if (now > rec.resetAt) loginAttempts.delete(ip);
}, 60 * 60 * 1000).unref();

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════

app.post('/auth/login', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  if (loginLimited(ip)) return sendErr(res, 'Too many login attempts — try again in 15 minutes', 429);
  const { username, password } = req.body || {};
  if (!username || !password) return sendErr(res, 'Username and password required');
  const user = await one('SELECT * FROM users WHERE username = $1', [username.trim().toLowerCase()]);
  if (!user) return sendErr(res, 'Invalid username or password', 401);
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return sendErr(res, 'Invalid username or password', 401);
  loginAttempts.delete(ip);
  const token = genToken();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await q('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)', [token, user.id, expires]);
  const workspaces = await q(
    `SELECT w.*, wm.permission,
       (SELECT COUNT(*)::int FROM video_workspaces vw WHERE vw.workspace_id = w.id) AS video_count
     FROM workspaces w JOIN workspace_members wm ON w.id = wm.workspace_id
     WHERE wm.user_id = $1 ORDER BY w.is_master DESC, w.name ASC`,
    [user.id]
  );
  res.json({ token, expires, user: { id: user.id, username: user.username, role: user.role, daily_ai_limit: user.daily_ai_limit }, workspaces });
});

app.post('/auth/logout', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token) await q('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ success: true });
});

app.get('/auth/me', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const s = req.session;
  const workspaces = await q(
    `SELECT w.*, wm.permission,
       (SELECT COUNT(*)::int FROM video_workspaces vw WHERE vw.workspace_id = w.id) AS video_count
     FROM workspaces w JOIN workspace_members wm ON w.id = wm.workspace_id
     WHERE wm.user_id = $1 ORDER BY w.is_master DESC, w.name ASC`,
    [s.uid]
  );
  res.json({ user: { id: s.uid, username: s.username, role: s.role, daily_ai_limit: s.daily_ai_limit }, workspaces });
});

// New: change your own password (logs out all other sessions)
app.post('/auth/change-password', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return sendErr(res, 'current_password and new_password required');
  if (String(new_password).length < 8) return sendErr(res, 'New password must be at least 8 characters');
  const user = await one('SELECT * FROM users WHERE id = $1', [req.session.uid]);
  const ok = await bcrypt.compare(current_password, user.password_hash);
  if (!ok) return sendErr(res, 'Current password is incorrect', 401);
  const hash = await bcrypt.hash(new_password, 10);
  await q('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.session.uid]);
  await q('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [req.session.uid, req.session.token]);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
// WORKSPACES
// ══════════════════════════════════════════════════════════════

app.get('/workspaces', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const workspaces = await q(
    `SELECT w.*, wm.permission,
       (SELECT COUNT(*)::int FROM video_workspaces vw WHERE vw.workspace_id = w.id) AS video_count
     FROM workspaces w JOIN workspace_members wm ON w.id = wm.workspace_id
     WHERE wm.user_id = $1 ORDER BY w.is_master DESC, w.name ASC`,
    [req.session.uid]
  );
  res.json({ workspaces });
});

app.post('/workspaces', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'editor')) return;
  const { name, description = '', icon = '📁' } = req.body || {};
  if (!name) return sendErr(res, 'Name required');
  const id = genId();
  await q('INSERT INTO workspaces (id, name, description, icon, owner_id) VALUES ($1,$2,$3,$4,$5)', [id, name.trim(), description, icon, req.session.uid]);
  await q('INSERT INTO workspace_members (workspace_id, user_id, permission) VALUES ($1,$2,$3)', [id, req.session.uid, 'delete']);
  res.json({ success: true, workspace: { id, name, description, icon, owner_id: req.session.uid, permission: 'delete', video_count: 0 } });
});

// NOTE: the old Worker's DELETE /workspaces/:id matched with startsWith(), which
// shadowed DELETE /workspaces/:id/videos/:vid — removing a video could delete the
// whole workspace. Express route params make each pattern exact, fixing that bug.
app.delete('/workspaces/:id', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const ws = await one('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
  if (!ws) return sendErr(res, 'Not found', 404);
  if (ws.is_master) return sendErr(res, 'Cannot delete master database');
  const perm = await one('SELECT permission FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [req.params.id, req.session.uid]);
  if (!perm || perm.permission !== 'delete') return sendErr(res, 'Forbidden', 403);
  await q('DELETE FROM video_workspaces WHERE workspace_id = $1', [req.params.id]);
  await q('DELETE FROM workspace_members WHERE workspace_id = $1', [req.params.id]);
  await q('DELETE FROM workspaces WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.get('/workspaces/:id/videos', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const wsId = req.params.id;
  const perm = await one('SELECT permission FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsId, req.session.uid]);
  const ws = await one('SELECT * FROM workspaces WHERE id = $1', [wsId]);
  if (!ws) return sendErr(res, 'Not found', 404);
  if (ws.is_master && req.session.role === 'viewer') return sendErr(res, 'Forbidden', 403);
  if (!perm && !ws.is_master) return sendErr(res, 'Forbidden', 403);
  const format = req.query.format || '';
  const search = req.query.search || '';
  let videos;
  if (ws.is_master) {
    const conds = []; const params = [];
    if (format) { params.push(format); conds.push(`format = $${params.length}`); }
    if (search) { params.push('%' + search + '%'); conds.push(`video_title ILIKE $${params.length}`); }
    videos = await q(
      'SELECT * FROM videos' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT 1000',
      params
    );
  } else {
    const params = [wsId]; let extra = '';
    if (format) { params.push(format); extra += ` AND v.format = $${params.length}`; }
    if (search) { params.push('%' + search + '%'); extra += ` AND v.video_title ILIKE $${params.length}`; }
    videos = await q(
      `SELECT v.* FROM videos v JOIN video_workspaces vw ON v.video_id = vw.video_id
       WHERE vw.workspace_id = $1${extra} ORDER BY vw.added_at DESC LIMIT 1000`,
      params
    );
  }
  res.json({ videos, count: videos.length, workspace: ws });
});

app.delete('/workspaces/:id/videos/:vid', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const ws = await one('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
  if (!ws) return sendErr(res, 'Not found', 404);
  if (ws.is_master) return sendErr(res, 'Cannot remove from master database');
  const perm = await one('SELECT permission FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [req.params.id, req.session.uid]);
  if (!perm || perm.permission === 'view') return sendErr(res, 'Forbidden', 403);
  await q('DELETE FROM video_workspaces WHERE video_id = $1 AND workspace_id = $2', [req.params.vid, req.params.id]);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
// VIDEOS
// ══════════════════════════════════════════════════════════════

app.get('/videos/check/:id', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const row = await one('SELECT * FROM videos WHERE video_id = $1', [req.params.id]);
  res.json({ exists: !!row, video: row || null });
});

// Column order matches the value builder below — placeholders are generated,
// so a count mismatch (the old Worker's 56-vs-68 bug) is impossible.
const VIDEO_COLS = [
  'video_id','video_link','video_title','channel_name','channel_id',
  'published_at','thumbnail_url','views_total','likes','comments',
  'channel_size','channel_avg_views','title_length','has_number','has_question',
  'has_timeframe','has_difficulty','has_money','starts_with_i','all_caps_words',
  'is_series','is_collab','clickbait_score','format','formula','number_of_tags','tags',
  'video_length','video_length_secs','face_emotion','character_present',
  'minecraft_skin_visible','arrows_circles','text_present','dominant_color',
  'clarity_score','thumbnail_style','thumbnail_background','thumbnail_contrast',
  'thumbnail_has_before_after','thumbnail_num_faces','thumbnail_has_item',
  'composition_notes','thumbnail_text','views_per_sub','log_views','like_rate',
  'comment_rate','engagement','packaging','perf_label','perf_score',
  'days_since_published','views_per_day','like_to_comment_ratio','relative_perf_index',
  'intro_hook_type','intro_result_shown','intro_goal_stated','intro_opening_line',
  'intro_tension','intro_pacing','intro_voice_style','intro_face_on_camera',
  'intro_music','intro_thumbnail_callback','intro_score','intro_transcript',
];

function videoValues(v) {
  return [
    str(v.video_id), str(v.video_link), str(v.video_title), str(v.channel_name), str(v.channel_id),
    str(v.published_at), str(v.thumbnail_url), str(v.views_total || 0), str(v.likes || 0), str(v.comments || 0),
    str(v.channel_size || 0), v.channel_avg_views || 0, v.title_length || 0, bool(v.has_number), bool(v.has_question),
    bool(v.has_timeframe), bool(v.has_difficulty), bool(v.has_money), bool(v.starts_with_i), v.all_caps_words || 0,
    bool(v.is_series), bool(v.is_collab), v.clickbait_score || 0, str(v.format || 'other'), str(v.formula), v.number_of_tags || 0, JSON.stringify(v.tags || []),
    str(v.video_length), v.video_length_secs || 0, str(v.face_emotion), str(v.character_present),
    str(v.minecraft_skin_visible), str(v.arrows_circles), str(v.text_present), str(v.dominant_color),
    str(v.clarity_score), str(v.thumbnail_style), str(v.thumbnail_background), str(v.thumbnail_contrast),
    str(v.thumbnail_has_before_after), str(v.thumbnail_num_faces), str(v.thumbnail_has_item),
    str(v.composition_notes), str(v.thumbnail_text), str(v.views_per_sub), str(v.log_views), str(v.like_rate),
    str(v.comment_rate), str(v.engagement), v.packaging || 0, str(v.perf_label), v.perf_score || 0,
    str(v.days_since_published), str(v.views_per_day), str(v.like_to_comment_ratio), str(v.relative_perf_index),
    str(v.intro_hook_type || ''), str(v.intro_result_shown || ''), str(v.intro_goal_stated || ''), str(v.intro_opening_line || ''),
    str(v.intro_tension || ''), str(v.intro_pacing || ''), str(v.intro_voice_style || ''), str(v.intro_face_on_camera || ''),
    str(v.intro_music || ''), str(v.intro_thumbnail_callback || ''), v.intro_score || 0, str(v.intro_transcript || ''),
  ];
}

// Fields overwritten on every re-analysis (metrics + thumbnail AI):
const OVERWRITE_COLS = [
  'views_total','likes','comments','channel_size','channel_avg_views',
  'face_emotion','character_present','minecraft_skin_visible','arrows_circles',
  'text_present','dominant_color','clarity_score','thumbnail_style',
  'thumbnail_background','thumbnail_contrast','thumbnail_has_before_after',
  'thumbnail_num_faces','thumbnail_has_item','composition_notes','thumbnail_text',
  'views_per_sub','log_views','like_rate','comment_rate','engagement','packaging',
  'perf_label','perf_score','days_since_published','views_per_day',
  'like_to_comment_ratio','relative_perf_index',
];
// Intro fields only overwrite when the incoming value is non-empty
const INTRO_KEEP_COLS = [
  'intro_transcript','intro_hook_type','intro_result_shown','intro_goal_stated',
  'intro_opening_line','intro_tension','intro_face_on_camera','intro_pacing',
  'intro_voice_style','intro_music','intro_thumbnail_callback',
];

const VIDEO_UPSERT_SQL = `
  INSERT INTO videos (${VIDEO_COLS.join(',')})
  VALUES (${VIDEO_COLS.map((_, i) => '$' + (i + 1)).join(',')})
  ON CONFLICT (video_id) DO UPDATE SET
    ${OVERWRITE_COLS.map(c => `${c} = EXCLUDED.${c}`).join(',\n    ')},
    ${INTRO_KEEP_COLS.map(c => `${c} = CASE WHEN EXCLUDED.${c} <> '' THEN EXCLUDED.${c} ELSE videos.${c} END`).join(',\n    ')},
    intro_score = CASE WHEN EXCLUDED.intro_score > 0 THEN EXCLUDED.intro_score ELSE videos.intro_score END,
    updated_at = NOW()
`;

app.post('/videos', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'editor')) return;
  const { video, workspace_ids = [] } = req.body || {};
  if (!video?.video_id || !video?.video_title) return sendErr(res, 'video_id and video_title required');

  const vals = videoValues(video);
  if (vals.length !== VIDEO_COLS.length) return sendErr(res, 'Internal column mismatch', 500); // can't happen, but cheap insurance
  await q(VIDEO_UPSERT_SQL, vals);

  const masterWs = await one('SELECT id FROM workspaces WHERE is_master = 1');
  if (masterWs) {
    await q('INSERT INTO video_workspaces (video_id, workspace_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [video.video_id, masterWs.id, req.session.uid]);
  }
  for (const wsId of workspace_ids) {
    const perm = await one('SELECT permission FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsId, req.session.uid]);
    if (perm) {
      await q('INSERT INTO video_workspaces (video_id, workspace_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [video.video_id, wsId, req.session.uid]);
    }
  }
  res.json({ success: true, video_id: video.video_id });
});

// Bulk-link a list of video IDs from master into a workspace
app.post('/workspaces/:id/bulk-add', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'editor')) return;
  const ws = await one('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
  if (!ws) return sendErr(res, 'Not found', 404);
  if (ws.is_master) return sendErr(res, 'Cannot bulk-add to master database');
  const perm = await one('SELECT permission FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [req.params.id, req.session.uid]);
  if (!perm) return sendErr(res, 'Forbidden', 403);
  const { video_ids = [] } = req.body || {};
  if (!Array.isArray(video_ids) || !video_ids.length) return sendErr(res, 'video_ids array required');
  let added = 0, already_linked = 0;
  for (const vid of video_ids) {
    const exists = await one('SELECT 1 FROM videos WHERE video_id = $1', [vid]);
    if (!exists) continue;
    const result = await q(
      'INSERT INTO video_workspaces (video_id, workspace_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [vid, req.params.id, req.session.uid]
    );
    if (result.length === 0) already_linked++; else added++;
  }
  res.json({ success: true, added, already_linked });
});

// ══════════════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════════════

app.get('/stats', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const wsId = req.query.workspace || '';
  let total, avgViews, topFmt, viral;
  if (wsId) {
    total = await one('SELECT COUNT(*)::int AS n FROM video_workspaces WHERE workspace_id = $1', [wsId]);
    avgViews = await one('SELECT AVG(CAST(v.views_total AS DOUBLE PRECISION))::float8 AS avg FROM videos v JOIN video_workspaces vw ON v.video_id = vw.video_id WHERE vw.workspace_id = $1', [wsId]);
    topFmt = await one('SELECT v.format, COUNT(*)::int AS n FROM videos v JOIN video_workspaces vw ON v.video_id = vw.video_id WHERE vw.workspace_id = $1 GROUP BY v.format ORDER BY n DESC LIMIT 1', [wsId]);
    viral = await one("SELECT COUNT(*)::int AS n FROM videos v JOIN video_workspaces vw ON v.video_id = vw.video_id WHERE vw.workspace_id = $1 AND v.perf_label IN ('Viral','Overperforming')", [wsId]);
  } else {
    total = await one('SELECT COUNT(*)::int AS n FROM videos');
    avgViews = await one('SELECT AVG(CAST(views_total AS DOUBLE PRECISION))::float8 AS avg FROM videos');
    topFmt = await one('SELECT format, COUNT(*)::int AS n FROM videos GROUP BY format ORDER BY n DESC LIMIT 1');
    viral = await one("SELECT COUNT(*)::int AS n FROM videos WHERE perf_label IN ('Viral','Overperforming')");
  }
  res.json({ total: total?.n || 0, avg_views: Math.round(avgViews?.avg || 0), top_format: topFmt?.format || '—', viral_count: viral?.n || 0 });
});

// ══════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════

app.get('/admin/users', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  const users = await q('SELECT id, username, role, daily_ai_limit, created_at FROM users ORDER BY created_at DESC');
  res.json({ users });
});

app.post('/admin/users', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  const { username, password, role = 'viewer', daily_ai_limit = 20 } = req.body || {};
  if (!username || !password) return sendErr(res, 'Username and password required');
  if (String(password).length < 8) return sendErr(res, 'Password must be at least 8 characters');
  const uname = username.trim().toLowerCase();
  const existing = await one('SELECT id FROM users WHERE username = $1', [uname]);
  if (existing) return sendErr(res, 'Username already exists');
  const hash = await bcrypt.hash(password, 10);
  const id = genId();
  await q('INSERT INTO users (id, username, password_hash, role, daily_ai_limit) VALUES ($1,$2,$3,$4,$5)', [id, uname, hash, role, daily_ai_limit]);
  res.json({ success: true, user: { id, username: uname, role, daily_ai_limit } });
});

app.delete('/admin/users/:id', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  if (req.params.id === req.session.uid) return sendErr(res, 'Cannot delete yourself');
  await q('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
  await q('DELETE FROM workspace_members WHERE user_id = $1', [req.params.id]);
  await q('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.get('/admin/workspaces', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  const workspaces = await q(
    `SELECT w.*, (SELECT COUNT(*)::int FROM video_workspaces vw WHERE vw.workspace_id = w.id) AS video_count
     FROM workspaces w ORDER BY w.is_master DESC, w.name ASC`
  );
  const members = await q(
    `SELECT wm.workspace_id, wm.user_id, wm.permission, u.username
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id`
  );
  const byWs = {};
  for (const m of members) (byWs[m.workspace_id] = byWs[m.workspace_id] || []).push({ user_id: m.user_id, username: m.username, permission: m.permission });
  res.json({ workspaces: workspaces.map(w => ({ ...w, members: byWs[w.id] || [] })) });
});

app.post('/admin/workspaces/:id/members', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  const { user_id, permission = 'view' } = req.body || {};
  if (!user_id) return sendErr(res, 'user_id required');
  await q(
    `INSERT INTO workspace_members (workspace_id, user_id, permission) VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET permission = EXCLUDED.permission`,
    [req.params.id, user_id, permission]
  );
  res.json({ success: true });
});

app.delete('/admin/workspaces/:id/members/:uid', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  await q('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [req.params.id, req.params.uid]);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
// CHANNEL MONITOR (admin)
// ══════════════════════════════════════════════════════════════

app.get('/admin/channels', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  const channels = await q('SELECT * FROM channel_monitor ORDER BY created_at DESC');
  res.json({ channels });
});

app.post('/admin/channels', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  const { channel_id, channel_name, channel_url = '' } = req.body || {};
  if (!channel_id || !channel_name) return sendErr(res, 'channel_id and channel_name required');
  const existing = await one('SELECT 1 FROM channel_monitor WHERE channel_id = $1', [channel_id]);
  if (existing) return sendErr(res, 'Channel already in watchlist');
  await q(
    'INSERT INTO channel_monitor (channel_id, channel_name, channel_url, added_by) VALUES ($1,$2,$3,$4)',
    [channel_id.trim(), channel_name.trim(), channel_url.trim(), req.session.uid]
  );
  res.json({ success: true, channel: { channel_id, channel_name, channel_url, active: 1 } });
});

app.patch('/admin/channels/:id', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  const { active } = req.body || {};
  await q('UPDATE channel_monitor SET active=$1 WHERE channel_id=$2', [active ? 1 : 0, req.params.id]);
  res.json({ success: true });
});

app.delete('/admin/channels/:id', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  await q('DELETE FROM channel_monitor WHERE channel_id = $1', [req.params.id]);
  res.json({ success: true });
});

// Manual trigger endpoints (admin only — useful for testing without waiting for schedule)
app.post('/admin/cron/refresh', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  res.json({ success: true, message: 'Stats refresh started in background' });
  runStatsRefresh().catch(e => console.error('[manual refresh]', e.message));
});

app.post('/admin/cron/monitor', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!requireRole(req, res, 'admin')) return;
  res.json({ success: true, message: 'Channel monitor started in background' });
  runChannelMonitor().catch(e => console.error('[manual monitor]', e.message));
});

// ══════════════════════════════════════════════════════════════
// TRANSCRIPT + AI
// ══════════════════════════════════════════════════════════════

app.get('/transcript/:videoId', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { videoId } = req.params;

  // The YouTube timedtext endpoint works without OAuth or an API key.
  // The captions API (googleapis.com/youtube/v3/captions) requires OAuth for
  // most videos and was causing 400 errors, so it has been removed.
  const ttRes = await fetch(`https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=en&fmt=json3`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!ttRes.ok) return res.json({ transcript: null, first30: null, available: false });

  let ttData;
  try { ttData = await ttRes.json(); } catch { return res.json({ transcript: null, first30: null, available: false }); }

  const events = ttData.events || [];
  const first30Text = events
    .filter(e => (e.tStartMs || 0) <= 30000)
    .flatMap(e => e.segs || [])
    .map(s => s.utf8 || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const fullText = events
    .flatMap(e => e.segs || [])
    .map(s => s.utf8 || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);

  res.json({
    available: first30Text.length > 0,
    first30: first30Text,
    transcript_preview: fullText,
    caption_count: 0,
  });
});

// Atomically consume one AI credit. Returns {used, limit} or null if over limit.
async function consumeAiCredit(session) {
  const today = new Date().toISOString().split('T')[0];
  const row = await one(
    `INSERT INTO ai_usage (user_id, date, count) VALUES ($1,$2,1)
     ON CONFLICT (user_id, date) DO UPDATE SET count = ai_usage.count + 1
     RETURNING count`,
    [session.uid, today]
  );
  if (row.count > session.daily_ai_limit) return null;
  return { used: row.count, limit: session.daily_ai_limit };
}

async function callAnthropic(payload) {
  const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

app.post('/analyze-intro', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!process.env.ANTHROPIC_API_KEY) return sendErr(res, 'Anthropic API key not configured', 500);
  const { transcript, title, channel, views } = req.body || {};
  if (!transcript) return sendErr(res, 'transcript required');
  const usage = await consumeAiCredit(req.session);
  if (!usage) return sendErr(res, 'Daily AI limit reached', 429);

  const prompt = `Analyze this YouTube video intro (first ~30 seconds of transcript).
Video: "${title}" by ${channel} (${views} views)

TRANSCRIPT:
"${transcript}"

Return ONLY valid JSON (no markdown, no backticks):
{
  "hook_type": "result-first|question|challenge-statement|action|story|direct-address|shock|other",
  "result_shown_first": "yes|no",
  "goal_stated_early": "yes|no",
  "opening_line": "exact first meaningful sentence spoken",
  "tension_present": "yes|no",
  "face_on_camera": "yes|no|unknown",
  "pacing": "fast|medium|slow",
  "voice_style": "hype|calm|educational|storytelling|direct|conversational",
  "music_present": "yes|no|unknown",
  "thumbnail_callback": "yes|no",
  "intro_score": 75,
  "analysis": "2-3 sentence analysis of why this intro works or doesn't — be specific about what hooks the viewer"
}

intro_score: 0-100. High score = strong hook, clear goal, good pacing, thumbnail callback. Low score = slow start, no clear hook.`;

  const { ok, data } = await callAnthropic({
    model: AI_MODEL,
    max_tokens: 600,
    system: 'You analyze YouTube video intros and return structured JSON only. Be specific and data-driven.',
    messages: [{ role: 'user', content: prompt }],
  });
  if (!ok) return sendErr(res, data?.error?.message || 'Anthropic error', 502);
  const reply = data.content?.find(c => c.type === 'text')?.text || '';
  try {
    const parsed = JSON.parse(reply.replace(/```json|```/g, '').trim());
    res.json({ ...parsed, usage });
  } catch {
    sendErr(res, 'Failed to parse AI response');
  }
});

app.post('/ai', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!process.env.ANTHROPIC_API_KEY) return sendErr(res, 'Anthropic API key not configured', 500);
  const { messages, system } = req.body || {};
  if (!messages || !Array.isArray(messages)) return sendErr(res, 'messages array required');
  const usage = await consumeAiCredit(req.session);
  if (!usage) return sendErr(res, `Daily AI limit reached (${req.session.daily_ai_limit} messages/day)`, 429);

  const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image'));
  const { ok, data } = await callAnthropic({
    model: AI_MODEL,
    max_tokens: hasImage ? 600 : 1500,
    system: system || 'You are a helpful assistant.',
    messages,
  });
  if (!ok) return sendErr(res, data?.error?.message || 'Anthropic error', 502);
  const reply = data.content?.find(c => c.type === 'text')?.text || 'No response.';
  res.json({ reply, usage });
});

// ══════════════════════════════════════════════════════════════
// STATIC FRONTEND + BOOT
// ══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.redirect('/app.html'));
app.use(express.static(path.join(__dirname, 'public')));

// JSON 404 for unknown API paths (same as the Worker)
app.use((req, res) => sendErr(res, 'Not found', 404));

// Central error handler — malformed JSON bodies, unexpected route errors
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') return sendErr(res, 'Invalid JSON');
  if (err?.type === 'entity.too.large') return sendErr(res, 'Request too large', 413);
  console.error('Unhandled route error:', err);
  sendErr(res, 'Internal server error', 500);
});

const PORT = process.env.PORT || 3000;
(async () => {
  try {
    await migrate();
    await seed();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✓ Ashborn API listening on :${PORT} (model: ${AI_MODEL})`);
      startCron(); // start background refresh + channel monitor
    });
  } catch (e) {
    console.error('FATAL boot error:', e);
    process.exit(1);
  }
})();
