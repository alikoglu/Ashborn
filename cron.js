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
    for (const row of due) {
      await captureVelocity(row.video_id, row.snapshot_type);
      await q('UPDATE velocity_schedule SET done=1 WHERE id=$1', [row.id]);
      await sleep(200);
    }
    if (due.length) console.log(`[cron] velocityTick — captured ${due.length} snapshots`);
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

      // Check channel sub count against constraint
      if (cfg.min_channel_subs > 0) {
        const cData = await ytFetch(
          `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${ch.channel_id}&key=${YT_KEY}`
        );
        const subs = parseInt(cData.items?.[0]?.statistics?.subscriberCount || '0');
        if (subs < cfg.min_channel_subs) {
          console.log(`[cron] autoHarvest skip channel ${ch.channel_name} — subs ${subs} < ${cfg.min_channel_subs}`);
          continue;
        }
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
        if (views < cfg.min_views) { totalSkipped++; continue; }

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
  scheduleDaily(runAutoHarvest,         'autoHarvest', 2); // 02:00 UTC daily
  console.log('[cron] background jobs initialized');
}

module.exports = {
  startCron,
  runStatsRefresh,
  runChannelMonitor,
  runAutoHarvest,
  scheduleVelocitySnapshots,
  captureVelocity,
};
