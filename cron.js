// Ashborn Studios — background cron jobs
//
// Jobs:
//   1. statsRefresh    — refreshes views/likes/comments on every video, twice daily (06:00 + 18:00 UTC)
//   2. channelMonitor  — checks watched channels for new uploads, twice daily
//   3. autoHarvest     — pulls recent videos from watchlist channels daily (02:00 UTC), applies constraints
//   4. velocityTick    — every 5 min, fires any due velocity snapshots from velocity_schedule table
//
// Velocity schedule:
//   When any new video is added (channel monitor OR harvest), scheduleVelocitySnapshots() inserts
//   rows into velocity_schedule with fire_at timestamps. velocityTick() checks every 5 min and
//   captures due snapshots. Persisted in DB so Railway restarts don't lose pending snapshots.
//
//   Snapshot cadence: 1h, 2h, 3h, 6h, 12h, 24h (hourly tracking for first day)
//                     then 48h, 7d, 30d

const { q, one } = require('./db');

const YT_KEY        = process.env.YOUTUBE_API_KEY;
const AI_MODEL      = process.env.AI_MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── YouTube API helper ─────────────────────────────────────────

async function ytFetch(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`YouTube API: ${data.error.message}`);
  return data;
}

// ── Velocity snapshot capture ──────────────────────────────────

async function captureVelocity(videoId, snapshotType) {
  if (!YT_KEY) return;
  try {
    const data = await ytFetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&key=${YT_KEY}`
    );
    const s = data.items?.[0]?.statistics;
    if (!s) return;
    await q(
      `INSERT INTO video_velocity (video_id, snapshot_type, views, likes, comments, captured_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (video_id, snapshot_type) DO UPDATE SET
         views=EXCLUDED.views, likes=EXCLUDED.likes, comments=EXCLUDED.comments,
         captured_at=NOW()`,
      [videoId, snapshotType, parseInt(s.viewCount)||0, parseInt(s.likeCount)||0, parseInt(s.commentCount)||0]
    );
  } catch (e) {
    console.error('[cron] velocity capture failed:', videoId, snapshotType, e.message);
  }
}

// ── DB-persisted velocity schedule ────────────────────────────
// Snapshot windows: first 24h → every few hours. Then longer intervals.
const SNAPSHOT_WINDOWS = [
  { type: '1h',  ms: 1  * 60 * 60 * 1000 },
  { type: '2h',  ms: 2  * 60 * 60 * 1000 },
  { type: '3h',  ms: 3  * 60 * 60 * 1000 },
  { type: '6h',  ms: 6  * 60 * 60 * 1000 },
  { type: '12h', ms: 12 * 60 * 60 * 1000 },
  { type: '24h', ms: 24 * 60 * 60 * 1000 },
  { type: '48h', ms: 48 * 60 * 60 * 1000 },
  { type: '7d',  ms: 7  * 24 * 60 * 60 * 1000 },
  { type: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

async function scheduleVelocitySnapshots(videoId) {
  const now = Date.now();
  // Insert schedule rows — ignore conflicts (already scheduled)
  for (const { type, ms } of SNAPSHOT_WINDOWS) {
    const fireAt = new Date(now + ms).toISOString();
    await q(
      `INSERT INTO velocity_schedule (video_id, snapshot_type, fire_at, done)
       VALUES ($1,$2,$3,0)
       ON CONFLICT DO NOTHING`,
      [videoId, type, fireAt]
    ).catch(() => {});
  }
  console.log(`[cron] velocity scheduled for ${videoId} (${SNAPSHOT_WINDOWS.length} snapshots)`);
}

// Runs every 5 minutes — fires any due snapshots
async function velocityTick() {
  if (!YT_KEY) return;
  try {
    const due = await q(
      `SELECT id, video_id, snapshot_type FROM velocity_schedule
       WHERE done=0 AND fire_at <= NOW()
       LIMIT 20`
    );
    if (!due.length) return;
    let had24h = false;
    for (const row of due) {
      await captureVelocity(row.video_id, row.snapshot_type);
      await q('UPDATE velocity_schedule SET done=1 WHERE id=$1', [row.id]);
      if (row.snapshot_type === '24h') had24h = true;
      await sleep(200);
    }
    if (due.length) console.log(`[cron] velocityTick — captured ${due.length} snapshots`);
    // After any 24h snapshots are captured, check for velocity spikes
    if (had24h) runVelocitySpikeCheck().catch(e => console.error('[cron] velocitySpike bg error:', e.message));
  } catch (e) {
    console.error('[cron] velocityTick error:', e.message);
  }
}

// ── Refresh stats for a batch of video IDs ────────────────────

async function refreshVideoStats(videoIds) {
  if (!YT_KEY || !videoIds.length) return { updated: 0 };
  const chunks = [];
  for (let i = 0; i < videoIds.length; i += 50) chunks.push(videoIds.slice(i, i + 50));
  let updated = 0;
  for (const chunk of chunks) {
    try {
      const data = await ytFetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${chunk.join(',')}&key=${YT_KEY}`
      );
      for (const item of data.items || []) {
        const s = item.statistics;
        await q(
          `UPDATE videos SET views_total=$1, likes=$2, comments=$3, updated_at=NOW()
           WHERE video_id=$4`,
          [s.viewCount||'0', s.likeCount||'0', s.commentCount||'0', item.id]
        );
        updated++;
      }
    } catch (e) {
      console.error('[cron] stats chunk failed:', e.message);
    }
    await sleep(200);
  }
  return { updated };
}

// ── Auto-analyze a video (metadata + intro AI) ────────────────

async function autoAnalyzeVideo(videoId) {
  if (!YT_KEY) return null;
  try {
    const vData = await ytFetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${YT_KEY}`
    );
    const item = vData.items?.[0];
    if (!item) return null;

    const cData = await ytFetch(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${item.snippet.channelId}&key=${YT_KEY}`
    );
    const cs = cData.items?.[0]?.statistics || {};
    const s  = item.statistics;
    const tags = item.snippet.tags || [];

    // Duration
    const dur = item.contentDetails?.duration || '';
    const dm  = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    const dh = +dm?.[1]||0, dmin = +dm?.[2]||0, ds = +dm?.[3]||0;
    const secs = dh*3600 + dmin*60 + ds;
    const dstr = dh > 0
      ? `${dh}:${String(dmin).padStart(2,'0')}:${String(ds).padStart(2,'0')}`
      : `${dmin}:${String(ds).padStart(2,'0')}`;

    const title = item.snippet.title;
    const thumbUrl = item.snippet.thumbnails?.maxres?.url ||
                     item.snippet.thumbnails?.high?.url ||
                     `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    const fmts = {
      challenge:/\b(challenge|but|without|only|every)\b/i,
      survival:/\b(surviv|days?|hardcore)\b/i,
      tutorial:/\b(how to|tutorial|guide)\b/i,
      speedrun:/\b(speedrun|world record)\b/i,
      comparison:/\b(vs\.?|versus)\b/i,
      story:/\b(story|lore|secret)\b/i,
    };
    let format = 'other';
    for (const [k, re] of Object.entries(fmts)) if (re.test(title)) { format = k; break; }

    const video = {
      video_id: videoId,
      video_link: `https://www.youtube.com/watch?v=${videoId}`,
      video_title: title,
      channel_name: item.snippet.channelTitle,
      channel_id: item.snippet.channelId,
      published_at: item.snippet.publishedAt?.split('T')[0] || '',
      thumbnail_url: thumbUrl,
      views_total: s.viewCount||'0',
      likes: s.likeCount||'0',
      comments: s.commentCount||'0',
      channel_size: cs.subscriberCount||'0',
      channel_avg_views: 0,
      title_length: title.length,
      has_number: /\d/.test(title) ? 1 : 0,
      has_question: /\?/.test(title) ? 1 : 0,
      has_timeframe: /\b(\d+\s*days?|24\s*hours?|1\s*week)\b/i.test(title) ? 1 : 0,
      has_difficulty: /\b(impossible|hardest|easiest|insane)\b/i.test(title) ? 1 : 0,
      has_money: /\$[\d,]+|\d+[\s,]*(?:dollars?|million)\b/i.test(title) ? 1 : 0,
      starts_with_i: /^i\b/i.test(title.trim()) ? 1 : 0,
      all_caps_words: title.split(/\s+/).filter(w => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w)).length,
      is_series: /\b(ep\.?\s*\d+|part\s*\d+|season\s*\d+)\b/i.test(title) ? 1 : 0,
      is_collab: /@\w+|ft\.?\s+\w+/i.test(title) ? 1 : 0,
      clickbait_score: 0,
      format,
      formula: '',
      number_of_tags: tags.length,
      tags,
      video_length: dstr,
      video_length_secs: secs,
      face_emotion:'', character_present:'', minecraft_skin_visible:'',
      arrows_circles:'', text_present:'', dominant_color:'',
      clarity_score:'', thumbnail_style:'', thumbnail_background:'',
      thumbnail_contrast:'', thumbnail_has_before_after:'',
      thumbnail_num_faces:'', thumbnail_has_item:'',
      composition_notes:'', thumbnail_text:'',
      views_per_sub:'', log_views:'', like_rate:'', comment_rate:'',
      engagement:'', packaging:0, perf_label:'', perf_score:0,
      days_since_published:'', views_per_day:'', like_to_comment_ratio:'',
      relative_perf_index:'',
      intro_hook_type:'', intro_result_shown:'', intro_goal_stated:'',
      intro_opening_line:'', intro_tension:'', intro_pacing:'',
      intro_voice_style:'', intro_face_on_camera:'', intro_music:'',
      intro_thumbnail_callback:'', intro_score:0, intro_transcript:'',
    };

    // Intro analysis (free via timedtext — no AI cost for transcript fetch)
    try {
      const ttRes = await fetch(
        `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=en&fmt=json3`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (ttRes.ok) {
        const ttData = await ttRes.json().catch(() => null);
        const events = ttData?.events || [];
        const first30 = events
          .filter(e => (e.tStartMs||0) <= 30000)
          .flatMap(e => e.segs||[])
          .map(s => s.utf8||'')
          .join(' ').replace(/\s+/g, ' ').trim();

        if (first30 && process.env.ANTHROPIC_API_KEY) {
          video.intro_transcript = first30;
          const prompt = `Analyze this YouTube video intro (first ~30 seconds).
Video: "${title}" by ${item.snippet.channelTitle} (${s.viewCount} views)
TRANSCRIPT: "${first30}"
Return ONLY valid JSON: {"hook_type":"result-first|question|challenge-statement|action|story|direct-address|shock|other","result_shown_first":"yes|no","goal_stated_early":"yes|no","opening_line":"exact first meaningful sentence","tension_present":"yes|no","face_on_camera":"yes|no|unknown","pacing":"fast|medium|slow","voice_style":"hype|calm|educational|storytelling|direct|conversational","music_present":"yes|no|unknown","thumbnail_callback":"yes|no","intro_score":75,"analysis":"2-3 sentences"}`;
          const aiRes = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
            body: JSON.stringify({ model: AI_MODEL, max_tokens: 600, system: 'Return structured JSON only.', messages: [{ role:'user', content: prompt }] }),
          });
          const aiData = await aiRes.json();
          const reply = aiData.content?.find(c => c.type==='text')?.text || '';
          const parsed = JSON.parse(reply.replace(/```json|```/g,'').trim());
          video.intro_hook_type          = parsed.hook_type||'';
          video.intro_result_shown       = parsed.result_shown_first||'';
          video.intro_goal_stated        = parsed.goal_stated_early||'';
          video.intro_opening_line       = parsed.opening_line||'';
          video.intro_tension            = parsed.tension_present||'';
          video.intro_pacing             = parsed.pacing||'';
          video.intro_voice_style        = parsed.voice_style||'';
          video.intro_face_on_camera     = parsed.face_on_camera||'';
          video.intro_music              = parsed.music_present||'';
          video.intro_thumbnail_callback = parsed.thumbnail_callback||'';
          video.intro_score              = parseInt(parsed.intro_score)||0;
        }
      }
    } catch (e) {
      console.error('[cron] intro analysis failed for', videoId, e.message);
    }

    return video;
  } catch (e) {
    console.error('[cron] autoAnalyzeVideo failed:', videoId, e.message);
    return null;
  }
}

// ── VIDEO upsert (mirrors server.js) ──────────────────────────

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
const OVERWRITE_COLS = [
  'views_total','likes','comments','channel_size','channel_avg_views',
  'views_per_sub','log_views','like_rate','comment_rate','engagement',
  'packaging','perf_label','perf_score','days_since_published','views_per_day',
  'like_to_comment_ratio','relative_perf_index',
];
const INTRO_KEEP_COLS = [
  'intro_transcript','intro_hook_type','intro_result_shown','intro_goal_stated',
  'intro_opening_line','intro_tension','intro_face_on_camera','intro_pacing',
  'intro_voice_style','intro_music','intro_thumbnail_callback',
];
const UPSERT_SQL = `
  INSERT INTO videos (${VIDEO_COLS.join(',')})
  VALUES (${VIDEO_COLS.map((_,i) => '$'+(i+1)).join(',')})
  ON CONFLICT (video_id) DO UPDATE SET
    ${OVERWRITE_COLS.map(c => `${c}=EXCLUDED.${c}`).join(',\n    ')},
    ${INTRO_KEEP_COLS.map(c => `${c}=CASE WHEN EXCLUDED.${c}<>'' THEN EXCLUDED.${c} ELSE videos.${c} END`).join(',\n    ')},
    intro_score=CASE WHEN EXCLUDED.intro_score>0 THEN EXCLUDED.intro_score ELSE videos.intro_score END,
    updated_at=NOW()
`;

function videoRow(v) {
  return VIDEO_COLS.map(c => {
    const val = v[c];
    if (c === 'tags') return JSON.stringify(Array.isArray(val) ? val : []);
    if (['has_number','has_question','has_timeframe','has_difficulty','has_money','starts_with_i','is_series','is_collab'].includes(c))
      return val === true || val === 1 ? 1 : 0;
    if (['channel_avg_views','packaging','perf_score','clickbait_score','title_length','all_caps_words','number_of_tags','video_length_secs','intro_score'].includes(c))
      return Number(val)||0;
    return val == null ? '' : String(val);
  });
}

// Save new video to DB + link to master workspace + schedule velocity
async function saveNewVideo(videoId, video) {
  await q(UPSERT_SQL, videoRow(video));
  const master = await one('SELECT id FROM workspaces WHERE is_master=1');
  if (master) {
    await q(
      'INSERT INTO video_workspaces (video_id, workspace_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [videoId, master.id, 'cron']
    );
  }
  await scheduleVelocitySnapshots(videoId);
}

// ── Job 1: Stats refresh ───────────────────────────────────────

async function runStatsRefresh() {
  if (!YT_KEY) { console.log('[cron] statsRefresh skipped — no YOUTUBE_API_KEY'); return; }
  console.log('[cron] statsRefresh starting...');
  try {
    const videos = await q('SELECT video_id FROM videos ORDER BY updated_at ASC LIMIT 500');
    const ids = videos.map(v => v.video_id);
    const { updated } = await refreshVideoStats(ids);
    console.log(`[cron] statsRefresh done — ${updated}/${ids.length} videos updated`);
  } catch (e) {
    console.error('[cron] statsRefresh error:', e.message);
  }
}

// ── Job 2: Channel monitor (new uploads only) ──────────────────

async function runChannelMonitor() {
  if (!YT_KEY) { console.log('[cron] channelMonitor skipped — no YOUTUBE_API_KEY'); return; }
  const channels = await q('SELECT * FROM channel_monitor WHERE active=1');
  if (!channels.length) { console.log('[cron] channelMonitor — no channels in watchlist'); return; }
  console.log(`[cron] channelMonitor checking ${channels.length} channels...`);
  let totalNew = 0;

  for (const ch of channels) {
    try {
      const data = await ytFetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${ch.channel_id}&order=date&maxResults=3&type=video&key=${YT_KEY}`
      );
      const items = data.items || [];

      for (const item of items) {
        const videoId = item.id?.videoId;
        if (!videoId) continue;
        const exists = await one('SELECT 1 FROM videos WHERE video_id=$1', [videoId]);
        if (exists) continue;
        // Only fresh uploads (last 72h)
        const ageHours = (Date.now() - new Date(item.snippet.publishedAt).getTime()) / 3600000;
        if (ageHours > 72) continue;

        console.log(`[cron] new upload: ${videoId} from ${ch.channel_name}`);
        const video = await autoAnalyzeVideo(videoId);
        if (!video) continue;
        await saveNewVideo(videoId, video);
        totalNew++;
        await sleep(500);
      }

      const latestId = items[0]?.id?.videoId || ch.last_video_id;
      await q(
        'UPDATE channel_monitor SET last_checked=NOW(), last_video_id=$1 WHERE channel_id=$2',
        [latestId, ch.channel_id]
      );
    } catch (e) {
      console.error(`[cron] channelMonitor error for ${ch.channel_name}:`, e.message);
    }
    await sleep(300);
  }
  console.log(`[cron] channelMonitor done — ${totalNew} new videos`);
}

// ── Job 3: Auto-harvest (daily, respects constraints) ─────────
// Searches ALL channels in the watchlist for videos within constraints.
// This is the bulk library growth engine — channel monitor is for instant alerts.

async function runAutoHarvest() {
  if (!YT_KEY) { console.log('[cron] autoHarvest skipped — no YOUTUBE_API_KEY'); return; }
  const cfg = await one('SELECT * FROM harvest_config WHERE id=1');
  if (!cfg || !cfg.enabled) { console.log('[cron] autoHarvest disabled'); return; }

  const channels = await q('SELECT * FROM channel_monitor WHERE active=1');
  if (!channels.length) { console.log('[cron] autoHarvest — no channels in watchlist'); return; }

  console.log(`[cron] autoHarvest starting — ${channels.length} channels, constraints: minViews=${cfg.min_views} maxAgeDays=${cfg.max_age_days} perChannel=${cfg.videos_per_channel}`);
  let totalAdded = 0;
  let totalSkipped = 0;

  // Quota estimate: search (100 units) + videos.list (1/video) + channels.list (1) per channel
  // With 50 channels and 5 videos each: ~5,250 units — well within 10k/day

  for (const ch of channels) {
    try {
      // Get more videos than the limit so we can filter
      const maxResults = Math.min(50, cfg.videos_per_channel * 3);
      const data = await ytFetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${ch.channel_id}&order=date&maxResults=${maxResults}&type=video&key=${YT_KEY}`
      );
      const items = data.items || [];
      let channelAdded = 0;

      // Fetch channel sub count (needed for both min_channel_subs check and views/sub ratio)
      const cData = await ytFetch(
        `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${ch.channel_id}&key=${YT_KEY}`
      ).catch(() => null);
      const channelSubs = parseInt(cData?.items?.[0]?.statistics?.subscriberCount || '0');

      if (cfg.min_channel_subs > 0 && channelSubs < cfg.min_channel_subs) {
        console.log(`[cron] autoHarvest skip channel ${ch.channel_name} — subs ${channelSubs} < ${cfg.min_channel_subs}`);
        continue;
      }

      for (const item of items) {
        if (channelAdded >= cfg.videos_per_channel) break;
        const videoId = item.id?.videoId;
        if (!videoId) continue;

        // Skip if already in DB
        const exists = await one('SELECT 1 FROM videos WHERE video_id=$1', [videoId]);
        if (exists) { totalSkipped++; continue; }

        // Age constraint
        const ageDays = (Date.now() - new Date(item.snippet.publishedAt).getTime()) / 86400000;
        if (ageDays > cfg.max_age_days) { totalSkipped++; continue; }

        // Quick view count check (1 unit per video — cheap)
        const vStats = await ytFetch(
          `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&key=${YT_KEY}`
        ).catch(() => null);
        const views = parseInt(vStats?.items?.[0]?.statistics?.viewCount || '0');

        // Views-per-sub ratio filter (cfg.min_views repurposed as ratio threshold, e.g. 0.5 = 50% of subs)
        if (cfg.min_views > 0 && channelSubs > 0) {
          const ratio = views / channelSubs;
          if (ratio < cfg.min_views) { totalSkipped++; continue; }
        } else if (cfg.min_views > 0 && channelSubs === 0) {
          // no sub data available, skip ratio check
        }

        console.log(`[cron] autoHarvest: harvesting ${videoId} (${views} views, ${ageDays.toFixed(1)} days old)`);
        const video = await autoAnalyzeVideo(videoId);
        if (!video) continue;

        // If transcript required but none found, skip
        if (cfg.require_transcript && !video.intro_transcript) {
          console.log(`[cron] autoHarvest: skip ${videoId} — no transcript`);
          totalSkipped++;
          continue;
        }

        await saveNewVideo(videoId, video);
        channelAdded++;
        totalAdded++;
        await sleep(600); // be gentle with quota
      }
    } catch (e) {
      console.error(`[cron] autoHarvest error for ${ch.channel_name}:`, e.message);
    }
    await sleep(400);
  }
  console.log(`[cron] autoHarvest done — ${totalAdded} added, ${totalSkipped} skipped`);
}

// ── Helper: insert a notification ─────────────────────────────

async function notify(type, title, body, meta = {}) {
  try {
    await q(
      `INSERT INTO notifications (type, title, body, meta) VALUES ($1,$2,$3,$4)`,
      [type, title, body, JSON.stringify(meta)]
    );
  } catch (e) {
    console.error('[cron] notify insert failed:', e.message);
  }
}

// ── Job 5: Velocity spike re-harvest ──────────────────────────
// After 24h snapshot: if views/sub ratio jumped 3× vs the channel's
// 30d average, auto-pull the video into the DB even if it wasn't
// from a watchlist channel. Also flags it with perf_label='spike'.

async function runVelocitySpikeCheck() {
  if (!YT_KEY) return;
  console.log('[cron] velocitySpike — checking for spikes in 24h snapshots...');
  try {
    // Find 24h snapshots just captured (last 30 minutes) for videos NOT already in our DB
    // We cross-reference all videos that have a fresh 24h snapshot
    const spikes = await q(`
      SELECT vv.video_id, vv.views, v.channel_id, v.channel_size
      FROM video_velocity vv
      JOIN videos v ON vv.video_id = v.video_id
      WHERE vv.snapshot_type = '24h'
        AND vv.captured_at >= NOW() - INTERVAL '35 minutes'
        AND v.channel_size <> '0'
        AND v.channel_size <> ''
    `);

    if (!spikes.length) return;
    console.log(`[cron] velocitySpike — checking ${spikes.length} fresh 24h snapshots`);

    for (const row of spikes) {
      const subs = parseInt(row.channel_size || '0');
      if (!subs) continue;
      const ratio = row.views / subs;

      // Fetch channel's average views/sub ratio over the last 30 days from our DB
      const avgRow = await one(`
        SELECT AVG(CAST(views_total AS BIGINT)::float / NULLIF(CAST(channel_size AS BIGINT), 0)) AS avg_ratio
        FROM videos
        WHERE channel_id = $1
          AND published_at >= (NOW() - INTERVAL '30 days')::date::text
          AND channel_size <> '0'
      `, [row.channel_id]);

      const avgRatio = parseFloat(avgRow?.avg_ratio || '0');
      if (!avgRatio) continue;

      const multiplier = ratio / avgRatio;
      if (multiplier >= 3) {
        console.log(`[cron] velocitySpike: ${row.video_id} ratio ${ratio.toFixed(2)} is ${multiplier.toFixed(1)}× channel avg — flagging!`);
        // Mark with spike label in videos table
        await q(
          `UPDATE videos SET perf_label='spike', updated_at=NOW() WHERE video_id=$1`,
          [row.video_id]
        );
        // Create notification
        const vidRow = await one('SELECT video_title, channel_name FROM videos WHERE video_id=$1', [row.video_id]);
        await notify(
          'velocity_spike',
          `🚀 Velocity spike: ${vidRow?.channel_name || row.video_id}`,
          `"${vidRow?.video_title || row.video_id}" hit ${ratio.toFixed(1)}× views/sub (${multiplier.toFixed(1)}× above channel average) in just 24 hours.`,
          { video_id: row.video_id, ratio, multiplier, avg_ratio: avgRatio }
        );
      }
    }
  } catch (e) {
    console.error('[cron] velocitySpike error:', e.message);
  }
}

// ── Job 6: Auto workspace tagging ─────────────────────────────
// Videos harvested in the last 24h that match high-performer patterns
// (views/sub ratio ≥ 1.0 AND perf_score > 70 OR intro_score > 75)
// get auto-added to a "High Performers" workspace if one exists.

async function runAutoTag() {
  console.log('[cron] autoTag — tagging high-performers...');
  try {
    // Find or create the High Performers workspace (master-owned, special)
    let ws = await one(`SELECT id FROM workspaces WHERE name='High Performers' LIMIT 1`);
    if (!ws) {
      // Create it under the first admin user
      const admin = await one(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
      if (!admin) return;
      const wsId = require('crypto').randomBytes(5).toString('hex').slice(0, 8);
      await q(
        `INSERT INTO workspaces (id, name, description, icon, owner_id, is_master)
         VALUES ($1,$2,$3,$4,$5,0)`,
        [wsId, 'High Performers', 'Auto-tagged videos with exceptional views/sub ratios', '🏆', admin.id]
      );
      ws = { id: wsId };
      console.log('[cron] autoTag — created "High Performers" workspace:', wsId);
    }

    // Find recent videos meeting high-performer thresholds not yet in this workspace
    const candidates = await q(`
      SELECT v.video_id, v.video_title, v.channel_name, v.channel_size, v.views_total,
             v.perf_score, v.intro_score
      FROM videos v
      WHERE v.created_at >= NOW() - INTERVAL '24 hours'
        AND v.channel_size <> '0' AND v.channel_size <> ''
        AND v.views_total <> '0' AND v.views_total <> ''
        AND NOT EXISTS (
          SELECT 1 FROM video_workspaces vw WHERE vw.video_id=v.video_id AND vw.workspace_id=$1
        )
    `, [ws.id]);

    let tagged = 0;
    for (const v of candidates) {
      const subs  = parseInt(v.channel_size || '0');
      const views = parseInt(v.views_total  || '0');
      if (!subs) continue;
      const ratio = views / subs;
      // Threshold: ratio ≥ 1.0 (video got views equal to 100% of channel subs) OR
      //            ratio ≥ 0.5 AND (perf_score > 70 OR intro_score > 75)
      const isHighPerformer = ratio >= 1.0 ||
        (ratio >= 0.5 && (v.perf_score > 70 || v.intro_score > 75));

      if (isHighPerformer) {
        await q(
          `INSERT INTO video_workspaces (video_id, workspace_id, added_by)
           VALUES ($1,$2,'auto-tag') ON CONFLICT DO NOTHING`,
          [v.video_id, ws.id]
        );
        tagged++;
        console.log(`[cron] autoTag: tagged ${v.video_id} (ratio=${ratio.toFixed(2)}, perf=${v.perf_score})`);
      }
    }

    if (tagged > 0) {
      await notify(
        'auto_tag',
        `🏆 ${tagged} video${tagged>1?'s':''} auto-tagged as High Performers`,
        `${tagged} new video${tagged>1?'s':''} met the high-performer threshold (views/sub ≥ 1.0 or ≥ 0.5 with strong scores) and ${tagged>1?'were':'was'} added to the High Performers workspace.`,
        { count: tagged, workspace_id: ws.id }
      );
    }
    console.log(`[cron] autoTag done — ${tagged} tagged`);
  } catch (e) {
    console.error('[cron] autoTag error:', e.message);
  }
}

// ── Job 7: Competitor alert ────────────────────────────────────
// If a watchlist channel's recent video 2× outperforms their 30d average
// views/sub ratio, create a notification.

async function runCompetitorAlert() {
  if (!YT_KEY) return;
  console.log('[cron] competitorAlert — checking watchlist channels...');
  try {
    const channels = await q('SELECT * FROM channel_monitor WHERE active=1');
    if (!channels.length) return;

    for (const ch of channels) {
      try {
        // Get channel's 30d average views/sub ratio from our DB
        const avgRow = await one(`
          SELECT AVG(CAST(views_total AS BIGINT)::float / NULLIF(CAST(channel_size AS BIGINT), 0)) AS avg_ratio,
                 COUNT(*) AS cnt
          FROM videos
          WHERE channel_id = $1
            AND published_at >= (NOW() - INTERVAL '30 days')::date::text
            AND channel_size <> '0'
        `, [ch.channel_id]);

        const avgRatio = parseFloat(avgRow?.avg_ratio || '0');
        const cnt = parseInt(avgRow?.cnt || '0');
        // Need at least 3 videos to establish a meaningful baseline
        if (!avgRatio || cnt < 3) continue;

        // Check their most recent video (added in last 48h)
        const recent = await one(`
          SELECT video_id, video_title, views_total, channel_size
          FROM videos
          WHERE channel_id = $1
            AND created_at >= NOW() - INTERVAL '48 hours'
          ORDER BY created_at DESC
          LIMIT 1
        `, [ch.channel_id]);

        if (!recent) continue;

        const subs  = parseInt(recent.channel_size || '0');
        const views = parseInt(recent.views_total  || '0');
        if (!subs) continue;

        const recentRatio = views / subs;
        const multiplier  = avgRatio > 0 ? recentRatio / avgRatio : 0;

        if (multiplier >= 2) {
          // Check we haven't already notified for this video
          const alreadyNotified = await one(
            `SELECT 1 FROM notifications WHERE type='competitor_alert' AND meta::json->>'video_id'=$1`,
            [recent.video_id]
          );
          if (alreadyNotified) continue;

          console.log(`[cron] competitorAlert: ${ch.channel_name} breakout — ${recent.video_id} is ${multiplier.toFixed(1)}× avg`);
          await notify(
            'competitor_alert',
            `⚡ Breakout: ${ch.channel_name}`,
            `"${recent.video_title}" is performing ${multiplier.toFixed(1)}× above their 30-day average (${recentRatio.toFixed(2)} vs avg ${avgRatio.toFixed(2)} views/sub). This could signal a trending format worth studying.`,
            { video_id: recent.video_id, channel_id: ch.channel_id, channel_name: ch.channel_name, multiplier, recent_ratio: recentRatio, avg_ratio: avgRatio }
          );
        }
      } catch (e) {
        console.error(`[cron] competitorAlert error for ${ch.channel_name}:`, e.message);
      }
      await sleep(200);
    }
    console.log('[cron] competitorAlert done');
  } catch (e) {
    console.error('[cron] competitorAlert error:', e.message);
  }
}

// ── Job 8: Trend detection (weekly) ───────────────────────────
// Finds title words/formats whose avg perf_score increased vs the prior week.
// Runs on Sunday 04:00 UTC.

async function runTrendDetection() {
  console.log('[cron] trendDetection — scanning title patterns...');
  try {
    // Compare videos published this week vs last week by format
    const formatTrends = await q(`
      SELECT
        format,
        AVG(CASE WHEN published_at >= (NOW() - INTERVAL '7 days')::date::text  THEN perf_score END) AS this_week,
        AVG(CASE WHEN published_at >= (NOW() - INTERVAL '14 days')::date::text
                  AND published_at <  (NOW() - INTERVAL '7 days')::date::text  THEN perf_score END) AS last_week,
        COUNT(CASE WHEN published_at >= (NOW() - INTERVAL '7 days')::date::text THEN 1 END) AS this_week_count
      FROM videos
      WHERE published_at >= (NOW() - INTERVAL '14 days')::date::text
        AND format <> '' AND format <> 'other'
        AND perf_score > 0
      GROUP BY format
      HAVING COUNT(*) >= 3
    `);

    // Find trending words in titles (simple tokenization)
    const wordTrends = await q(`
      WITH words AS (
        SELECT
          LOWER(REGEXP_REPLACE(w, '[^a-z0-9]', '', 'g')) AS word,
          perf_score,
          published_at
        FROM videos,
        LATERAL UNNEST(STRING_TO_ARRAY(video_title, ' ')) AS w
        WHERE published_at >= (NOW() - INTERVAL '14 days')::date::text
          AND perf_score > 0
          AND LENGTH(w) >= 4
      )
      SELECT
        word,
        AVG(CASE WHEN published_at >= (NOW() - INTERVAL '7 days')::date::text  THEN perf_score END) AS this_week,
        AVG(CASE WHEN published_at >= (NOW() - INTERVAL '14 days')::date::text
                  AND published_at <  (NOW() - INTERVAL '7 days')::date::text  THEN perf_score END) AS last_week,
        COUNT(CASE WHEN published_at >= (NOW() - INTERVAL '7 days')::date::text THEN 1 END) AS this_week_count
      FROM words
      WHERE word <> '' AND word NOT IN ('with','that','this','from','have','your','been','will','they','what','when','which','were','into','than','then','them','some','more','also','just','like','only','can','but','and','not','for','the','are','was','all','its')
      GROUP BY word
      HAVING COUNT(*) >= 3
      ORDER BY (COALESCE(this_week,0) - COALESCE(last_week,0)) DESC
      LIMIT 20
    `);

    // Build trend report
    const risingFormats = formatTrends
      .filter(r => r.this_week && r.last_week && r.this_week > r.last_week)
      .map(r => ({ name: r.format, delta: (r.this_week - r.last_week).toFixed(1), count: r.this_week_count }))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 5);

    const risingWords = wordTrends
      .filter(r => r.this_week && r.last_week && r.this_week > r.last_week && r.this_week_count >= 2)
      .map(r => ({ word: r.word, delta: (r.this_week - r.last_week).toFixed(1) }))
      .slice(0, 10);

    if (!risingFormats.length && !risingWords.length) {
      console.log('[cron] trendDetection — not enough data for trends yet');
      return;
    }

    const fmtList  = risingFormats.map(f => `${f.name} (+${f.delta} pts, ${f.count} videos)`).join(' · ');
    const wordList = risingWords.map(w => `"${w.word}" (+${w.delta} pts)`).join(' · ');

    let body = '';
    if (fmtList)  body += `Rising formats this week: ${fmtList}. `;
    if (wordList) body += `Trending title words: ${wordList}.`;

    await notify(
      'trend',
      `📈 Weekly trend report — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      body.trim(),
      { rising_formats: risingFormats, rising_words: risingWords }
    );

    console.log(`[cron] trendDetection done — ${risingFormats.length} format trends, ${risingWords.length} word trends`);
  } catch (e) {
    console.error('[cron] trendDetection error:', e.message);
  }
}

// ── Job 9: Dead video pruning ─────────────────────────────────
// Videos older than 30 days with views/sub ratio < 0.1 are flagged
// with perf_label='pruned' and removed from the master workspace
// (NOT deleted from DB — data is preserved for analysis).

async function runDeadVideoPruning() {
  console.log('[cron] deadVideoPruning — scanning for underperformers...');
  try {
    const dead = await q(`
      SELECT v.video_id, v.video_title, v.channel_name, v.views_total, v.channel_size
      FROM videos v
      WHERE v.published_at <= (NOW() - INTERVAL '30 days')::date::text
        AND v.channel_size <> '0' AND v.channel_size <> ''
        AND v.views_total <> '0'
        AND v.perf_label <> 'pruned'
        AND (CAST(v.views_total AS BIGINT)::float / NULLIF(CAST(v.channel_size AS BIGINT), 0)) < 0.1
      LIMIT 100
    `);

    if (!dead.length) {
      console.log('[cron] deadVideoPruning — no dead videos found');
      return;
    }

    const ids = dead.map(v => v.video_id);
    const master = await one('SELECT id FROM workspaces WHERE is_master=1');

    // Flag in videos table
    for (const id of ids) {
      await q(`UPDATE videos SET perf_label='pruned', updated_at=NOW() WHERE video_id=$1`, [id]);
    }

    // Remove from master workspace only (keep in other workspaces)
    if (master) {
      for (const id of ids) {
        await q(
          `DELETE FROM video_workspaces WHERE video_id=$1 AND workspace_id=$2`,
          [id, master.id]
        );
      }
    }

    await notify(
      'dead_pruned',
      `🗑️ Dead video pruning: ${dead.length} video${dead.length > 1 ? 's' : ''} removed from master`,
      `${dead.length} video${dead.length > 1 ? 's' : ''} older than 30 days with a views/sub ratio below 0.1 ${dead.length > 1 ? 'were' : 'was'} flagged as "pruned" and removed from the master workspace. Data is preserved for analysis.`,
      { count: dead.length, video_ids: ids.slice(0, 20) }
    );

    console.log(`[cron] deadVideoPruning done — ${dead.length} videos pruned`);
  } catch (e) {
    console.error('[cron] deadVideoPruning error:', e.message);
  }
}

// ── Job 10: Weekly analytics summary (AI-generated) ───────────
// Runs every Sunday 05:00 UTC. Pulls week's stats, asks Claude to
// write a short assessment, stores as 'weekly_summary' notification.

async function runWeeklySummary() {
  console.log('[cron] weeklySummary — generating...');
  try {
    // Gather this week's data
    const [videoStats, topVideos, formatBreakdown, channelStats] = await Promise.all([
      // Overall stats for the week
      one(`
        SELECT
          COUNT(*)                                                        AS total_videos,
          COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) AS new_this_week,
          ROUND(AVG(perf_score)::numeric, 1)                              AS avg_perf_score,
          ROUND(AVG(intro_score)::numeric, 1)                             AS avg_intro_score,
          COUNT(CASE WHEN perf_label='spike'  THEN 1 END)                AS spikes,
          COUNT(CASE WHEN perf_label='pruned' THEN 1 END)                AS pruned
        FROM videos
      `),
      // Top 5 performers this week by perf_score
      q(`
        SELECT video_title, channel_name, perf_score, views_total, channel_size
        FROM videos
        WHERE created_at >= NOW() - INTERVAL '7 days'
          AND perf_score > 0
        ORDER BY perf_score DESC LIMIT 5
      `),
      // Format breakdown this week
      q(`
        SELECT format, COUNT(*) AS cnt,
               ROUND(AVG(perf_score)::numeric, 1) AS avg_score
        FROM videos
        WHERE created_at >= NOW() - INTERVAL '7 days'
          AND format <> '' AND perf_score > 0
        GROUP BY format ORDER BY avg_score DESC
      `),
      // Channels added this week
      q(`
        SELECT channel_name, COUNT(*) AS videos_added
        FROM videos
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY channel_name ORDER BY videos_added DESC LIMIT 5
      `),
    ]);

    const weekDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // Build context for AI
    const topVideosList = topVideos.map((v, i) =>
      `${i+1}. "${v.video_title}" by ${v.channel_name} — perf_score ${v.perf_score}, ${v.views_total} views`
    ).join('\n');

    const formatList = formatBreakdown.map(f =>
      `${f.format}: ${f.cnt} videos, avg score ${f.avg_score}`
    ).join(', ');

    const channelList = channelStats.map(c =>
      `${c.channel_name} (${c.videos_added} videos)`
    ).join(', ');

    const statsBlock = `
Week ending ${weekDate}:
- Total videos in library: ${videoStats?.total_videos || 0}
- New videos harvested this week: ${videoStats?.new_this_week || 0}
- Library avg performance score: ${videoStats?.avg_perf_score || 'N/A'}/100
- Library avg intro score: ${videoStats?.avg_intro_score || 'N/A'}/100
- Velocity spikes detected: ${videoStats?.spikes || 0}
- Videos pruned (underperformers): ${videoStats?.pruned || 0}

Top performers this week:
${topVideosList || 'None yet'}

Format breakdown: ${formatList || 'N/A'}
Most active channels: ${channelList || 'N/A'}
    `.trim();

    let summaryBody = statsBlock; // fallback if no AI key

    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const prompt = `You are an analyst for Ashborn Studios, a Minecraft YouTube content strategy agency. You monitor competitor videos to identify winning formats and patterns.

Here is this week's data from the Content Lab:

${statsBlock}

Write a concise weekly assessment (150-200 words) covering:
1. What the data says about the week — standout performers and why they likely succeeded
2. Format/formula trends worth paying attention to
3. One specific, actionable recommendation for content strategy this week

Write in a direct, analytical tone. No fluff. Focus on patterns and implications.`;

        const aiRes = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: AI_MODEL,
            max_tokens: 400,
            system: 'You are a content strategy analyst. Write clearly and concisely.',
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const aiData = await aiRes.json();
        const aiText = aiData.content?.find(c => c.type === 'text')?.text;
        if (aiText) summaryBody = aiText;
      } catch (e) {
        console.error('[cron] weeklySummary AI call failed, using raw stats:', e.message);
      }
    }

    await notify(
      'weekly_summary',
      `📊 Weekly Report — ${weekDate}`,
      summaryBody,
      {
        new_this_week: videoStats?.new_this_week || 0,
        total_videos: videoStats?.total_videos || 0,
        spikes: videoStats?.spikes || 0,
        pruned: videoStats?.pruned || 0,
      }
    );

    console.log('[cron] weeklySummary done');
  } catch (e) {
    console.error('[cron] weeklySummary error:', e.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────

function msUntilNext(targetHourUTC) {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(targetHourUTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleTwiceDaily(job, name) {
  setTimeout(() => { job(); setInterval(job, 12*60*60*1000).unref(); }, msUntilNext(6)).unref();
  setTimeout(() => { job(); setInterval(job, 12*60*60*1000).unref(); }, msUntilNext(18)).unref();
  const n6  = new Date(Date.now() + msUntilNext(6));
  const n18 = new Date(Date.now() + msUntilNext(18));
  console.log(`[cron] ${name} scheduled → ${n6.toISOString()} and ${n18.toISOString()}`);
}

function scheduleDaily(job, name, hourUTC = 2) {
  setTimeout(() => { job(); setInterval(job, 24*60*60*1000).unref(); }, msUntilNext(hourUTC)).unref();
  const next = new Date(Date.now() + msUntilNext(hourUTC));
  console.log(`[cron] ${name} scheduled → ${next.toISOString()}`);
}

// Schedule something to run weekly on a specific day/hour UTC.
// dayOfWeek: 0=Sun, 1=Mon ... 6=Sat
function scheduleWeekly(job, name, dayOfWeek, hourUTC) {
  function msUntilWeekly() {
    const now  = new Date();
    const next = new Date(now);
    next.setUTCHours(hourUTC, 0, 0, 0);
    const daysUntil = ((dayOfWeek - now.getUTCDay()) + 7) % 7 || 7;
    next.setUTCDate(next.getUTCDate() + (daysUntil === 7 && next <= now ? 7 : daysUntil));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
    return next.getTime() - now.getTime();
  }
  function loop() {
    job();
    setTimeout(loop, 7 * 24 * 60 * 60 * 1000).unref();
  }
  setTimeout(loop, msUntilWeekly()).unref();
  const next = new Date(Date.now() + msUntilWeekly());
  console.log(`[cron] ${name} scheduled weekly → ${next.toISOString()}`);
}

// ── Exported init ─────────────────────────────────────────────

function startCron() {
  if (!YT_KEY) {
    console.warn('[cron] YOUTUBE_API_KEY not set — all cron jobs will be skipped. Add it in Railway → Variables.');
    return;
  }

  // Velocity tick — every 5 minutes
  setInterval(velocityTick, 5 * 60 * 1000).unref();
  velocityTick(); // also run immediately on boot to catch any missed snapshots

  scheduleTwiceDaily(runStatsRefresh,   'statsRefresh');
  scheduleTwiceDaily(runChannelMonitor, 'channelMonitor');
  scheduleDaily(runAutoHarvest,         'autoHarvest',         2);  // 02:00 UTC daily
  scheduleDaily(runAutoTag,             'autoTag',             3);  // 03:00 UTC daily
  scheduleDaily(runCompetitorAlert,     'competitorAlert',     7);  // 07:00 UTC daily
  scheduleDaily(runDeadVideoPruning,    'deadVideoPruning',    23); // 23:00 UTC daily
  scheduleWeekly(runTrendDetection,     'trendDetection',      0,  4); // Sunday 04:00 UTC
  scheduleWeekly(runWeeklySummary,      'weeklySummary',       0,  5); // Sunday 05:00 UTC
  console.log('[cron] background jobs initialized (5 automation + weekly summary active)');
}

module.exports = {
  startCron,
  runStatsRefresh,
  runChannelMonitor,
  runAutoHarvest,
  runAutoTag,
  runCompetitorAlert,
  runDeadVideoPruning,
  runTrendDetection,
  runWeeklySummary,
  scheduleVelocitySnapshots,
  captureVelocity,
};
