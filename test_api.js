// Integration tests against the running server (node test_api.js)
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, extra); }
};
const api = async (method, path, body, token) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
};

const fullVideo = (id, extra = {}) => ({
  video_id: id, video_link: 'https://www.youtube.com/watch?v=' + id,
  video_title: "I Survived 100 Days & Tested O'Brien's <Trick>", channel_name: "O'Brien Craft", channel_id: 'ch1',
  published_at: '2026-06-01', thumbnail_url: 'https://i.ytimg.com/vi/' + id + '/hq720.jpg',
  views_total: '250000', likes: '12000', comments: '800', channel_size: '50000', channel_avg_views: 100000,
  title_length: 40, has_number: true, has_question: false, has_timeframe: true, has_difficulty: false,
  has_money: false, starts_with_i: true, all_caps_words: 0, is_series: false, is_collab: false,
  clickbait_score: 20, format: 'challenge', formula: '"X Days" survival', number_of_tags: 3,
  tags: ['minecraft', '100 days', 'hardcore'], video_length: '12:34', video_length_secs: 754,
  face_emotion: 'happy', character_present: 'yes', minecraft_skin_visible: 'yes', arrows_circles: 'no',
  text_present: 'yes', dominant_color: 'orange', clarity_score: '8', thumbnail_style: 'face-close-up',
  thumbnail_background: 'jungle', thumbnail_contrast: 'high', thumbnail_has_before_after: 'no',
  thumbnail_num_faces: '1', thumbnail_has_item: 'yes', composition_notes: 'Strong focal point',
  thumbnail_text: '100 DAYS', views_per_sub: '5.00', log_views: '5.4', like_rate: '4.80%',
  comment_rate: '0.32%', engagement: '5.12%', packaging: 75, perf_label: 'Overperforming', perf_score: 2.5,
  days_since_published: '67', views_per_day: '3.7K/day', like_to_comment_ratio: '15.0', relative_perf_index: '2.50x',
  ...extra,
});

(async () => {
  // ── Mock Anthropic API on :4999 ──
  const http = require('http');
  const mockSrv = http.createServer((req, resp) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      const userText = JSON.stringify(b.messages || '');
      if (userText.includes('TRIGGER_ERROR')) {
        resp.writeHead(401, { 'Content-Type': 'application/json' });
        return resp.end(JSON.stringify({ error: { message: 'mock bad key' } }));
      }
      const isIntro = (b.system || '').includes('intros');
      const text = isIntro
        ? JSON.stringify({ hook_type: 'result-first', result_shown_first: 'yes', goal_stated_early: 'yes', opening_line: 'This is day one', tension_present: 'yes', face_on_camera: 'no', pacing: 'fast', voice_style: 'hype', music_present: 'yes', thumbnail_callback: 'yes', intro_score: 82, analysis: 'Strong result-first hook.' })
        : 'Mock reply from AI';
      resp.writeHead(200, { 'Content-Type': 'application/json' });
      resp.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    });
  });
  await new Promise(r => mockSrv.listen(4999, r));
  console.log('── Auth ──');
  let r = await api('POST', '/auth/login', { username: 'thifrus', password: 'wrongpass' });
  ok('wrong password → 401', r.status === 401);
  r = await api('POST', '/auth/login', { username: 'THIFRUS ', password: 'ashborn2025' });
  ok('login (case/space tolerant) → 200 + token', r.status === 200 && !!r.data.token);
  ok('login returns user shape', r.data.user?.username === 'thifrus' && r.data.user?.role === 'admin' && r.data.user?.daily_ai_limit === 50);
  ok('login returns master workspace w/ video_count + permission', r.data.workspaces?.[0]?.id === 'master001' && r.data.workspaces[0].video_count === 0 && r.data.workspaces[0].permission === 'delete');
  const adminTok = r.data.token;

  r = await api('GET', '/auth/me');
  ok('/auth/me without token → 401', r.status === 401);
  r = await api('GET', '/auth/me', null, adminTok);
  ok('/auth/me with token → user + workspaces', r.status === 200 && r.data.user.id === 'admin001' && Array.isArray(r.data.workspaces));

  console.log('── Admin: users ──');
  r = await api('POST', '/admin/users', { username: 'Editor1', password: 'editorpass99', role: 'editor', daily_ai_limit: 10 }, adminTok);
  ok('create editor', r.status === 200 && r.data.user.username === 'editor1');
  const editorId = r.data.user.id;
  r = await api('POST', '/admin/users', { username: 'viewer1', password: 'viewerpass99', role: 'viewer', daily_ai_limit: 0 }, adminTok);
  ok('create viewer (ai limit 0)', r.status === 200);
  const viewerId = r.data.user.id;
  r = await api('POST', '/admin/users', { username: 'editor1', password: 'whatever99' }, adminTok);
  ok('duplicate username rejected', r.status === 400 && /exists/.test(r.data.error));
  r = await api('POST', '/admin/users', { username: 'shorty', password: 'short' }, adminTok);
  ok('short password rejected', r.status === 400);
  r = await api('GET', '/admin/users', null, adminTok);
  ok('list users (3)', r.status === 200 && r.data.users.length === 3);

  r = await api('POST', '/auth/login', { username: 'editor1', password: 'editorpass99' });
  const editorTok = r.data.token;
  ok('editor login', r.status === 200 && !!editorTok);
  r = await api('POST', '/auth/login', { username: 'viewer1', password: 'viewerpass99' });
  const viewerTok = r.data.token;
  ok('viewer login', r.status === 200);
  r = await api('GET', '/admin/users', null, editorTok);
  ok('editor blocked from admin routes → 403', r.status === 403);

  console.log('── Workspaces ──');
  r = await api('POST', '/workspaces', { name: "Sbeev's Hooks", icon: '🎮', description: 'test' }, editorTok);
  ok('editor creates workspace', r.status === 200 && r.data.workspace.permission === 'delete');
  const wsId = r.data.workspace.id;
  r = await api('POST', '/workspaces', { name: 'x' }, viewerTok);
  ok('viewer cannot create workspace → 403', r.status === 403);

  console.log('── Videos: upsert + intro preservation ──');
  r = await api('POST', '/videos', {
    video: fullVideo('vidAAA0001', { intro_hook_type: 'result-first', intro_score: 82, intro_opening_line: 'This is day one', intro_transcript: 'This is day one of one hundred', intro_result_shown: 'yes', intro_pacing: 'fast', intro_voice_style: 'hype', intro_music: 'yes', intro_tension: 'yes', intro_goal_stated: 'yes', intro_face_on_camera: 'no', intro_thumbnail_callback: 'yes' }),
    workspace_ids: [wsId],
  }, editorTok);
  ok('editor saves video w/ intro', r.status === 200 && r.data.video_id === 'vidAAA0001');
  r = await api('POST', '/videos', { video: fullVideo('vidBBB0002'), workspace_ids: [] }, viewerTok);
  ok('viewer cannot save video → 403', r.status === 403);

  // Re-save with updated views + EMPTY intro fields → intro must be preserved
  r = await api('POST', '/videos', { video: fullVideo('vidAAA0001', { views_total: '300000' }), workspace_ids: [] }, editorTok);
  ok('re-save (cache refresh) OK', r.status === 200);
  r = await api('GET', '/videos/check/vidAAA0001', null, editorTok);
  ok('check exists + views updated', r.data.exists === true && r.data.video.views_total === '300000');
  ok('intro fields preserved after empty re-save', r.data.video.intro_hook_type === 'result-first' && r.data.video.intro_score === 82 && r.data.video.intro_opening_line === 'This is day one');
  ok('tags stored as JSON string', r.data.video.tags === JSON.stringify(['minecraft', '100 days', 'hardcore']));
  r = await api('GET', '/videos/check/nonexistent0', null, editorTok);
  ok('check missing → exists:false', r.data.exists === false && r.data.video === null);

  console.log('── Workspace videos + permissions ──');
  r = await api('GET', '/workspaces/master001/videos', null, editorTok);
  ok('editor sees master (1 video, auto-linked)', r.status === 200 && r.data.count === 1 && r.data.workspace.is_master === 1);
  r = await api('GET', '/workspaces/master001/videos', null, viewerTok);
  ok('viewer blocked from master → 403', r.status === 403);
  r = await api('GET', `/workspaces/${wsId}/videos`, null, editorTok);
  ok('workspace has linked video', r.status === 200 && r.data.count === 1);
  r = await api('GET', `/workspaces/${wsId}/videos`, null, viewerTok);
  ok('non-member viewer blocked → 403', r.status === 403);
  r = await api('GET', `/workspaces/${wsId}/videos?search=survived`, null, editorTok);
  ok('ILIKE search works (case-insensitive)', r.status === 200 && r.data.count === 1);
  r = await api('GET', `/workspaces/${wsId}/videos?format=speedrun`, null, editorTok);
  ok('format filter works', r.status === 200 && r.data.count === 0);

  console.log('── Route shadowing fix ──');
  r = await api('DELETE', `/workspaces/${wsId}/videos/vidAAA0001`, null, editorTok);
  ok('remove video from workspace → success', r.status === 200 && r.data.success === true);
  r = await api('GET', `/workspaces/${wsId}/videos`, null, editorTok);
  ok('workspace still EXISTS after video removal (bug fixed)', r.status === 200 && r.data.count === 0 && r.data.workspace.name === "Sbeev's Hooks");
  r = await api('GET', '/workspaces/master001/videos', null, editorTok);
  ok('video still in master', r.data.count === 1);
  r = await api('DELETE', '/workspaces/master001/videos/vidAAA0001', null, adminTok);
  ok('cannot remove from master → 400', r.status === 400);

  console.log('── Stats ──');
  r = await api('GET', '/stats', null, editorTok);
  ok('global stats', r.status === 200 && r.data.total === 1 && r.data.avg_views === 300000 && r.data.top_format === 'challenge' && r.data.viral_count === 1);
  r = await api('GET', `/stats?workspace=${wsId}`, null, editorTok);
  ok('workspace stats (empty after removal)', r.status === 200 && r.data.total === 0);

  console.log('── Admin: workspace access ──');
  r = await api('GET', '/admin/workspaces', null, adminTok);
  ok('admin sees ALL workspaces incl other users\'', r.status === 200 && r.data.workspaces.length === 2);
  const sbeevWs = r.data.workspaces.find(w => w.id === wsId);
  ok('members listed with usernames', sbeevWs.members.length === 1 && sbeevWs.members[0].username === 'editor1');
  r = await api('POST', `/admin/workspaces/${wsId}/members`, { user_id: viewerId, permission: 'view' }, adminTok);
  ok('grant viewer access', r.status === 200);
  r = await api('GET', `/workspaces/${wsId}/videos`, null, viewerTok);
  ok('viewer can now see workspace', r.status === 200);
  r = await api('POST', `/admin/workspaces/${wsId}/members`, { user_id: viewerId, permission: 'edit' }, adminTok);
  ok('upsert changes permission', r.status === 200);
  r = await api('GET', '/admin/workspaces', null, adminTok);
  ok('permission now edit', r.data.workspaces.find(w => w.id === wsId).members.find(m => m.user_id === viewerId)?.permission === 'edit');
  r = await api('DELETE', `/admin/workspaces/${wsId}/members/${viewerId}`, null, adminTok);
  ok('revoke access', r.status === 200);
  r = await api('GET', `/workspaces/${wsId}/videos`, null, viewerTok);
  ok('viewer blocked again after revoke', r.status === 403);
  r = await api('GET', '/admin/workspaces', null, editorTok);
  ok('editor blocked from admin workspace list', r.status === 403);

  console.log('── AI (mock Anthropic on :4999) ──');
  r = await api('POST', '/ai', { messages: [{ role: 'user', content: 'hi' }] }, viewerTok);
  ok('viewer w/ limit 0 → 429 before Anthropic call', r.status === 429);
  r = await api('POST', '/analyze-intro', { transcript: 'hello world' }, viewerTok);
  ok('analyze-intro also blocked at limit 0 → 429', r.status === 429);
  r = await api('POST', '/ai', { messages: [{ role: 'user', content: 'hi' }], system: 'You are a Minecraft analyst.' }, editorTok);
  ok('/ai happy path: reply + usage', r.status === 200 && r.data.reply === 'Mock reply from AI' && r.data.usage.used === 1 && r.data.usage.limit === 10, JSON.stringify(r.data).slice(0, 120));
  r = await api('POST', '/ai', { messages: [{ role: 'user', content: 'again' }] }, editorTok);
  ok('usage increments', r.data.usage?.used === 2);
  r = await api('POST', '/analyze-intro', { transcript: 'This is day one of one hundred days', title: 'Test', channel: 'Ch', views: '100' }, editorTok);
  ok('/analyze-intro happy path: parsed fields + usage', r.status === 200 && r.data.hook_type === 'result-first' && r.data.intro_score === 82 && r.data.usage.used === 3, JSON.stringify(r.data).slice(0, 140));
  r = await api('POST', '/ai', { messages: [{ role: 'user', content: 'TRIGGER_ERROR' }] }, editorTok);
  ok('Anthropic error → 502 with message', r.status === 502 && /mock bad key/.test(r.data.error));
  r = await api('POST', '/ai', { notmessages: true }, editorTok);
  ok('missing messages → 400', r.status === 400);

  console.log('── Change password ──');
  r = await api('POST', '/auth/change-password', { current_password: 'wrong', new_password: 'newpassword123' }, editorTok);
  ok('wrong current password → 401', r.status === 401);
  r = await api('POST', '/auth/change-password', { current_password: 'editorpass99', new_password: 'newpassword123' }, editorTok);
  ok('change password success', r.status === 200);
  r = await api('POST', '/auth/login', { username: 'editor1', password: 'newpassword123' });
  ok('new password works', r.status === 200);
  r = await api('POST', '/auth/login', { username: 'editor1', password: 'editorpass99' });
  ok('old password dead', r.status === 401);

  console.log('── Workspace deletion + cascade ──');
  r = await api('DELETE', `/workspaces/${wsId}`, null, viewerTok);
  ok('non-member cannot delete workspace', r.status === 403);
  const r2 = await api('POST', '/auth/login', { username: 'editor1', password: 'newpassword123' });
  r = await api('DELETE', `/workspaces/${wsId}`, null, r2.data.token);
  ok('owner deletes workspace', r.status === 200);
  r = await api('DELETE', '/workspaces/master001', null, adminTok);
  ok('cannot delete master', r.status === 400);

  console.log('── Admin: delete user ──');
  r = await api('DELETE', `/admin/users/admin001`, null, adminTok);
  ok('cannot delete self', r.status === 400);
  r = await api('DELETE', `/admin/users/${viewerId}`, null, adminTok);
  ok('delete viewer', r.status === 200);
  r = await api('POST', '/auth/login', { username: 'viewer1', password: 'viewerpass99' });
  ok('deleted user cannot login', r.status === 401);

  console.log('── Static + misc ──');
  let raw = await fetch(BASE + '/', { redirect: 'manual' });
  ok('/ redirects to /app.html', raw.status === 302 && raw.headers.get('location') === '/app.html');
  raw = await fetch(BASE + '/app.html');
  const html = await raw.text();
  ok('app.html served, points at Railway', raw.status === 200 && html.includes('ashborn-production.up.railway.app'));
  r = await api('GET', '/nonexistent-route', null, adminTok);
  ok('unknown route → JSON 404', r.status === 404 && r.data.error === 'Not found');
  raw = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken json' });
  ok('malformed JSON → 400 Invalid JSON', raw.status === 400 && (await raw.json()).error === 'Invalid JSON');
  raw = await fetch(BASE + '/health');
  const cors = raw.headers.get('access-control-allow-origin');
  ok('CORS header present', cors === '*');
  raw = await fetch(BASE + '/auth/login', { method: 'OPTIONS' });
  ok('OPTIONS preflight → 204', raw.status === 204);

  console.log('── Login rate limiting ──');
  let limited = false;
  for (let i = 0; i < 10; i++) {
    const rr = await api('POST', '/auth/login', { username: 'thifrus', password: 'bad' + i });
    if (rr.status === 429) { limited = true; break; }
  }
  ok('brute force triggers 429', limited);

  mockSrv.close();
  console.log(`\n${fail === 0 ? '═══ ALL PASSED' : '═══ FAILURES: ' + fail} (${pass} passed) ═══`);
  process.exit(fail === 0 ? 0 : 1);
})();
