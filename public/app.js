const $ = id => document.getElementById(id);
let session, history = [], sending = false;
const errors = {
  invalid_oauth_state: 'การเชื่อมต่อหมดอายุหรือไม่ตรงกับเบราว์เซอร์นี้ กรุณาเริ่มเชื่อมต่อ WHOOP ใหม่',
  authorization_denied: 'คุณยังไม่ได้อนุญาตให้เข้าถึง WHOOP ลองเชื่อมต่ออีกครั้งได้',
  account_not_allowed: 'บัญชีนี้ไม่ได้รับอนุญาต กรุณาใช้บัญชี WHOOP ของเจ้าของแอป',
  old_callback: 'กรุณาเปลี่ยน Redirect URI ใน WHOOP Developer App เป็น /auth/whoop/callback บนโดเมนของแอปนี้',
  reconnect_required: 'กรุณาเชื่อมต่อ WHOOP ใหม่เพื่อเข้าถึงข้อมูล', sign_in_required: 'กรุณาเข้าสู่ระบบใหม่',
  csrf_failed: 'เซสชันเปลี่ยนแล้ว กรุณาโหลดหน้าใหม่', scope_missing: 'บัญชีนี้ยังไม่ได้อนุญาตประเภทข้อมูลที่ขอ กรุณาเชื่อมต่อใหม่',
  chat_not_configured: 'ต้องตั้งค่า OPENAI_API_KEY ที่เซิร์ฟเวอร์ก่อนใช้แชต',
  consent_required: 'กรุณายินยอมส่งข้อมูลที่เลือกให้ OpenAI ก่อนส่งคำถาม',
  rate_limited: 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', whoop_rate_limited: 'WHOOP จำกัดคำขอชั่วคราว กรุณาลองภายหลัง',
  ai_unavailable: 'AI ยังตอบไม่ได้ กรุณาตรวจการตั้งค่า API หรือรอสักครู่แล้วลองใหม่',
  whoop_unavailable: 'ติดต่อ WHOOP ไม่ได้ชั่วคราว กรุณาลองอีกครั้ง', invalid_resources: 'เลือกข้อมูลอย่างน้อยหนึ่งประเภท',
  select_shorter_range: 'ข้อมูลมากเกินไป กรุณาเลือกช่วงเวลาที่สั้นลง',
};
function notice(message = '') { $('notice').textContent = message; }
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) { $('workspace').hidden = true; $('signed-out').hidden = false; clearChat(); }
    throw new Error(errors[value.error] || `ทำรายการไม่สำเร็จ (${value.error || response.status})`);
  }
  return value;
}
function range() { const end = new Date(); return { start: new Date(end - Number($('days').value) * 86400000).toISOString(), end: end.toISOString() }; }
function clearChat() { history = []; $('messages').replaceChildren(); $('raw-data').textContent = 'เลือกประเภทข้อมูลเพื่อแสดงผล'; }
function message(role, text, source) {
  $('messages').querySelector('.placeholder')?.remove();
  const el = document.createElement('div'); el.className = `message ${role}`; el.textContent = text;
  if (source) { const small = document.createElement('small'); small.textContent = source; el.append(small); }
  $('messages').append(el); $('messages').scrollTop = $('messages').scrollHeight;
}
async function overview() {
  const query = new URLSearchParams(range());
  await Promise.all(['recovery', 'sleep', 'cycles'].map(async resource => {
    $(resource).textContent = '—'; $(resource + '-date').textContent = 'กำลังโหลด…';
    try {
      const { data } = await api(`/api/whoop/${resource}?${query}`);
      const latest = data.records.find(r => r.score_state === 'SCORED' && r.score);
      const value = resource === 'recovery' ? latest?.score.recovery_score : resource === 'sleep' ? latest?.score.sleep_performance_percentage : latest?.score.strain;
      $(resource).textContent = value == null ? '—' : (resource === 'cycles' ? Number(value).toFixed(1) : `${Math.round(value)}%`);
      $(resource + '-date').textContent = latest ? new Date(latest.start || latest.created_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : 'ยังไม่มีข้อมูลที่ประเมินแล้ว';
    } catch (error) { $(resource + '-date').textContent = error.message; }
  }));
}
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault(); if (sending) return;
  if (!$('consent').checked) return notice(errors.consent_required);
  const question = $('question').value.trim(); if (!question) return;
  const resources = [...document.querySelectorAll('#resources input:checked')].map(el => el.value);
  if (!resources.length) return notice(errors.invalid_resources);
  sending = true; $('send').disabled = true; $('days').disabled = true; $('resources').disabled = true; $('clear').disabled = true;
  notice('กำลังอ่านข้อมูล WHOOP และเตรียมคำตอบ…');
  const messages = [...history.slice(-10), { role: 'user', content: question }];
  try {
    const result = await api('/api/chat', { messages, resources, consent: true, ...range() });
    message('user', question); message('assistant', result.text, `${result.sources.join(' · ')} | ${new Date(result.range.start).toLocaleDateString('th-TH')} – ${new Date(result.range.end).toLocaleDateString('th-TH')}`);
    history = [...messages, { role: 'assistant', content: result.text.slice(0, 4000) }]; $('question').value = '';
    notice(result.incomplete ? 'คำตอบถูกตัดเนื่องจากความยาว ลองถามให้เจาะจงขึ้น' : '');
  } catch (error) { notice(error.message); }
  finally { sending = false; $('send').disabled = false; $('days').disabled = false; $('resources').disabled = false; $('clear').disabled = false; }
});
$('refresh').onclick = () => overview();
$('days').onchange = () => { clearChat(); overview(); };
$('resources').onchange = clearChat;
$('clear').onclick = clearChat;
$('load-data').onclick = async () => { try { const data = await api(`/api/whoop/${$('resource').value}?${new URLSearchParams(range())}`); $('raw-data').textContent = JSON.stringify(data, null, 2); } catch (error) { notice(error.message); } };
for (const action of ['logout', 'disconnect', 'forget']) $(action).onclick = async () => {
  if (action === 'disconnect' && !confirm('ยกเลิกสิทธิ์ WHOOP และลบ token กับเซสชันทั้งหมดของคุณ?')) return;
  if (action === 'forget' && !confirm('ลบ token และเซสชันในแอปเท่านั้น คุณต้องไปยกเลิกสิทธิ์ใน WHOOP ด้วยตนเอง ต้องการดำเนินการต่อหรือไม่?')) return;
  try { await api(`/api/${action}`, {}); location.replace('/'); } catch (error) { notice(error.message); }
};
async function init() {
  const error = new URLSearchParams(location.search).get('error');
  window.history.replaceState({}, '', '/');
  if (error) notice(errors[error] || 'เชื่อมต่อ WHOOP ไม่สำเร็จ กรุณาตรวจการตั้งค่าแล้วลองใหม่');
  try {
    session = await api('/api/session'); $('signed-out').hidden = session.authenticated; $('workspace').hidden = !session.authenticated;
    if (session.authenticated) { if (!session.chatAvailable) notice(errors.chat_not_configured); await overview(); }
  } catch (failure) { notice(failure.message); }
}
init();
