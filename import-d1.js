// One-time importer: move your existing D1 videos into PostgreSQL.
//
// Step 1 — export from D1 (run in your old Cloudflare project folder):
//   wrangler d1 execute ashborn-db --remote --json --command "SELECT * FROM videos" > d1-export.json
//
// Step 2 — import into Railway Postgres (from this folder):
//   DATABASE_URL="<your Railway PUBLIC database URL>" node import-d1.js d1-export.json
//
// Use the PUBLIC connection URL from Railway's Postgres service → "Connect" tab
// (looks like postgresql://postgres:...@xxxx.proxy.rlwy.net:PORT/railway).
// The .railway.internal URL only works from inside Railway.
//
// Existing rows are never overwritten (ON CONFLICT DO NOTHING), and every
// imported video is linked to the master workspace.

const fs = require('fs');
const { q, one, migrate, seed, pool } = require('./db');

const COLS = [
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
const NUM_COLS = new Set([
  'channel_avg_views','title_length','has_number','has_question','has_timeframe',
  'has_difficulty','has_money','starts_with_i','all_caps_words','is_series','is_collab',
  'clickbait_score','number_of_tags','video_length_secs','packaging','perf_score','intro_score',
]);

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node import-d1.js <d1-export.json>'); process.exit(1); }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // wrangler --json outputs [{results:[...], success:true, meta:{}}]; accept a bare array too
  const rows = Array.isArray(raw) && raw[0]?.results ? raw[0].results : (Array.isArray(raw) ? raw : raw.results || []);
  if (!rows.length) { console.error('No rows found in export file.'); process.exit(1); }
  console.log(`Importing ${rows.length} videos...`);

  await migrate();
  await seed();

  const sql = `INSERT INTO videos (${COLS.join(',')}) VALUES (${COLS.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT (video_id) DO NOTHING`;
  let imported = 0, linked = 0;
  const master = await one('SELECT id FROM workspaces WHERE is_master = 1');

  for (const r of rows) {
    const vals = COLS.map(c => {
      const v = r[c];
      if (NUM_COLS.has(c)) return Number(v) || 0;
      return v == null ? '' : String(v);
    });
    const result = await pool.query(sql, vals);
    if (result.rowCount > 0) imported++;
    if (master && r.video_id) {
      const link = await pool.query(
        'INSERT INTO video_workspaces (video_id, workspace_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [String(r.video_id), master.id, 'admin001']
      );
      if (link.rowCount > 0) linked++;
    }
  }
  console.log(`✓ imported ${imported} new videos (${rows.length - imported} already existed)`);
  console.log(`✓ linked ${linked} videos to master workspace`);
  await pool.end();
})().catch(e => { console.error('Import failed:', e.message); process.exit(1); });
