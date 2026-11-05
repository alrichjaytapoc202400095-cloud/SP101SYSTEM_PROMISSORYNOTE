'use strict';

/* =====================================================================
   Promissory Note System — client-only app (data stored in localStorage)
   ---------------------------------------------------------------------
   Flow:
   1. Accounting/Cashier records tuition payments for a student.
   2. Once a student has paid at least 75% of tuition, they may file a
      Promissory Note. The remaining balance is auto-computed = PN amount.
   3. The Registrar gets notified, reviews, then approves/rejects the PN.
   4. On approval the STUDENT is notified right away — enrollment and
      subject enlistment are unlocked.
   ===================================================================== */

const DB_KEY = 'pn_system_v1';
const SESSION_KEY = 'pn_session_v1';
const MIN_PCT = 75;      // minimum % of tuition paid before a PN can be filed
const MAX_UNITS = 24;    // max subject load in units

/* ---------------- tiny helpers ---------------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PHP = (n) => '₱' + (Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* number → words (used on the official receipt, e.g. "Thirteen Thousand Pesos and 00/100") */
function numWords999(n) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const h = Math.floor(n / 100), r = n % 100;
  let s = h ? ones[h] + ' Hundred' : '';
  if (r) s += (s ? ' ' : '') + (r < 20 ? ones[r] : tens[Math.floor(r / 10)] + (r % 10 ? '-' + ones[r % 10] : ''));
  return s;
}
function numberWords(n) {
  if (!n) return 'Zero';
  const M = Math.floor(n / 1e6), K = Math.floor((n % 1e6) / 1e3), U = Math.floor(n % 1e3);
  let s = '';
  if (M) s += numWords999(M) + ' Million';
  if (K) s += (s ? ' ' : '') + numWords999(K) + ' Thousand';
  if (U) s += (s ? ' ' : '') + numWords999(U);
  return s || 'Zero';
}
function pesoWords(n) {
  const int = Math.floor(Number(n) || 0);
  const cents = Math.round(((Number(n) || 0) - int) * 100);
  return numberWords(int) + ' Pesos and ' + String(cents).padStart(2, '0') + '/100';
}
const pad2 = (n) => String(n).padStart(2, '0');
const uid = (p) => p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00') : new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) + ' · ' +
         d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
}
const ROLE_LABEL = { registrar: 'Registrar', accounting: 'Accounting', student: 'Student', admin: 'Admin' };

/* ---------------- database (localStorage) ---------------- */
const DB = {
  data: null,
  init() {
    try { this.data = JSON.parse(localStorage.getItem(DB_KEY) || 'null'); } catch (e) { this.data = null; }
    if (!this.data || !Array.isArray(this.data.users)) this.reset();
  },
  save() { try { localStorage.setItem(DB_KEY, JSON.stringify(this.data)); } catch (e) { console.error('Save failed', e); } },
  reset() { this.data = seedData(); this.save(); }
};

let state = { user: null, bellOpen: false, adminTab: 'overview' };

/* ---------------- finance helpers ---------------- */
const usersOf      = (role) => DB.data.users.filter((u) => u.role === role);
const studentById  = (id) => DB.data.users.find((u) => u.id === id && u.role === 'student') || null;
const paymentsOf   = (sid) => DB.data.payments.filter((p) => p.studentId === sid)
                        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
const paidOf       = (sid) => paymentsOf(sid).reduce((s, p) => s + (Number(p.amount) || 0), 0);
const tuitionOf    = (sid) => Number((studentById(sid) || {}).tuition) || 0;
const pctOf        = (sid) => { const t = tuitionOf(sid); return t > 0 ? (paidOf(sid) / t) * 100 : 0; };
const balanceOf    = (sid) => Math.max(0, tuitionOf(sid) - paidOf(sid));
const paidAtLeast75 = (sid) => paidOf(sid) * 100 >= tuitionOf(sid) * MIN_PCT;
const needFor75    = (sid) => Math.max(0, tuitionOf(sid) * (MIN_PCT / 100) - paidOf(sid));
const isFullyPaid  = (sid) => tuitionOf(sid) > 0 && balanceOf(sid) <= 0;

/* ---------------- PN helpers ---------------- */
const pendingPNOf  = (sid) => DB.data.pns.find((p) => p.studentId === sid && p.status === 'Pending') || null;
const approvedPNOf = (sid) => DB.data.pns.find((p) => p.studentId === sid && p.status === 'Approved') || null;
const latestPNOf   = (sid) => DB.data.pns.filter((p) => p.studentId === sid).pop() || null;
const canFilePN    = (sid) => paidAtLeast75(sid) && !isFullyPaid(sid) && !pendingPNOf(sid) && !approvedPNOf(sid);
const canEnroll    = (sid) => isFullyPaid(sid) || !!approvedPNOf(sid) || !!(studentById(sid) || {}).enrollOverride;

function nextPnNo() {
  const y = new Date().getFullYear();
  const no = 'PN-' + y + '-' + String(DB.data.counters.pn).padStart(4, '0');
  DB.data.counters.pn++;
  return no;
}

/* ---------------- enrollment helpers ---------------- */
function getEnrollment(sid) {
  let e = DB.data.enrollments.find((x) => x.studentId === sid);
  if (!e) {
    e = { id: uid('enr'), studentId: sid, subjects: [], status: 'Not Enrolled',
          sy: '2026–2027', term: '1st Semester', confirmedAt: null };
    DB.data.enrollments.push(e);
    DB.save();
  }
  return e;
}
const subjectById = (id) => DB.data.subjects.find((s) => s.id === id);
const unitsOf = (subIds) => subIds.reduce((sum, id) => sum + ((subjectById(id) || {}).units || 0), 0);

/* ---------------- notifications ---------------- */
function notify(userId, title, msg) {
  DB.data.notifications.push({ id: uid('notif'), toUserId: userId, title, msg, date: new Date().toISOString(), read: false });
  DB.save(); // persist immediately so notifications survive reloads
}
function notifyRole(role, title, msg) {
  usersOf(role).forEach((u) => notify(u.id, title, msg));
  // The Admin supervises every office — keep a copy of staff notifications in the admin bell.
  if (role !== 'admin') usersOf('admin').forEach((u) => notify(u.id, title, msg));
}
const myNotifications = () => DB.data.notifications.filter((n) => n.toUserId === state.user.id).slice().reverse();
function unreadCount() {
  if (!state.user) return 0;
  return DB.data.notifications.filter((n) => n.toUserId === state.user.id && !n.read).length;
}

/* ---------------- toast + modal ---------------- */
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toast-root').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 350); }, 4200);
}
function openModal(html, wide) {
  $('#modal-root').innerHTML =
    '<div class="backdrop" onclick="App.closeModal()">' +
      '<div class="modal ' + (wide ? 'wide' : '') + '" onclick="event.stopPropagation()">' + html + '</div>' +
    '</div>';
}
function closeModal() { $('#modal-root').innerHTML = ''; }

/* ---------------- auth ---------------- */
function doLogin(username, password) {
  const u = DB.data.users.find((x) => x.username.toLowerCase() === String(username).trim().toLowerCase());
  if (!u || u.password !== password) { toast('Invalid username or password.', 'error'); return; }
  state.user = u; state.bellOpen = false;
  sessionStorage.setItem(SESSION_KEY, u.id);
  render();
  toast('Welcome, ' + u.name.split(' ')[0] + '!', 'success');
}
function loginFromForm() { doLogin($('#login-user').value, $('#login-pass').value); }
function quickLogin(username) {
  const u = DB.data.users.find((x) => x.username === username);
  if (!u) return;
  doLogin(username, u.password); // demo accounts: password = username
}
function logout() {
  state.user = null; state.bellOpen = false;
  sessionStorage.removeItem(SESSION_KEY);
  render();
}
function showRegister() {
  const opts = COURSES.map((c) => '<option>' + esc(c) + '</option>').join('');
  const yrs = YEARS.map((y) => '<option>' + esc(y) + '</option>').join('');
  openModal(
    '<h3>New student sign-up</h3>' +
    '<p class="muted small">Your password will be the same as your username (demo setup).</p>' +
    '<div class="field"><label>Full name</label><input id="reg-name" placeholder="e.g. Juan Dela Cruz"></div>' +
    '<div class="field"><label>Student No.</label><input id="reg-no" placeholder="e.g. 2026-00101"></div>' +
    '<div class="field"><label>Course</label><select id="reg-course">' + opts + '</select></div>' +
    '<div class="field"><label>Year level</label><select id="reg-year">' + yrs + '</select></div>' +
    '<div class="field"><label>Username</label><input id="reg-user" placeholder="e.g. juanc"></div>' +
    '<div class="field"><label>Tuition & fees (₱)</label><input id="reg-tuition" type="number" min="1000" step="100" value="30000"></div>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn" onclick="App.doRegister()">Create account</button>' +
    '</div>');
}
function doRegister() {
  const name = ($('#reg-name').value || '').trim();
  const studentNo = ($('#reg-no').value || '').trim();
  const course = $('#reg-course').value;
  const year = $('#reg-year').value;
  const username = ($('#reg-user').value || '').trim().toLowerCase();
  const tuition = Number($('#reg-tuition').value) || 0;

  if (name.length < 3) return toast('Enter the student\'s full name.', 'error');
  if (!studentNo) return toast('Enter the student number.', 'error');
  if (username.length < 3 || !/^[a-z0-9._-]+$/.test(username)) return toast('Username must be 3+ characters (letters/numbers/._-).', 'error');
  if (DB.data.users.some((u) => (u.username || '').toLowerCase() === username)) return toast('Username is already taken.', 'error');
  if (DB.data.users.some((u) => u.role === 'student' && (u.studentNo || '') === studentNo)) return toast('Student number already registered.', 'error');
  if (tuition <= 0) return toast('Enter a valid tuition amount.', 'error');

  const user = { id: uid('u'), role: 'student', name, username, password: username, studentNo, course, year, tuition };
  DB.data.users.push(user);
  DB.save();
  notifyRole('registrar', 'New student registered', name + ' (' + studentNo + ', ' + course + ') created an account with tuition ' + PHP(tuition) + '.');
  closeModal();
  state.user = user; state.bellOpen = false;
  sessionStorage.setItem(SESSION_KEY, user.id);
  render();
  toast('Account created! Your password is your username ("' + username + '").', 'success');
}
function confirmReset() {
  openModal(
    '<h3>Reset demo data?</h3>' +
    '<p class="muted">This erases everything stored in this browser (payments, PNs, notifications, enrollments) and restores the original demo dataset.</p>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn red" onclick="App.doReset()">Reset now</button>' +
    '</div>');
}
function doReset() {
  DB.reset();
  state.user = null; state.bellOpen = false;
  sessionStorage.removeItem(SESSION_KEY);
  closeModal();
  render();
  toast('Demo data restored.', 'success');
}

/* ---------------- bell / notifications ---------------- */
function toggleBell() { state.bellOpen = !state.bellOpen; render(); }
function closeBell() { if (state.bellOpen) { state.bellOpen = false; render(); } }
function markAllRead() {
  DB.data.notifications.forEach((n) => { if (n.toUserId === state.user.id) n.read = true; });
  DB.save();
  render();
}

/* ---------------- PN actions (student) ---------------- */
/* ---------------- PN filing: attached ID photos ---------------- */
const PN_ID_SLOTS = [
  { key: 'studentFront',  label: 'Student School ID — Front' },
  { key: 'studentBack',   label: 'Student School ID — Back' },
  { key: 'guardianFront', label: 'Parent / Guardian Valid ID — Front' },
  { key: 'guardianBack',  label: 'Parent / Guardian Valid ID — Back' }
];
function sampleIdImage(line1, line2) {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const x = c.getContext('2d');
  x.fillStyle = '#1e293b'; x.fillRect(0, 0, 320, 200);
  x.fillStyle = '#334155'; x.fillRect(12, 12, 296, 176);
  x.strokeStyle = '#64748b'; x.setLineDash([6, 6]); x.strokeRect(24, 24, 272, 152);
  x.fillStyle = '#e2e8f0'; x.font = 'bold 17px Segoe UI'; x.textAlign = 'center';
  x.fillText(line1, 160, 112);
  x.fillStyle = '#94a3b8'; x.font = 'bold 12px Segoe UI';
  x.fillText(line2, 160, 132);
  x.font = '10.5px Segoe UI';
  x.fillText('sample — click to upload the real photo', 160, 152);
  return c.toDataURL('image/jpeg', 0.75);
}
function idSlotHTML(sl) {
  return '<div class="id-slot" onclick="App.pickId(\'' + sl.key + '\')">' +
    '<div class="id-label">' + esc(sl.label) + '</div>' +
    '<img class="id-thumb" id="id-prev-' + sl.key + '" src="' + state.pnDraft[sl.key] + '" alt="' + esc(sl.label) + '">' +
    '<div class="id-hint" id="id-hint-' + sl.key + '">⚠️ required — click to upload the actual photo</div>' +
    '<input type="file" accept="image/*" id="id-in-' + sl.key + '" class="f-id-input" onchange="App.handleIdFile(\'' + sl.key + '\', this)">' +
  '</div>';
}
function pickId(slot) {
  const inp = document.getElementById('id-in-' + slot);
  if (inp) inp.click();
}
function handleIdFile(slot, inputEl) {
  const sl = PN_ID_SLOTS.find((x) => x.key === slot) || { label: slot };
  const f = inputEl.files && inputEl.files[0];
  if (!f) return;
  if (!/^image\//.test(f.type)) { toast('Please choose an image file (JPG / PNG).', 'error'); inputEl.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 480 / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      state.pnDraft[slot] = c.toDataURL('image/jpeg', 0.72);
      if (!state.pnDraftReal) state.pnDraftReal = {};
      state.pnDraftReal[slot] = true;
      const prev = document.getElementById('id-prev-' + slot);
      if (prev) prev.src = state.pnDraft[slot];
      const hint = document.getElementById('id-hint-' + slot);
      if (hint) hint.textContent = '✅ attached: ' + f.name;
      toast(sl.label + ' attached.', 'success');
    };
    img.onerror = () => toast('That file could not be read as an image.', 'error');
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
}

function showFilePNModal() {
  const u = state.user, sid = u.id;
  if (!canFilePN(sid)) { toast('You are not eligible to file a PN yet.', 'error'); return; }
  const bal = balanceOf(sid);
  state.pnDraft = {
    studentFront: sampleIdImage('SCHOOL ID — FRONT', 'Student'),
    studentBack: sampleIdImage('SCHOOL ID — BACK', 'Student'),
    guardianFront: sampleIdImage('VALID ID — FRONT', 'Parent / Guardian'),
    guardianBack: sampleIdImage('VALID ID — BACK', 'Parent / Guardian')
  };
  state.pnDraftReal = {};
  openModal(
    '<h3>File a Promissory Note</h3>' +
    '<p class="muted small">The remaining balance is automatically computed — it will be the amount of your PN.</p>' +
    '<div class="field"><label>PN amount (remaining balance — auto-computed)</label><input value="' + PHP(bal) + '" disabled></div>' +
    '<div class="field"><label>Reason for filing</label><textarea id="pn-reason" rows="3" placeholder="e.g. My father\'s salary release was delayed; I will settle the balance once received."></textarea></div>' +
    '<div class="field"><label>Promise to pay on or before</label><input id="pn-date" type="date" min="' + addDaysISO(todayISO(), 1) + '"></div>' +
    '<div class="field"><label>E-signature — type your full name exactly</label><input id="pn-sign" placeholder="' + esc(u.name) + '"></div>' +
    '<div class="field"><label>Attached IDs (required — click a slot to upload)</label>' +
      '<div class="id-grid">' +
        PN_ID_SLOTS.map((sl) => idSlotHTML(sl)).join('') +
      '</div></div>' +
    '<label class="check"><input type="checkbox" id="pn-terms">' +
      '<span>I understand this is a legally binding promise to pay the remaining balance on or before the promised date, subject to the University\'s policies.</span></label>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn" onclick="App.submitPN()">Submit PN to Registrar</button>' +
    '</div>');
}
function submitPN() {
  const u = state.user, sid = u.id;
  if (!canFilePN(sid)) return;
  const reason = ($('#pn-reason').value || '').trim();
  const promiseDate = ($('#pn-date').value || '').trim();
  const signature = ($('#pn-sign').value || '').trim();
  const agreed = $('#pn-terms').checked;

  if (reason.length < 10) return toast('Write your reason (at least 10 characters).', 'error');
  if (!promiseDate || promiseDate <= todayISO()) return toast('Choose a promise-to-pay date in the future.', 'error');
  if (!signature || signature.toUpperCase() !== u.name.toUpperCase()) return toast('E-signature must exactly match your full name: ' + u.name, 'error');
  if (!agreed) return toast('You must agree to the PN terms.', 'error');

  const attached = state.pnDraft || {};
  const missingIds = PN_ID_SLOTS.filter((sl) => !state.pnDraftReal || !state.pnDraftReal[sl.key]);
  if (missingIds.length) return toast('Upload all ID photos: ' + missingIds.map((m) => m.label).join(' · '), 'error');

  const pn = {
    id: uid('pn'), no: nextPnNo(), studentId: sid,
    amount: balanceOf(sid), tuition: tuitionOf(sid), paid: paidOf(sid),
    reason, promiseDate, signature,
    ids: {
      studentFront: attached.studentFront, studentBack: attached.studentBack,
      guardianFront: attached.guardianFront, guardianBack: attached.guardianBack
    },
    filedAt: new Date().toISOString(), status: 'Pending', remarks: '', reviewedBy: '', reviewedAt: ''
  };
  state.pnDraft = {};
  DB.data.pns.push(pn);
  DB.save();
  closeModal();

  notifyRole('registrar', '🔔 New PN for approval: ' + pn.no,
    u.name + ' (' + u.studentNo + ', ' + u.course + ') filed a Promissory Note for ' + PHP(pn.amount) +
    '. ' + pctOf(sid).toFixed(1) + '% of tuition is already paid.');
  notify(sid, '📝 PN ' + pn.no + ' submitted',
    'Your Promissory Note for ' + PHP(pn.amount) + ' is now pending for the Registrar\'s review. You will be notified here once it is approved.');
  toast('PN submitted! The Registrar has been notified.', 'success');
  render();
}

/* ---------------- PN decision (registrar) ---------------- */
function showApproveModal(id) {
  if (!['registrar', 'admin'].includes(state.user.role)) { toast('Only the Registrar or the Admin can review a Promissory Note.', 'error'); return; }
  const p = DB.data.pns.find((x) => x.id === id);
  if (!p || p.status !== 'Pending') return;
  const s = studentById(p.studentId) || {};
  openModal(
    '<h3>Approve ' + esc(p.no) + '?</h3>' +
    '<p class="muted">' + esc(s.name || 'Unknown student') + ' — PN amount <b>' + PHP(p.amount) + '</b> (' + esc(p.signature) + '\'s promise to pay on or before ' + fmtDate(p.promiseDate) + '). Approving will notify the student right away and unlock enrollment + subject enlistment.</p>' +
    '<div class="field"><label>Remarks (optional)</label><textarea id="apr-remarks" rows="2" placeholder="e.g. Approved per review of payment records."></textarea></div>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn green" onclick="App.doDecide(\'' + p.id + '\', \'Approved\')">✓ Approve PN</button>' +
    '</div>');
}
function showRejectModal(id) {
  if (!['registrar', 'admin'].includes(state.user.role)) { toast('Only the Registrar or the Admin can review a Promissory Note.', 'error'); return; }
  const p = DB.data.pns.find((x) => x.id === id);
  if (!p || p.status !== 'Pending') return;
  openModal(
    '<h3>Reject ' + esc(p.no) + '?</h3>' +
    '<p class="muted">The student will be notified with your reason and may file a new PN.</p>' +
    '<div class="field"><label>Reason for rejection (required)</label><textarea id="rej-remarks" rows="2" placeholder="e.g. Unsupported income declaration — please coordinate with Accounting first."></textarea></div>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn red" onclick="App.doDecide(\'' + p.id + '\', \'Rejected\')">✕ Reject PN</button>' +
    '</div>');
}
function doDecide(id, decision) {
  if (!state.user || !['registrar', 'admin'].includes(state.user.role)) { toast('Only the Registrar (or the Admin) can approve or reject a Promissory Note.', 'error'); return; }
  const p = DB.data.pns.find((x) => x.id === id);
  if (!p || p.status !== 'Pending') return;
  const box = decision === 'Rejected' ? $('#rej-remarks') : $('#apr-remarks');
  const remarks = box ? (box.value || '').trim() : '';
  if (decision === 'Rejected' && !remarks) return toast('Please write the reason for rejection.', 'error');

  p.status = decision;
  p.remarks = remarks;
  p.reviewedBy = state.user.name;
  p.reviewedAt = new Date().toISOString();
  DB.save();
  closeModal();

  const s = studentById(p.studentId) || {};
  if (decision === 'Approved') {
    notify(p.studentId, '✅ PN ' + p.no + ' APPROVED!',
      'Congratulations ' + (s.name ? s.name.split(' ')[0] : '') + '! The Registrar approved your Promissory Note for ' + PHP(p.amount) +
      ' (promise to pay on or before ' + fmtDate(p.promiseDate) + '). You may now ENROLL and ENLIST your subjects — see your dashboard.');
    toast('PN ' + p.no + ' approved — student notified, enrollment unlocked.', 'success');
  } else {
    notify(p.studentId, '❌ PN ' + p.no + ' rejected',
      'The Registrar rejected your Promissory Note. Reason: ' + remarks);
    toast('PN ' + p.no + ' rejected. The student was notified.', 'error');
  }
  render();
}
function showPNDetail(id) {
  const p = DB.data.pns.find((x) => x.id === id);
  if (!p) return;
  openModal(pnCardHTML(p, p.status === 'Pending'), true);
}

/* ---------------- payment actions (accounting) ---------------- */
function showPayModal(preselectId) {
  const opts = usersOf('student').sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => '<option value="' + s.id + '"' + (s.id === preselectId ? ' selected' : '') + '>' + esc(s.name) + ' — ' + esc(s.studentNo) + ' (balance ' + PHP(balanceOf(s.id)) + ')</option>')
    .join('');
  openModal(
    '<h3>Record a tuition payment</h3>' +
    '<div class="field"><label>Student</label><select id="pay-student"><option value="">— Select student —</option>' + opts + '</select></div>' +
    '<div class="field"><label>Amount (₱)</label><input id="pay-amount" type="number" min="1" step="0.01" placeholder="0.00"></div>' +
    '<div class="field"><label>Official Receipt (OR) No.</label><input id="pay-or" placeholder="OR-1234"></div>' +
    '<div class="field"><label>Date</label><input id="pay-date" type="date" value="' + todayISO() + '"></div>' +
    '<div class="field"><label>Note (optional)</label><input id="pay-note" placeholder="e.g. 2nd installment"></div>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn green" onclick="App.doRecordPayment()">💾 Save payment</button>' +
    '</div>');
}
function doRecordPayment() {
  const sid = $('#pay-student').value;
  const amount = Number($('#pay-amount').value);
  const orNo = ($('#pay-or').value || '').trim();
  const date = ($('#pay-date').value || '').trim() || todayISO();
  const note = ($('#pay-note').value || '').trim();
  const s = studentById(sid);

  if (!s) return toast('Select a student.', 'error');
  if (!amount || amount <= 0) return toast('Enter a valid amount.', 'error');
  const bal = balanceOf(sid);
  if (amount > bal + 0.001) return toast('Amount exceeds the remaining balance of ' + PHP(bal) + '.', 'error');
  if (!orNo) return toast('Enter the Official Receipt number.', 'error');

  const paidBefore = paidOf(sid);
  DB.data.payments.push({ id: uid('pay'), studentId: sid, amount, orNo, date, note, recordedBy: state.user.name, recordedAt: new Date().toISOString() });
  DB.save();
  closeModal();

  notify(sid, '💵 Payment recorded', PHP(amount) + ' was received for your tuition (OR: ' + orNo + '). Your remaining balance is now ' + PHP(balanceOf(sid)) + '.');
  const pct = pctOf(sid);
  if (paidBefore * 100 < tuitionOf(sid) * MIN_PCT && pct >= MIN_PCT && !isFullyPaid(sid)) {
    notify(sid, '🎉 You reached 75%!',
      'You have paid at least 75% of your tuition. You may now file a Promissory Note for your remaining balance — open your dashboard and click "File Promissory Note".');
  }
  toast('Payment recorded. Student notified.', 'success');
  render();
}
function confirmDeletePayment(id) {
  const p = DB.data.payments.find((x) => x.id === id);
  if (!p) return;
  const s = studentById(p.studentId) || {};
  openModal(
    '<h3>Delete payment?</h3>' +
    '<p class="muted">OR ' + esc(p.orNo) + ' — ' + PHP(p.amount) + ' for ' + esc(s.name || 'Unknown') + '. This cannot be undone.</p>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn red" onclick="App.deletePayment(\'' + p.id + '\')">Delete</button>' +
    '</div>');
}
function deletePayment(id) {
  DB.data.payments = DB.data.payments.filter((p) => p.id !== id);
  DB.save();
  closeModal();
  toast('Payment deleted.', 'success');
  render();
}

/* ---------------- enrollment actions (student) ---------------- */
function toggleSubject(subId) {
  const u = state.user;
  const e = getEnrollment(u.id);
  if (e.status === 'Enrolled' || !canEnroll(u.id)) return render();
  const sub = subjectById(subId);
  if (!sub) return;
  const i = e.subjects.indexOf(subId);
  if (i >= 0) {
    e.subjects.splice(i, 1);
    toast('Removed ' + sub.code);
  } else {
    if (unitsOf(e.subjects) + sub.units > MAX_UNITS) {
      toast('Max load is ' + MAX_UNITS + ' units — cannot add ' + sub.code + '.', 'error');
    } else {
      e.subjects.push(subId);
      toast('Enlisted ' + sub.code, 'success');
    }
  }
  DB.save();
  render();
}
function confirmEnrollment() {
  const u = state.user;
  if (!canEnroll(u.id)) return;
  const e = getEnrollment(u.id);
  if (e.status === 'Enrolled') return;
  if (!e.subjects.length) return toast('Enlist at least one subject first.', 'error');
  e.status = 'Enrolled';
  e.confirmedAt = new Date().toISOString();
  DB.save();
  notifyRole('registrar', '🎓 New enrolled student',
    u.name + ' (' + u.studentNo + ') confirmed enrollment with ' + unitsOf(e.subjects) + ' units — ' + e.sy + ', ' + e.term + '.');
  toast('🎉 You are now ENROLLED!', 'success');
  render();
}
function dropEnlistment() {
  const e = getEnrollment(state.user.id);
  if (e.status === 'Enrolled') return;
  e.subjects = [];
  DB.save();
  toast('Enlistment cleared.');
  render();
}

/* ---------------- print PN ---------------- */
function buildPNDoc(id) {
  const p = DB.data.pns.find((x) => x.id === id);
  if (!p) return '';
  const s = studentById(p.studentId) || {};
  const approved = p.status === 'Approved';
  const ids = p.ids || {};
  const fig = (src, caption) => (src
    ? '<figure class="doc-idfig"><img src="' + src + '" alt="' + caption + '"><figcaption>' + caption + '</figcaption></figure>'
    : '');
  const anyIds = ids.studentFront || ids.studentBack || ids.guardianFront || ids.guardianBack;
  return '<div class="pn-doc">' +
    '<div class="doc-head">' +
      '<img class="doc-seal" src="img/logo.png">' +
      '<div class="doc-school">ST. PETER\'S COLLEGE ILIGAN CITY</div>' +
      '<div class="doc-sub">Office of the Registrar · Promissory Note</div>' +
      '<div class="doc-no">' + esc(p.no) + '</div>' +
    '</div>' +
    '<table class="doc-table">' +
      '<tr><th>Student</th><td>' + esc(s.name || '') + '</td><th>Student No.</th><td>' + esc(s.studentNo || '') + '</td></tr>' +
      '<tr><th>Course &amp; Year</th><td>' + esc(s.course || '') + ' — ' + esc(s.year || '') + '</td><th>Date filed</th><td>' + fmtDate(p.filedAt) + '</td></tr>' +
      '<tr><th>Total tuition</th><td>' + PHP(p.tuition) + '</td><th>Amount paid</th><td>' + PHP(p.paid) + ' (' + pctOf(p.studentId).toFixed(1) + '%)</td></tr>' +
      '<tr><th>PN amount (remaining)</th><td><b>' + PHP(p.amount) + '</b></td><th>Promise to pay</th><td>on or before ' + fmtDate(p.promiseDate) + '</td></tr>' +
    '</table>' +
    '<p class="doc-p">I, <b>' + esc(s.name || p.signature) + '</b>, promise to pay <b>ST. PETER\'S COLLEGE ILIGAN CITY</b> the amount of <b>' +
      PHP(p.amount) + '</b> on or before <b>' + fmtDate(p.promiseDate) + '</b>. I understand that failure to settle on the promised date may hold the release of my credentials and future enrollment privileges.</p>' +
    '<p class="doc-p"><b>Reason:</b> <span class="prem">' + esc(p.reason) + '</span></p>' +
    (anyIds
      ? '<div class="doc-ids"><div class="doc-ids-title">Attached IDs</div><div class="doc-ids-grid">' +
          fig(ids.studentFront, 'Student School ID — Front') +
          fig(ids.studentBack, 'Student School ID — Back') +
          fig(ids.guardianFront, 'Parent / Guardian Valid ID — Front') +
          fig(ids.guardianBack, 'Parent / Guardian Valid ID — Back') +
        '</div></div>'
      : '') +
    '<div class="doc-signs">' +
      '<div class="doc-sign"><div>' + esc(p.signature) + '</div><div class="doc-role">Student\'s signature</div></div>' +
      (approved
        ? '<div class="doc-sign"><div>' + esc(p.reviewedBy || 'Registrar') + '</div><div class="doc-role">Approved by · Registrar · ' + fmtDate(p.reviewedAt) + '</div></div>'
        : '<div class="doc-sign"><div>—</div><div class="doc-role">Not yet approved</div></div>') +
    '</div>' +
  '</div>';
}
function printPN(id) {
  const html = buildPNDoc(id);
  if (!html) return;
  $('#print-root').innerHTML = html;
  window.print();
  window.addEventListener('afterprint', () => { $('#print-root').innerHTML = ''; }, { once: true });
}

/* ---------------- print official receipt ---------------- */
function buildReceiptDoc(payId) {
  const pay = DB.data.payments.find((x) => x.id === payId);
  if (!pay) return '';
  const s = studentById(pay.studentId) || {};
  const pays = paymentsOf(pay.studentId);
  const idx = pays.findIndex((x) => x.id === payId);
  const paidUpTo = idx >= 0 ? pays.slice(0, idx + 1).reduce((sum, x) => sum + x.amount, 0) : paidOf(pay.studentId);
  const tuition = tuitionOf(pay.studentId);
  const balanceAfter = Math.max(0, tuition - paidUpTo);
  const pct = tuition > 0 ? (paidUpTo / tuition) * 100 : 0;
  const note = pay.note ? esc(pay.note) : 'Tuition & other school fees';
  return '<div class="rcpt">' +
    '<div class="rcpt-head">' +
      '<img class="rcpt-seal" src="img/logo.png">' +
      '<div class="rcpt-school">ST. PETER\'S COLLEGE ILIGAN CITY</div>' +
      '<div class="rcpt-office">Office of the Registrar · Accounting / Cashier</div>' +
      '<div class="rcpt-title">OFFICIAL RECEIPT</div>' +
    '</div>' +
    '<div class="rcpt-no"><span>O.R. No.: <b>' + esc(pay.orNo) + '</b></span><span>Date: <b>' + fmtDate(pay.date) + '</b></span></div>' +
    '<table class="rcpt-table">' +
      '<tr><th>Received from</th><td><b>' + esc(s.name || '—') + '</b></td></tr>' +
      '<tr><th>Student No.</th><td>' + esc(s.studentNo || '—') + ' · ' + esc(s.course || '') + ' — ' + esc(s.year || '') + '</td></tr>' +
      '<tr><th>The amount of</th><td><b>' + PHP(pay.amount) + '</b></td></tr>' +
      '<tr><th>In words</th><td class="rcpt-words">' + pesoWords(pay.amount).toUpperCase() + ' ONLY</td></tr>' +
      '<tr><th>Being payment of</th><td>' + note + '</td></tr>' +
      '<tr><th>Received by</th><td>' + esc(pay.recordedBy || 'Cashier') + '</td></tr>' +
    '</table>' +
    '<div class="rcpt-status">Running total paid: <b>' + PHP(paidUpTo) + '</b> (' + pct.toFixed(1) + '% of ' + PHP(tuition) + ') · Remaining balance after this payment: <b>' + PHP(balanceAfter) + '</b>' +
      (pct >= MIN_PCT && balanceAfter > 0 ? ' · <b>PN ELIGIBLE</b> — may file a Promissory Note for the remainder.' : '') + '</div>' +
    '<div class="rcpt-signs">' +
      '<div class="rcpt-sign"><div>' + esc(pay.recordedBy || 'Cashier') + '</div><div class="doc-role">Cashier / Authorized Signatory</div></div>' +
    '</div>' +
    '<div class="rcpt-foot">This receipt is system-generated by the Promissory Note System of St. Peter\'s College Iligan City. Please keep this as proof of payment.</div>' +
  '</div>';
}
function printReceipt(payId) {
  const html = buildReceiptDoc(payId);
  if (!html) return;
  $('#print-root').innerHTML = html;
  window.print();
  window.addEventListener('afterprint', () => { $('#print-root').innerHTML = ''; }, { once: true });
}

/* =====================================================
   RENDERING
   ===================================================== */
function render() {
  $('#app').innerHTML = state.user ? shellHTML() : loginHTML();
}

/* ---------------- login page ---------------- */
function loginHTML() {
  return '<div class="login-page">' +
    '<div class="login-left">' +
      '<div class="logo big"><img class="logo-img" src="img/logo.png" alt="School seal"></div>' +
      '<h1>Promissory Note System</h1>' +
      '<div class="uni">St. Peter\'s College Iligan City · Office of the Registrar</div>' +
    '</div>' +
    '<div class="login-right">' +
      '<div class="card login-card">' +
        '<h2>Sign in</h2>' +
        '<form onsubmit="event.preventDefault(); App.loginFromForm()">' +
          '<div class="field"><label>Username</label><input id="login-user" autocomplete="username" placeholder="e.g. student1"></div>' +
          '<div class="field"><label>Password</label><input id="login-pass" type="password" autocomplete="current-password" placeholder="password = username"></div>' +
          '<button class="btn full" type="submit">Log in</button>' +
        '</form>' +
        '<div class="divider"></div>' +
        '<button class="btn ghost full" onclick="App.showRegister()">SIGN UP</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

/* ---------------- shell / topbar ---------------- */
function shellHTML() {
  const u = state.user;
  const unread = unreadCount();
  return '<header class="topbar">' +
    '<div class="brand">' +
      '<div class="logo"><img class="logo-img" src="img/logo.png" alt="School seal"></div>' +
      '<div><div class="brand-title">Promissory Note System</div><div class="brand-sub">St. Peter\'s College Iligan City</div></div>' +
    '</div>' +
    '<div class="top-actions">' +
      '<div class="bell-wrap">' +
        '<button class="icon-btn" onclick="App.toggleBell()" title="Notifications">🔔' + (unread ? '<span class="bell-badge">' + unread + '</span>' : '') + '</button>' +
        (state.bellOpen ? bellHTML() : '') +
      '</div>' +
      '<div class="user-box"><div class="user-name">' + esc(u.name) + '</div><div class="user-role">' + ROLE_LABEL[u.role] + '</div></div>' +
      '<button class="btn ghost small" onclick="App.logout()">Log out</button>' +
    '</div>' +
  '</header>' +
  '<main class="page">' + roleView() + '</main>';
}
function roleView() {
  if (state.user.role === 'student') return studentView();
  if (state.user.role === 'registrar') return registrarView();
  if (state.user.role === 'admin') return adminView();
  return accountingView();
}

function bellHTML() {
  const list = myNotifications();
  return '<div class="bell-drop">' +
    '<div class="bell-head"><b>Notifications</b>' +
      '<div class="bell-head-actions">' +
        '<button class="btn ghost tiny" onclick="App.markAllRead()">Mark all read</button>' +
        '<button class="icon-btn dark" onclick="App.closeBell()" title="Close">✕</button>' +
      '</div>' +
    '</div>' +
    '<div class="bell-list">' +
      (list.length
        ? list.map((n) =>
            '<div class="notif ' + (n.read ? '' : 'unread') + '">' +
              '<div class="n-title">' + esc(n.title) + '</div>' +
              '<div class="n-msg prem">' + esc(n.msg) + '</div>' +
              '<div class="n-date">' + fmtDateTime(n.date) + '</div>' +
            '</div>').join('')
        : '<div class="notif empty">No notifications yet.</div>') +
    '</div>' +
  '</div>';
}

/* ---------------- shared bits ---------------- */
function statCard(label, value, sub, tone) {
  return '<div class="stat-card ' + (tone ? 'tone-' + tone : '') + '">' +
    '<div class="stat-label">' + label + '</div>' +
    '<div class="stat-value">' + value + '</div>' +
    (sub ? '<div class="stat-sub">' + sub + '</div>' : '') +
  '</div>';
}
function badge(tone, text) { return '<span class="badge b-' + tone + '">' + text + '</span>'; }
function pnBadge(status) {
  return status === 'Approved' ? badge('green', '✓ Approved')
       : status === 'Pending'  ? badge('amber', '⏳ Pending')
       : badge('red', '✕ Rejected');
}
function callout(tone, icon, html) {
  return '<div class="callout c-' + tone + '"><span class="c-icon">' + icon + '</span><div>' + html + '</div></div>';
}
function progressBar(pct) {
  const w = Math.max(0, Math.min(100, pct));
  const ok = pct >= MIN_PCT;
  return '<div class="progress-wrap">' +
    '<div class="progress-track">' +
      '<div class="progress-fill' + (ok ? ' fill-ok' : '') + '" style="width:' + w + '%"></div>' +
      '<div class="progress-mark"><span>' + MIN_PCT + '%</span></div>' +
    '</div>' +
    '<div class="progress-legend"><span>Paid: <b>' + pct.toFixed(1) + '%</b> of tuition</span><span>' + MIN_PCT + '% required to file a PN</span></div>' +
  '</div>';
}
function studentStatusChip(sid) {
  if (isFullyPaid(sid)) return badge('green', 'Fully paid');
  if (approvedPNOf(sid)) return badge('green', 'PN approved');
  if (pendingPNOf(sid)) return badge('amber', 'PN pending');
  if (paidAtLeast75(sid)) return badge('blue', 'PN eligible');
  if (paidOf(sid) > 0) return badge('red', 'Below 75%');
  return badge('gray', 'No payment yet');
}
function enrollChip(sid) {
  const e = getEnrollment(sid);
  const s = studentById(sid) || {};
  if (!canEnroll(sid)) return badge('red', '🔒 Locked');
  if (e.status === 'Enrolled') return badge('green', 'Enrolled');
  if (s.enrollOverride && !isFullyPaid(sid) && !approvedPNOf(sid)) return badge('blue', '🔓 Unlocked by admin');
  return badge('amber', 'Ready to enlist');
}
function emptyNote(text) { return '<div class="empty-note">' + text + '</div>'; }
function pnIdFig(src, caption) {
  return '<figure><img src="' + src + '" alt="' + caption + '"><figcaption>' + caption + '</figcaption></figure>';
}

/* ---------------- PN card ---------------- */
function pnCardHTML(p, withActions) {
  const canDecide = state.user && (state.user.role === 'registrar' || state.user.role === 'admin'); // ONLY the Registrar (or Admin) sees approve/reject actions
  const s = studentById(p.studentId) || { name: 'Unknown', studentNo: '—', course: '—', year: '—' };
  const pct = pctOf(p.studentId);
  const kv = (label, val) => '<div class="kv"><div class="kv-label">' + label + '</div><div class="kv-val">' + val + '</div></div>';
  return '<div class="pn-card">' +
    '<div class="pn-card-head">' +
      '<div><b>' + esc(p.no) + '</b><div class="muted small">Filed ' + fmtDateTime(p.filedAt) + '</div></div>' +
      pnBadge(p.status) +
    '</div>' +
    '<div class="pn-grid">' +
      kv('Student', esc(s.name) + ' <span class="muted">(' + esc(s.studentNo) + ')</span>') +
      kv('Course & Year', esc(s.course) + ' — ' + esc(s.year)) +
      kv('Tuition & fees', PHP(p.tuition)) +
      kv('Paid so far', PHP(p.paid) + ' <span class="muted">(' + pct.toFixed(1) + '%)</span>') +
      kv('PN amount (remaining balance)', '<b>' + PHP(p.amount) + '</b>') +
      kv('Promise to pay', 'on or before <b>' + fmtDate(p.promiseDate) + '</b>') +
      (p.reviewedAt ? kv('Reviewed by', esc(p.reviewedBy) + ' · ' + fmtDateTime(p.reviewedAt)) : '') +
    '</div>' +
    '<div class="pn-reason"><span class="kv-label">Reason for filing</span><p class="prem">' + esc(p.reason) + '</p></div>' +
    (p.remarks ? '<div class="pn-reason warn"><span class="kv-label">Registrar\'s remarks</span><p class="prem">' + esc(p.remarks) + '</p></div>' : '') +
    (p.ids
      ? '<div class="pn-ids">' +
          pnIdFig(p.ids.studentFront, 'School ID · Front') +
          pnIdFig(p.ids.studentBack, 'School ID · Back') +
          pnIdFig(p.ids.guardianFront, 'Guardian ID · Front') +
          pnIdFig(p.ids.guardianBack, 'Guardian ID · Back') +
        '</div>'
      : '') +
    '<div class="pn-sign muted small">E-signature: <b>' + esc(p.signature) + '</b></div>' +
    '<div class="pn-actions">' +
      '<button class="btn ghost small" onclick="App.showPNDetail(\'' + p.id + '\')">Details</button>' +
      (p.status === 'Approved' ? '<button class="btn small" onclick="App.printPN(\'' + p.id + '\')">🖨 Print PN</button>' : '') +
      (state.user && state.user.role === 'admin'
        ? '<button class="btn ghost small" title="Delete this PN record" onclick="App.adminDeletePN(\'' + p.id + '\')">🗑 Delete</button>'
        : '') +
      (withActions && canDecide && p.status === 'Pending'
        ? '<span class="spacer"></span>' +
          '<button class="btn red small" onclick="App.showRejectModal(\'' + p.id + '\')">✕ Reject</button>' +
          '<button class="btn green small" onclick="App.showApproveModal(\'' + p.id + '\')">✓ Approve</button>'
        : '') +
    '</div>' +
  '</div>';
}

/* ---------------- student view ---------------- */
function studentView() {
  const u = state.user, sid = u.id;
  const tuition = tuitionOf(sid), paid = paidOf(sid), bal = balanceOf(sid), pct = pctOf(sid);
  const pn = pendingPNOf(sid);
  const apn = approvedPNOf(sid);
  const last = latestPNOf(sid);
  const rejected = last && last.status === 'Rejected' ? last : null;
  const myPNs = DB.data.pns.filter((p) => p.studentId === sid).slice().reverse();
  const pays = paymentsOf(sid).slice().reverse();

  let pnBox;
  if (isFullyPaid(sid)) {
    pnBox = callout('green', '🎉', '<b>You have fully paid your tuition.</b> No Promissory Note is needed — you may enroll directly below.');
  } else if (!paidAtLeast75(sid)) {
    pnBox = callout('amber', '⏳', '<b>You have paid ' + pct.toFixed(1) + '% of your tuition.</b> To qualify for a Promissory Note, pay at least <b>' + MIN_PCT + '%</b> first — that is <b>' + PHP(needFor75(sid)) + ' more</b>. Take your payment to the <b>Accounting / Cashier</b>.');
  } else if (pn) {
    pnBox = callout('amber', '🕒', '<b>Promissory Note ' + esc(pn.no) + ' is pending.</b> Filed on ' + fmtDate(pn.filedAt) + ' — waiting for the <b>Registrar\'s approval</b>. You will be notified here the moment it is approved.');
  } else if (apn) {
    pnBox = callout('green', '✅', '<b>Your Promissory Note ' + esc(apn.no) + ' was APPROVED by the Registrar' +
      (apn.remarks ? ' — "' + esc(apn.remarks) + '"' : '') + '.</b> The remaining balance of <b>' + PHP(apn.amount) +
      '</b> is covered by your PN — promise to pay on or before <b>' + fmtDate(apn.promiseDate) + '</b>. You may now enlist your subjects below.' +
      '<div class="mt8"><button class="btn small" onclick="App.printPN(\'' + apn.id + '\')">🖨 Print PN</button></div>');
  } else {
    pnBox = callout('blue', '📝', '<b>You have paid ' + pct.toFixed(1) + '% — you are eligible for a Promissory Note!</b> ' +
      'Your remaining balance of <b>' + PHP(bal) + '</b> was automatically computed and will be the amount of your PN.' +
      '<div class="mt8"><button class="btn small" onclick="App.showFilePNModal()">File Promissory Note</button></div>' +
      (rejected ? '<div class="mt8">Your previous PN <b>' + esc(rejected.no) + '</b> was rejected — "' + esc(rejected.remarks || 'No remarks.') + '". You may file a new one.</div>' : ''));
  }

  return '<div class="stats-grid">' +
      statCard('Tuition & Fees', PHP(tuition), esc(u.course) + ' · ' + esc(u.year)) +
      statCard('Total Paid', PHP(paid), pct.toFixed(1) + '% of tuition') +
      statCard('Remaining Balance', PHP(bal), bal <= 0 ? 'Nothing left to pay 🎉' : (apn ? 'Covered by your PN' : 'Pay at the Cashier'), bal <= 0 ? 'green' : '') +
      statCard('Enrollment Status', enrollChip(sid), esc(u.studentNo)) +
    '</div>' +

    '<section class="card">' +
      '<div class="card-head"><h3>📊 Tuition Progress</h3><span class="muted small">' + MIN_PCT + '% minimum payment rule before filing a PN</span></div>' +
      progressBar(pct) +
      '<div class="mt8">' + pnBox + '</div>' +
    '</section>' +

    '<section class="card">' +
      '<div class="card-head"><h3>📄 My Promissory Notes</h3><span class="muted small">History of every PN you filed</span></div>' +
      (myPNs.length
        ? '<div class="table-wrap"><table class="table"><thead><tr><th>PN No.</th><th>Amount</th><th>Filed</th><th>Promise date</th><th>Status</th><th></th></tr></thead><tbody>' +
          myPNs.map((p) =>
            '<tr><td><b>' + esc(p.no) + '</b></td><td>' + PHP(p.amount) + '</td><td>' + fmtDate(p.filedAt) + '</td><td>' + fmtDate(p.promiseDate) + '</td><td>' + pnBadge(p.status) + '</td>' +
            '<td class="cell-actions"><button class="btn ghost small" onclick="App.showPNDetail(\'' + p.id + '\')">Details</button>' +
            (p.status === 'Approved' ? '<button class="btn ghost small" onclick="App.printPN(\'' + p.id + '\')">🖨</button>' : '') + '</td></tr>').join('') +
          '</tbody></table></div>'
        : emptyNote('You have not filed any Promissory Note yet.')) +
    '</section>' +

    enrollmentCardHTML() +

    '<section class="card">' +
      '<div class="card-head"><h3>🧾 Payment History</h3><span class="muted small">Recorded by Accounting / Cashier</span></div>' +
      (pays.length
        ? '<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>OR No.</th><th>Amount</th><th>Note</th></tr></thead><tbody>' +
          pays.map((p) => '<tr><td>' + fmtDate(p.date) + '</td><td>' + esc(p.orNo) + '</td><td><b>' + PHP(p.amount) + '</b></td><td class="muted">' + esc(p.note || '—') + '</td></tr>').join('') +
          '</tbody></table></div>'
        : emptyNote('No payments recorded yet. Visit the Accounting / Cashier.')) +
    '</section>';
}

function enrollmentCardHTML() {
  const u = state.user, sid = u.id;
  const unlocked = canEnroll(sid);
  const e = getEnrollment(sid);
  const head = '<div class="card-head"><h3>🎓 Enrollment & Subject Enlistment</h3>' + enrollChip(sid) + '</div>';

  if (!unlocked) {
    const why = !paidAtLeast75(sid)
      ? 'You have paid <b>' + pctOf(sid).toFixed(1) + '%</b> of your tuition. Enrollment unlocks when you either <b>(a)</b> pay the full amount, or <b>(b)</b> reach at least <b>' + MIN_PCT + '%</b> and get your Promissory Note <b>approved</b> by the Registrar.'
      : 'Your Promissory Note is still <b>awaiting Registrar approval</b>. Enrollment unlocks the moment it is approved — you will be notified right away.';
    return '<section class="card">' + head + callout('red', '🔒', '<b>Enrollment is locked.</b> ' + why) + '</section>';
  }

  if (e.status === 'Enrolled') {
    const subs = e.subjects.map(subjectById).filter(Boolean);
    return '<section class="card">' + head +
      '<p class="ok-note">🎓 You are officially enrolled for <b>' + esc(e.sy) + ' — ' + esc(e.term) + '</b>. Confirmed on ' + fmtDateTime(e.confirmedAt) + '.</p>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Code</th><th>Subject</th><th>Units</th><th>Schedule</th></tr></thead><tbody>' +
        subs.map((s) => '<tr><td><b>' + esc(s.code) + '</b></td><td>' + esc(s.name) + '</td><td>' + s.units + '</td><td>' + esc(s.schedule) + '</td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="tot-row"><span>Total units: <b>' + unitsOf(e.subjects) + '</b> / ' + MAX_UNITS + '</span>' + badge('green', 'Enrollment confirmed ✓') + '</div>' +
    '</section>';
  }

  const rows = DB.data.subjects.map((s) => {
    const on = e.subjects.includes(s.id);
    return '<tr class="' + (on ? 'row-on' : '') + '">' +
      '<td><input type="checkbox" ' + (on ? 'checked' : '') + ' onchange="App.toggleSubject(\'' + s.id + '\')"></td>' +
      '<td><b>' + esc(s.code) + '</b></td><td>' + esc(s.name) + '</td><td>' + s.units + '</td><td>' + esc(s.schedule) + '</td>' +
      '<td>' + (on ? badge('blue', 'Enlisted') : '<span class="muted small">—</span>') + '</td></tr>';
  }).join('');

  return '<section class="card">' + head +
    '<p class="muted small mb14">Tick the subjects you want to enlist (max load ' + MAX_UNITS + ' units), then click <b>Confirm Enrollment</b>. You may adjust until you confirm.</p>' +
    '<div class="table-wrap"><table class="table"><thead><tr><th></th><th>Code</th><th>Subject</th><th>Units</th><th>Schedule</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="tot-row">' +
      '<span>Units enlisted: <b>' + unitsOf(e.subjects) + '</b> / ' + MAX_UNITS + '</span>' +
      '<span class="btn-row">' +
        (e.subjects.length ? '<button class="btn ghost small" onclick="App.dropEnlistment()">Drop all</button>' : '') +
        '<button class="btn green" onclick="App.confirmEnrollment()">✓ Confirm Enrollment</button>' +
      '</span>' +
    '</div>' +
  '</section>';
}

/* ---------------- accounting view ---------------- */
function accountingView() {
  const students = usersOf('student').slice().sort((a, b) => a.name.localeCompare(b.name));
  const collected = DB.data.payments.reduce((s, p) => s + p.amount, 0);
  const outstanding = students.reduce((s, st) => s + balanceOf(st.id), 0);
  const eligible = students.filter((s) => paidAtLeast75(s.id) && !isFullyPaid(s.id)).length;

  return '<div class="stats-grid">' +
      statCard('Students', usersOf('student').length, 'registered in the system') +
      statCard('Total Collected', PHP(collected), 'all recorded payments', 'green') +
      statCard('Outstanding Balance', PHP(outstanding), 'unpaid tuition across students', 'red') +
      statCard('PN-Eligible Students', eligible, 'paid at least ' + MIN_PCT + '% (not fully paid)', 'blue') +
    '</div>' +

    '<section class="card">' +
      '<div class="card-head"><h3>💰 Tuition Ledger</h3><button class="btn green" onclick="App.showPayModal()">＋ Record payment</button></div>' +
      '<div class="table-wrap"><table class="table"><thead>' +
        '<tr><th>Student No.</th><th>Name</th><th>Course / Year</th><th>Tuition</th><th>Paid</th><th>%</th><th>Balance</th><th>Status</th><th>Enrollment</th></tr></thead><tbody>' +
        students.map((s) => {
          const pct = pctOf(s.id);
          return '<tr>' +
            '<td>' + esc(s.studentNo) + '</td>' +
            '<td><b>' + esc(s.name) + '</b></td>' +
            '<td class="muted">' + esc(s.course) + ' · ' + esc(s.year) + '</td>' +
            '<td>' + PHP(s.tuition) + '</td>' +
            '<td>' + PHP(paidOf(s.id)) + '</td>' +
            '<td>' + (pct >= MIN_PCT ? '<b class="ok-text">' : '<b class="warn-text">') + pct.toFixed(0) + '%</b></td>' +
            '<td>' + PHP(balanceOf(s.id)) + '</td>' +
            '<td>' + studentStatusChip(s.id) + '</td>' +
            '<td>' + enrollChip(s.id) + '</td>' +
          '</tr>';
        }).join('') +
      '</tbody></table></div>' +
      '<p class="muted small mt8">Tip: once a student reaches ' + MIN_PCT + '%, they become <b>PN eligible</b>. They file the PN themselves; you do not need to do anything else.</p>' +
    '</section>' +

    '<section class="card">' +
      '<div class="card-head"><h3>🧾 Payments Recorded</h3><span class="muted small">official receipts issued by the cashier · 🖨 prints the receipt</span></div>' +
      (DB.data.payments.length
        ? '<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>OR No.</th><th>Student</th><th>Amount</th><th>Note</th><th>Recorded by</th><th></th></tr></thead><tbody>' +
          DB.data.payments.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((p) => {
            const s = studentById(p.studentId) || {};
            return '<tr><td>' + fmtDate(p.date) + '</td><td>' + esc(p.orNo) + '</td><td>' + esc(s.name || '—') + '</td><td><b>' + PHP(p.amount) + '</b></td>' +
              '<td class="muted">' + esc(p.note || '—') + '</td><td class="muted">' + esc(p.recordedBy) + '</td>' +
              '<td class="cell-actions"><button class="btn ghost tiny" title="Print official receipt" onclick="App.printReceipt(\'' + p.id + '\')">🖨</button>' +
              '<button class="btn red tiny" title="Delete payment" onclick="App.confirmDeletePayment(\'' + p.id + '\')">✕</button></td></tr>';
          }).join('') +
          '</tbody></table></div>'
        : emptyNote('No payments recorded yet.')) +
    '</section>';
}

/* ---------------- registrar view ---------------- */
function registrarView() {
  const sorted = DB.data.pns.slice().sort((a, b) => (a.filedAt < b.filedAt ? -1 : 1));
  const pending = sorted.filter((p) => p.status === 'Pending');
  const decided = sorted.filter((p) => p.status !== 'Pending').slice().reverse();
  const enrolledCount = DB.data.enrollments.filter((e) => e.status === 'Enrolled').length;

  return '<div class="stats-grid">' +
      statCard('Pending PNs', pending.length, 'waiting for your approval', pending.length ? 'red' : '') +
      statCard('Approved PNs', DB.data.pns.filter((p) => p.status === 'Approved').length, 'enrollment unlocked', 'green') +
      statCard('Rejected PNs', DB.data.pns.filter((p) => p.status === 'Rejected').length, 'student may re-file') +
      statCard('Enrolled Students', enrolledCount, 'confirmed their subjects', 'blue') +
    '</div>' +

    '<section class="card">' +
      '<div class="card-head"><h3>🔔 Promissory Notes for Approval</h3><span class="muted small">Students who paid at least ' + MIN_PCT + '% and filed a PN</span></div>' +
      (pending.length
        ? '<div class="cards-grid">' + pending.map((p) => pnCardHTML(p, true)).join('') + '</div>'
        : emptyNote('No promissory notes are waiting for approval. 🎉')) +
    '</section>' +

    '<section class="card">' +
      '<div class="card-head"><h3>📚 PN History</h3><span class="muted small">approved & rejected promissory notes</span></div>' +
      (decided.length
        ? '<div class="cards-grid">' + decided.map((p) => pnCardHTML(p, false)).join('') + '</div>'
        : emptyNote('No decisions yet.')) +
    '</section>' +

    '<section class="card">' +
      '<div class="card-head"><h3>💵 Payments & Official Receipts</h3><span class="muted small">every recorded tuition payment · click 🖨 to print the receipt</span></div>' +
      (DB.data.payments.length
        ? '<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>OR No.</th><th>Student</th><th>Amount</th><th>Note</th><th>Recorded by</th><th></th></tr></thead><tbody>' +
          DB.data.payments.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((p) => {
            const s = studentById(p.studentId) || {};
            return '<tr><td>' + fmtDate(p.date) + '</td><td><b>' + esc(p.orNo) + '</b></td><td>' + esc(s.name || '—') + '</td>' +
              '<td><b>' + PHP(p.amount) + '</b></td><td class="muted">' + esc(p.note || '—') + '</td><td class="muted">' + esc(p.recordedBy) + '</td>' +
              '<td><button class="btn ghost small" title="Print official receipt" onclick="App.printReceipt(\'' + p.id + '\')">🖨 Receipt</button></td></tr>';
          }).join('') +
          '</tbody></table></div>'
        : emptyNote('No payments recorded yet. The Accounting / Cashier records these.')) +
    '</section>';
}

/* ---------------- admin view (full power) ---------------- */
const isAdmin = () => !!state.user && state.user.role === 'admin';

const ADMIN_TABS = [
  ['overview', '🧭 Overview'],
  ['pns', '📄 Promissory Notes'],
  ['payments', '💵 Payments'],
  ['students', '👥 Students'],
  ['notifications', '🔔 Notifications'],
  ['system', '⚙️ System']
];

function setAdminTab(tab) {
  state.adminTab = tab;
  render();
}

function adminView() {
  const active = ADMIN_TABS.some((t) => t[0] === state.adminTab) ? state.adminTab : 'overview';
  const pendingCount = DB.data.pns.filter((p) => p.status === 'Pending').length;
  return '<div class="alert admin">' +
      '🧭 You are logged in as the <b>System Administrator</b> — full power over every module, record, and account.' +
      '<button class="btn ghost small" onclick="App.confirmReset()">↺ Reset demo data</button>' +
    '</div>' +
    '<div class="admin-tabs">' +
      ADMIN_TABS.map((t) =>
        '<button class="admin-tab' + (t[0] === active ? ' on' : '') + '" onclick="App.setAdminTab(\'' + t[0] + '\')">' +
          t[1] + (t[0] === 'pns' && pendingCount ? ' <span class="tab-count">' + pendingCount + '</span>' : '') +
        '</button>').join('') +
    '</div>' +
    adminTabContent(active);
}

function adminTabContent(tab) {
  if (tab === 'pns') return adminPNsTab();
  if (tab === 'payments') return adminPaymentsTab();
  if (tab === 'students') return adminStudentsTab();
  if (tab === 'notifications') return adminNotificationsTab();
  if (tab === 'system') return adminSystemTab();
  return adminOverviewTab();
}

function adminOverviewTab() {
  const students = usersOf('student');
  const pending = DB.data.pns.filter((p) => p.status === 'Pending').sort((a, b) => (a.filedAt < b.filedAt ? -1 : 1));
  const collected = DB.data.payments.reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
  const outstanding = students.reduce((acc, st) => acc + balanceOf(st.id), 0);
  const enrolledCount = DB.data.enrollments.filter((e) => e.status === 'Enrolled').length;
  const recent = DB.data.notifications.slice().reverse().slice(0, 6);

  return '<div class="stats-grid">' +
      statCard('Pending PNs', pending.length, 'awaiting a decision', pending.length ? 'red' : '') +
      statCard('Total Collected', PHP(collected), 'all recorded payments', 'green') +
      statCard('Outstanding Balance', PHP(outstanding), 'unpaid tuition overall', 'blue') +
      statCard('Enrolled Students', enrolledCount, 'confirmed their subjects', '') +
    '</div>' +

    '<section class="card">' +
      '<div class="card-head"><h3>⚡ Quick actions</h3><span class="muted small">every module is one click away</span></div>' +
      '<div class="btn-row">' +
        '<button class="btn green" onclick="App.showPayModal()">＋ Record payment</button>' +
        '<button class="btn" onclick="App.adminAddStudent()">👤 New student</button>' +
        '<button class="btn" onclick="App.adminSendAnnouncement()">📣 Send announcement</button>' +
        '<button class="btn ghost" onclick="App.adminExportData()">⬇ Export backup</button>' +
        '<button class="btn ghost" onclick="App.setAdminTab(\'system\')">⚙️ System tools</button>' +
      '</div>' +
    '</section>' +

    '<section class="card">' +
      '<div class="card-head"><h3>🔔 Promissory Notes for Decision</h3><span class="muted small">approve ✓ or reject ✕ like the Registrar</span></div>' +
      (pending.length
        ? '<div class="cards-grid">' + pending.map((p) => pnCardHTML(p, true)).join('') + '</div>'
        : emptyNote('No promissory notes are waiting for a decision. 🎉')) +
    '</section>' +

    '<section class="card">' +
      '<div class="card-head"><h3>🕘 Recent notifications</h3><button class="btn ghost small" onclick="App.setAdminTab(\'notifications\')">View all</button></div>' +
      (recent.length
        ? '<div class="table-wrap"><table class="table"><thead><tr><th>Sent</th><th>To</th><th>Title</th></tr></thead><tbody>' +
          recent.map((n) => {
            const to = DB.data.users.find((x) => x.id === n.toUserId) || {};
            return '<tr><td class="muted">' + fmtDateTime(n.date) + '</td><td><b>' + esc(to.name || n.toUserId) + '</b></td><td>' + esc(n.title) + '</td></tr>';
          }).join('') +
          '</tbody></table></div>'
        : emptyNote('No notifications sent yet.')) +
    '</section>';
}

function adminPNsTab() {
  const sorted = DB.data.pns.slice().sort((a, b) => (a.filedAt < b.filedAt ? 1 : -1));
  const pending = sorted.filter((p) => p.status === 'Pending');
  const decided = sorted.filter((p) => p.status !== 'Pending');
  return '<section class="card">' +
      '<div class="card-head"><h3>⏳ Pending Promissory Notes</h3><span class="muted small">' + pending.length + ' awaiting a decision</span></div>' +
      (pending.length
        ? '<div class="cards-grid">' + pending.map((p) => pnCardHTML(p, true)).join('') + '</div>'
        : emptyNote('No pending PNs. 🎉')) +
    '</section>' +

    '<section class="card">' +
      '<div class="card-head"><h3>📚 All PN records</h3><span class="muted small">' + decided.length + ' decided · you may delete any record</span></div>' +
      (decided.length
        ? '<div class="cards-grid">' + decided.map((p) => pnCardHTML(p, false)).join('') + '</div>'
        : emptyNote('No decisions yet.')) +
    '</section>';
}

function adminPaymentsTab() {
  const collected = DB.data.payments.reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
  return '<section class="card">' +
      '<div class="card-head"><h3>💵 Payments &amp; Official Receipts</h3>' +
        '<span class="btn-row"><span class="muted small">Total collected: <b>' + PHP(collected) + '</b></span>' +
        '<button class="btn green" onclick="App.showPayModal()">＋ Record payment</button></span></div>' +
      (DB.data.payments.length
        ? '<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>OR No.</th><th>Student</th><th>Amount</th><th>Note</th><th>Recorded by</th><th>Actions</th></tr></thead><tbody>' +
          DB.data.payments.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((p) => {
            const s = studentById(p.studentId) || {};
            return '<tr><td>' + fmtDate(p.date) + '</td><td><b>' + esc(p.orNo) + '</b></td><td>' + esc(s.name || '—') + '</td>' +
              '<td><b>' + PHP(p.amount) + '</b></td><td class="muted">' + esc(p.note || '—') + '</td><td class="muted">' + esc(p.recordedBy) + '</td>' +
              '<td class="cell-actions"><button class="btn ghost tiny" title="Print official receipt" onclick="App.printReceipt(\'' + p.id + '\')">🖨</button>' +
              '<button class="btn red tiny" title="Delete payment" onclick="App.confirmDeletePayment(\'' + p.id + '\')">✕</button></td></tr>';
          }).join('') +
          '</tbody></table></div>'
        : emptyNote('No payments recorded yet.')) +
    '</section>';
}

function adminStudentsTab() {
  const students = usersOf('student').slice().sort((a, b) => a.name.localeCompare(b.name));
  const staff = DB.data.users.filter((u) => u.role !== 'student');
  return '<section class="card">' +
      '<div class="card-head"><h3>👥 Student accounts &amp; tuition ledger</h3>' +
        '<button class="btn" onclick="App.adminAddStudent()">＋ New student</button></div>' +
      '<div class="table-wrap"><table class="table"><thead>' +
        '<tr><th>Student No.</th><th>Name</th><th>Course / Year</th><th>Tuition</th><th>Paid</th><th>%</th><th>Balance</th><th>Status</th><th>Enrollment</th><th>Admin actions</th></tr></thead><tbody>' +
        students.map((s) => {
          const pct = pctOf(s.id);
          return '<tr>' +
            '<td>' + esc(s.studentNo) + '</td>' +
            '<td><b>' + esc(s.name) + '</b><div class="muted small">@' + esc(s.username) + '</div></td>' +
            '<td class="muted">' + esc(s.course) + ' · ' + esc(s.year) + '</td>' +
            '<td>' + PHP(s.tuition) + '</td>' +
            '<td>' + PHP(paidOf(s.id)) + '</td>' +
            '<td>' + (pct >= MIN_PCT ? '<b class="ok-text">' : '<b class="warn-text">') + pct.toFixed(0) + '%</b></td>' +
            '<td>' + PHP(balanceOf(s.id)) + '</td>' +
            '<td>' + studentStatusChip(s.id) + '</td>' +
            '<td>' + enrollChip(s.id) + '</td>' +
            '<td class="cell-actions">' +
              '<button class="btn ghost tiny" title="Edit student" onclick="App.adminEditStudent(\'' + s.id + '\')">✏️</button>' +
              '<button class="btn ghost tiny" title="Manage enrollment" onclick="App.adminManageEnrollment(\'' + s.id + '\')">🎓</button>' +
              '<button class="btn green tiny" title="Record payment" onclick="App.showPayModal(\'' + s.id + '\')">＋</button>' +
              '<button class="btn ghost tiny" title="Reset password" onclick="App.adminResetPassword(\'' + s.id + '\')">🔑</button>' +
              '<button class="btn red tiny" title="Delete account" onclick="App.adminDeleteUser(\'' + s.id + '\')">✕</button>' +
            '</td>' +
          '</tr>';
        }).join('') +
      '</tbody></table></div>' +
      '<p class="muted small mt8">✏️ edit details / unlock enrollment · 🎓 manage subjects · ＋ record payment · 🔑 reset password · ✕ delete account</p>' +
    '</section>' +

    '<section class="card">' +
      '<div class="card-head"><h3>🛡 Staff accounts</h3><span class="muted small">registrar · accounting · admin</span></div>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Role</th><th>Username</th><th>Title</th><th>Actions</th></tr></thead><tbody>' +
        staff.map((u) =>
          '<tr><td><b>' + esc(u.name) + '</b></td><td>' + badge(u.role === 'admin' ? 'blue' : 'gray', ROLE_LABEL[u.role] || u.role) + '</td>' +
          '<td class="muted">' + esc(u.username) + '</td><td class="muted">' + esc(u.title || '—') + '</td>' +
          '<td class="cell-actions"><button class="btn ghost tiny" title="Reset password" onclick="App.adminResetPassword(\'' + u.id + '\')">🔑</button></td></tr>').join('') +
      '</tbody></table></div>' +
    '</section>';
}

function adminNotificationsTab() {
  const notes = DB.data.notifications.slice().reverse();
  return '<section class="card">' +
      '<div class="card-head"><h3>🗂 Notification log</h3>' +
        '<span class="btn-row">' +
          '<button class="btn" onclick="App.adminSendAnnouncement()">📣 Send announcement</button>' +
          '<button class="btn red" onclick="App.adminClearNotifications()">🗑 Clear log</button>' +
        '</span></div>' +
      (notes.length
        ? '<div class="table-wrap"><table class="table"><thead><tr><th>Sent</th><th>To</th><th>Title</th><th>Message</th></tr></thead><tbody>' +
          notes.map((n) => {
            const to = DB.data.users.find((x) => x.id === n.toUserId) || {};
            return '<tr><td class="muted">' + fmtDateTime(n.date) + '</td><td><b>' + esc(to.name || n.toUserId) + '</b></td>' +
              '<td>' + esc(n.title) + '</td><td class="muted">' + esc(n.msg) + '</td></tr>';
          }).join('') +
          '</tbody></table></div>'
        : emptyNote('No notifications sent yet.')) +
    '</section>';
}

function adminSystemTab() {
  const students = usersOf('student').length;
  const staff = DB.data.users.length - students;
  return '<section class="card">' +
      '<div class="card-head"><h3>📦 Data &amp; backup</h3><span class="muted small">saved in localStorage key <code>' + DB_KEY + '</code></span></div>' +
      '<div class="stats-grid">' +
        statCard('Accounts', DB.data.users.length, students + ' students · ' + staff + ' staff') +
        statCard('Payments', DB.data.payments.length, 'official receipts issued') +
        statCard('PN records', DB.data.pns.length, DB.data.pns.filter((p) => p.status === 'Pending').length + ' pending') +
        statCard('Enrollments', DB.data.enrollments.filter((e) => e.status === 'Enrolled').length, 'confirmed enrollments') +
      '</div>' +
      '<div class="btn-row mt8">' +
        '<button class="btn" onclick="App.adminExportData()">⬇ Export JSON backup</button>' +
        '<label class="btn ghost" style="cursor:pointer;margin:0">⬆ Import backup<input type="file" accept="application/json,.json" style="display:none" onchange="App.adminImportData(this)"></label>' +
        '<button class="btn red" onclick="App.confirmReset()">↺ Reset demo data</button>' +
      '</div>' +
      '<p class="muted small mt8">Importing replaces all data in this browser with the contents of the backup file.</p>' +
    '</section>' +

    '<section class="card">' +
      '<div class="card-head"><h3>🔐 Admin capabilities</h3><span class="muted small">everything in one account</span></div>' +
      '<ul class="admin-caps">' +
        '<li>Decide (approve / reject) any pending Promissory Note, and delete any PN record.</li>' +
        '<li>Record tuition payments, print official receipts, and delete payment entries.</li>' +
        '<li>Create, edit, and delete student accounts; change tuition and unlock enrollment (override).</li>' +
        '<li>Manage any student\'s subject enlistment and confirm or reset their enrollment.</li>' +
        '<li>Reset any password, send announcements, clear the notification log.</li>' +
        '<li>Export / import a full JSON backup and reset the demo dataset.</li>' +
      '</ul>' +
    '</section>';
}

/* ---------------- admin actions ---------------- */
function adminAddStudent() {
  if (!isAdmin()) return;
  const opts = COURSES.map((c) => '<option>' + esc(c) + '</option>').join('');
  const yrs = YEARS.map((y) => '<option>' + esc(y) + '</option>').join('');
  openModal(
    '<h3>Add a student account</h3>' +
    '<p class="muted small">The password will default to the username.</p>' +
    '<div class="field"><label>Full name</label><input id="as-name" placeholder="e.g. Juan Dela Cruz"></div>' +
    '<div class="field"><label>Student No.</label><input id="as-no" placeholder="e.g. 2026-00101"></div>' +
    '<div class="field"><label>Course</label><select id="as-course">' + opts + '</select></div>' +
    '<div class="field"><label>Year level</label><select id="as-year">' + yrs + '</select></div>' +
    '<div class="field"><label>Username</label><input id="as-user" placeholder="e.g. juanc"></div>' +
    '<div class="field"><label>Tuition &amp; fees (₱)</label><input id="as-tuition" type="number" min="1000" step="100" value="30000"></div>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn" onclick="App.adminSaveNewStudent()">Create account</button>' +
    '</div>');
}

function adminSaveNewStudent() {
  if (!isAdmin()) return;
  const name = ($('#as-name').value || '').trim();
  const studentNo = ($('#as-no').value || '').trim();
  const course = $('#as-course').value;
  const year = $('#as-year').value;
  const username = ($('#as-user').value || '').trim().toLowerCase();
  const tuition = Number($('#as-tuition').value) || 0;

  if (name.length < 3) return toast('Enter the student\'s full name.', 'error');
  if (!studentNo) return toast('Enter the student number.', 'error');
  if (username.length < 3 || !/^[a-z0-9._-]+$/.test(username)) return toast('Username must be 3+ characters (letters/numbers/._-).', 'error');
  if (DB.data.users.some((u) => (u.username || '').toLowerCase() === username)) return toast('Username is already taken.', 'error');
  if (DB.data.users.some((u) => u.role === 'student' && (u.studentNo || '') === studentNo)) return toast('Student number already registered.', 'error');
  if (tuition <= 0) return toast('Enter a valid tuition amount.', 'error');

  const user = { id: uid('u'), role: 'student', name, username, password: username, studentNo, course, year, tuition };
  DB.data.users.push(user);
  DB.save();
  closeModal();
  notify(user.id, '👋 Account created', 'The Administrator created your account. Username: ' + username + ' — password: ' + username + '.');
  toast('Student account created.', 'success');
  render();
}

function adminEditStudent(id) {
  if (!isAdmin()) return;
  const s = studentById(id);
  if (!s) return;
  const opts = COURSES.map((c) => '<option' + (c === s.course ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
  const yrs = YEARS.map((y) => '<option' + (y === s.year ? ' selected' : '') + '>' + esc(y) + '</option>').join('');
  openModal(
    '<h3>Edit — ' + esc(s.name) + '</h3>' +
    '<div class="field"><label>Full name</label><input id="es-name" value="' + esc(s.name) + '"></div>' +
    '<div class="field"><label>Student No.</label><input id="es-no" value="' + esc(s.studentNo) + '"></div>' +
    '<div class="field"><label>Course</label><select id="es-course">' + opts + '</select></div>' +
    '<div class="field"><label>Year level</label><select id="es-year">' + yrs + '</select></div>' +
    '<div class="field"><label>Username</label><input id="es-user" value="' + esc(s.username) + '"></div>' +
    '<div class="field"><label>Tuition &amp; fees (₱)</label><input id="es-tuition" type="number" min="0" step="100" value="' + Number(s.tuition || 0) + '"></div>' +
    '<label class="check"><input type="checkbox" id="es-override" ' + (s.enrollOverride ? 'checked' : '') + '>' +
      '<span><b>Unlock enrollment (admin override)</b> — lets this student enlist even without full payment or an approved PN.</span></label>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn" onclick="App.adminSaveStudent(\'' + s.id + '\')">💾 Save changes</button>' +
    '</div>', true);
}

function adminSaveStudent(id) {
  if (!isAdmin()) return;
  const s = studentById(id);
  if (!s) return;
  const name = ($('#es-name').value || '').trim();
  const studentNo = ($('#es-no').value || '').trim();
  const course = $('#es-course').value;
  const year = $('#es-year').value;
  const username = ($('#es-user').value || '').trim().toLowerCase();
  const tuition = Number($('#es-tuition').value) || 0;
  const override = $('#es-override').checked;

  if (name.length < 3) return toast('Enter the student\'s full name.', 'error');
  if (!studentNo) return toast('Enter the student number.', 'error');
  if (username.length < 3 || !/^[a-z0-9._-]+$/.test(username)) return toast('Username must be 3+ characters (letters/numbers/._-).', 'error');
  if (DB.data.users.some((u) => u.id !== id && (u.username || '').toLowerCase() === username)) return toast('Username is already taken.', 'error');
  if (DB.data.users.some((u) => u.id !== id && u.role === 'student' && (u.studentNo || '') === studentNo)) return toast('Student number already registered.', 'error');
  if (tuition < 0) return toast('Tuition cannot be negative.', 'error');

  s.name = name; s.studentNo = studentNo; s.course = course; s.year = year;
  s.username = username; s.tuition = tuition;
  if (override) s.enrollOverride = true; else delete s.enrollOverride;
  DB.save();
  closeModal();
  toast('Student record updated.', 'success');
  render();
}

function adminResetPassword(id) {
  if (!isAdmin()) return;
  const u = DB.data.users.find((x) => x.id === id);
  if (!u) return;
  openModal(
    '<h3>Reset password — ' + esc(u.name) + '</h3>' +
    '<div class="field"><label>Username</label><input value="' + esc(u.username) + '" disabled></div>' +
    '<div class="field"><label>New password</label><input id="rp-pass" value="' + esc(u.username) + '"></div>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn" onclick="App.adminDoResetPassword(\'' + u.id + '\')">Set password</button>' +
    '</div>');
}

function adminDoResetPassword(id) {
  if (!isAdmin()) return;
  const u = DB.data.users.find((x) => x.id === id);
  if (!u) return;
  const pass = ($('#rp-pass').value || '').trim();
  if (pass.length < 3) return toast('Password must be at least 3 characters.', 'error');
  u.password = pass;
  DB.save();
  closeModal();
  notify(u.id, '🔑 Password changed', 'The Administrator set a new password for your account.');
  toast('Password updated for ' + u.name + '.', 'success');
  render();
}

function adminDeleteUser(id) {
  if (!isAdmin()) return;
  const u = DB.data.users.find((x) => x.id === id);
  if (!u) return;
  openModal(
    '<h3>Delete account?</h3>' +
    '<p class="muted">This permanently removes <b>' + esc(u.name) + '</b> (' + esc(u.username) + ') together with their payments, PNs, enrollment, and notifications. This cannot be undone.</p>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn red" onclick="App.doAdminDeleteUser(\'' + u.id + '\')">Delete account</button>' +
    '</div>');
}

function doAdminDeleteUser(id) {
  if (!isAdmin()) return;
  if (state.user.id === id) return toast('You cannot delete your own account.', 'error');
  const u = DB.data.users.find((x) => x.id === id);
  if (!u) return;
  DB.data.users = DB.data.users.filter((x) => x.id !== id);
  DB.data.payments = DB.data.payments.filter((p) => p.studentId !== id);
  DB.data.pns = DB.data.pns.filter((p) => p.studentId !== id);
  DB.data.enrollments = DB.data.enrollments.filter((e) => e.studentId !== id);
  DB.data.notifications = DB.data.notifications.filter((n) => n.toUserId !== id);
  DB.save();
  closeModal();
  toast('Account deleted: ' + u.name + '.', 'success');
  render();
}

function adminManageEnrollment(id) {
  if (!isAdmin()) return;
  const s = studentById(id);
  if (!s) return;
  const e = getEnrollment(id);
  const unlocked = canEnroll(id);
  const enrolled = e.status === 'Enrolled';
  const head = '<h3>🎓 Enrollment — ' + esc(s.name) + '</h3>' +
    '<p class="muted small">' + esc(s.studentNo) + ' · ' + esc(s.course) + ' — ' + esc(s.year) + '</p>';

  let body;
  if (enrolled) {
    const subs = e.subjects.map(subjectById).filter(Boolean);
    body = '<p class="ok-note">Officially enrolled on ' + fmtDateTime(e.confirmedAt) + ' · ' + unitsOf(e.subjects) + ' units.</p>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Code</th><th>Subject</th><th>Units</th><th>Schedule</th></tr></thead><tbody>' +
      subs.map((sub) => '<tr><td><b>' + esc(sub.code) + '</b></td><td>' + esc(sub.name) + '</td><td>' + sub.units + '</td><td>' + esc(sub.schedule) + '</td></tr>').join('') +
      '</tbody></table></div>';
  } else {
    body = '<p class="muted small">' + (unlocked
        ? 'Tick subjects to enlist on the student\'s behalf, then confirm.'
        : '⚠️ Enrollment is locked — enable the <b>admin override</b> in Edit student to enlist on their behalf.') + '</p>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th></th><th>Code</th><th>Subject</th><th>Units</th><th>Schedule</th></tr></thead><tbody>' +
      DB.data.subjects.map((sub) => {
        const on = e.subjects.includes(sub.id);
        return '<tr class="' + (on ? 'row-on' : '') + '"><td><input type="checkbox" ' + (on ? 'checked' : '') + ' ' + (unlocked ? '' : 'disabled') +
          ' onchange="App.adminToggleSubjectFor(\'' + id + '\',\'' + sub.id + '\')"></td>' +
          '<td><b>' + esc(sub.code) + '</b></td><td>' + esc(sub.name) + '</td><td>' + sub.units + '</td><td>' + esc(sub.schedule) + '</td></tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<div class="tot-row"><span>Units enlisted: <b>' + unitsOf(e.subjects) + '</b> / ' + MAX_UNITS + '</span></div>';
  }

  const actions = enrolled
    ? '<button class="btn ghost" onclick="App.closeModal()">Close</button>' +
      '<button class="btn red" onclick="App.adminResetEnrollment(\'' + id + '\')">↺ Reset enrollment</button>'
    : '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      (e.subjects.length ? '<button class="btn ghost" onclick="App.adminDropSubjects(\'' + id + '\')">Drop all</button>' : '') +
      '<button class="btn green" ' + (unlocked ? '' : 'disabled') + ' onclick="App.adminConfirmEnrollmentFor(\'' + id + '\')">✓ Confirm enrollment</button>';

  openModal(head + body + '<div class="modal-actions">' + actions + '</div>', true);
}

function adminToggleSubjectFor(sid, subId) {
  if (!isAdmin()) return;
  const e = getEnrollment(sid);
  if (e.status === 'Enrolled') return;
  if (!canEnroll(sid)) return toast('Enrollment is locked. Enable the admin override first.', 'error');
  const sub = subjectById(subId);
  if (!sub) return;
  const i = e.subjects.indexOf(subId);
  if (i >= 0) {
    e.subjects.splice(i, 1);
  } else if (unitsOf(e.subjects) + sub.units > MAX_UNITS) {
    return toast('Max load is ' + MAX_UNITS + ' units — cannot add ' + sub.code + '.', 'error');
  } else {
    e.subjects.push(subId);
  }
  DB.save();
  render();
  adminManageEnrollment(sid);
}

function adminDropSubjects(sid) {
  if (!isAdmin()) return;
  const e = getEnrollment(sid);
  if (e.status === 'Enrolled') return;
  e.subjects = [];
  DB.save();
  render();
  adminManageEnrollment(sid);
}

function adminConfirmEnrollmentFor(sid) {
  if (!isAdmin()) return;
  const s = studentById(sid), e = getEnrollment(sid);
  if (!s || e.status === 'Enrolled') return;
  if (!canEnroll(sid)) return toast('Enrollment is locked for this student.', 'error');
  if (!e.subjects.length) return toast('Enlist at least one subject first.', 'error');
  e.status = 'Enrolled';
  e.confirmedAt = new Date().toISOString();
  DB.save();
  notify(sid, '🎓 You are enrolled', 'The Administrator confirmed your enrollment for ' + e.sy + ' — ' + e.term + ' (' + unitsOf(e.subjects) + ' units).');
  closeModal();
  toast(s.name + ' is now enrolled.', 'success');
  render();
}

function adminResetEnrollment(id) {
  if (!isAdmin()) return;
  const s = studentById(id);
  if (!s) return;
  openModal(
    '<h3>Reset enrollment?</h3>' +
    '<p class="muted">This clears the confirmed enrollment and all enlisted subjects of <b>' + esc(s.name) + '</b> so they can enlist again.</p>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn red" onclick="App.doAdminResetEnrollment(\'' + id + '\')">Reset enrollment</button>' +
    '</div>');
}

function doAdminResetEnrollment(id) {
  if (!isAdmin()) return;
  const e = getEnrollment(id);
  e.subjects = [];
  e.status = 'Not Enrolled';
  e.confirmedAt = null;
  DB.save();
  closeModal();
  toast('Enrollment reset.', 'success');
  render();
}

function adminDeletePN(id) {
  if (!isAdmin()) return;
  const p = DB.data.pns.find((x) => x.id === id);
  if (!p) return;
  openModal(
    '<h3>Delete PN record?</h3>' +
    '<p class="muted"><b>' + esc(p.no) + '</b> — ' + PHP(p.amount) + ' for ' + esc((studentById(p.studentId) || {}).name || 'unknown student') + '. The record and any approval tied to it will be removed.</p>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn red" onclick="App.doAdminDeletePN(\'' + p.id + '\')">Delete PN</button>' +
    '</div>');
}

function doAdminDeletePN(id) {
  if (!isAdmin()) return;
  const p = DB.data.pns.find((x) => x.id === id);
  if (!p) return;
  DB.data.pns = DB.data.pns.filter((x) => x.id !== id);
  DB.save();
  closeModal();
  notify(p.studentId, '🗑 PN record removed', 'The Administrator removed Promissory Note ' + p.no + ' from your records.');
  toast('PN ' + p.no + ' deleted.', 'success');
  render();
}

function adminSendAnnouncement() {
  if (!isAdmin()) return;
  openModal(
    '<h3>📣 Send an announcement</h3>' +
    '<p class="muted small">Delivered to the bell / notification log of every selected account.</p>' +
    '<div class="field"><label>Audience</label><select id="an-to">' +
      '<option value="all">Everyone</option>' +
      '<option value="student">Students</option>' +
      '<option value="registrar">Registrar</option>' +
      '<option value="accounting">Accounting / Cashier</option>' +
    '</select></div>' +
    '<div class="field"><label>Title</label><input id="an-title" placeholder="e.g. Enrollment schedule"></div>' +
    '<div class="field"><label>Message</label><textarea id="an-msg" rows="3" placeholder="Type the announcement…"></textarea></div>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn" onclick="App.doAdminAnnounce()">Send</button>' +
    '</div>');
}

function doAdminAnnounce() {
  if (!isAdmin()) return;
  const to = $('#an-to').value;
  const title = ($('#an-title').value || '').trim();
  const msg = ($('#an-msg').value || '').trim();
  if (!title) return toast('Enter a title.', 'error');
  if (!msg) return toast('Enter a message.', 'error');
  const targets = to === 'all' ? DB.data.users.slice() : usersOf(to);
  targets.forEach((u) => notify(u.id, '📣 ' + title, msg));
  closeModal();
  toast('Announcement sent to ' + targets.length + ' account(s).', 'success');
  render();
}

function adminExportData() {
  if (!isAdmin()) return;
  const blob = new Blob([JSON.stringify(DB.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pn-system-backup-' + todayISO() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Backup downloaded.', 'success');
}

function adminImportData(input) {
  if (!isAdmin()) return;
  const f = input.files && input.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.users) || !Array.isArray(parsed.payments) || !Array.isArray(parsed.pns)) throw new Error('bad file');
      DB.data = parsed;
      if (!Array.isArray(DB.data.notifications)) DB.data.notifications = [];
      if (!Array.isArray(DB.data.enrollments)) DB.data.enrollments = [];
      if (!Array.isArray(DB.data.subjects)) DB.data.subjects = seedData().subjects;
      if (!DB.data.counters) DB.data.counters = { pn: 1 };
      DB.save();
      // Keep the current session pointing at the matching account in the imported data.
      const me = state.user ? DB.data.users.find((u) => u.id === state.user.id) : null;
      if (me) {
        state.user = me;
      } else {
        state.user = null;
        sessionStorage.removeItem(SESSION_KEY);
      }
      toast('Backup imported successfully.', 'success');
      render();
    } catch (e) {
      toast('That file is not a valid PN System backup.', 'error');
    }
  };
  reader.readAsText(f);
}

function adminClearNotifications() {
  if (!isAdmin()) return;
  openModal(
    '<h3>Clear the notification log?</h3>' +
    '<p class="muted">Every notification for every user will be erased. This cannot be undone.</p>' +
    '<div class="modal-actions">' +
      '<button class="btn ghost" onclick="App.closeModal()">Cancel</button>' +
      '<button class="btn red" onclick="App.doAdminClearNotifications()">Clear log</button>' +
    '</div>');
}

function doAdminClearNotifications() {
  if (!isAdmin()) return;
  DB.data.notifications = [];
  DB.save();
  closeModal();
  toast('Notification log cleared.', 'success');
  render();
}

/* ---------------- bootstrap ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  DB.init();
  const sid = sessionStorage.getItem(SESSION_KEY);
  if (sid) {
    const u = DB.data.users.find((x) => x.id === sid);
    if (u) state.user = u;
  }
  render();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); if (state.bellOpen) closeBell(); }
  });
});

/* expose handlers for inline onclick attributes */
window.App = {
  loginFromForm, quickLogin, logout, showRegister, doRegister, confirmReset, doReset,
  closeModal, toggleBell, closeBell, markAllRead,
  showFilePNModal, submitPN, showPNDetail, showApproveModal, showRejectModal, doDecide, printPN, buildPNDoc, pickId, handleIdFile,
  showPayModal, doRecordPayment, confirmDeletePayment, deletePayment, printReceipt, buildReceiptDoc,
  toggleSubject, confirmEnrollment, dropEnlistment,
  setAdminTab, adminAddStudent, adminSaveNewStudent, adminEditStudent, adminSaveStudent,
  adminResetPassword, adminDoResetPassword, adminDeleteUser, doAdminDeleteUser,
  adminManageEnrollment, adminToggleSubjectFor, adminDropSubjects, adminConfirmEnrollmentFor,
  adminResetEnrollment, doAdminResetEnrollment, adminDeletePN, doAdminDeletePN,
  adminSendAnnouncement, doAdminAnnounce, adminExportData, adminImportData,
  adminClearNotifications, doAdminClearNotifications
};
