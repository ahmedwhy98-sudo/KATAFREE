// public/app.js
const api = (path, opt = {}) =>
  fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(localStorage.token ? { Authorization: `Bearer ${localStorage.token}` } : {})
    },
    ...opt
  }).then(r => r.json());

/* Login/Register */
const authForm = document.getElementById('authForm');
if (authForm) {
  authForm.addEventListener('click', async (e) => {
    if (e.target.tagName === 'BUTTON') {
      e.preventDefault();
      const mode = e.target.getAttribute('data-mode');
      const form = new FormData(authForm);
      const data = Object.fromEntries(form.entries());
      const url = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await api(url, { method: 'POST', body: JSON.stringify(data) });
      const msg = document.getElementById('authMsg');
      if (res.error) {
        msg.textContent = res.error;
      } else {
        localStorage.token = res.token;
        msg.textContent = 'Success — Redirecting to dashboard...';
        setTimeout(() => (window.location = '/dashboard'), 700);
      }
    }
  });
}

/* Dashboard */
const tasksUL = document.getElementById('tasks');
const createTaskBtn = document.getElementById('createTask');
const logoutBtn = document.getElementById('logoutBtn');
const hookUrl = document.getElementById('hookUrl');
const addHookBtn = document.getElementById('addHook');
const hooksUL = document.getElementById('hooks');

async function ensureAuth() {
  if (!localStorage.token && window.location.pathname === '/dashboard') {
    window.location = '/login';
  }
}

async function loadTasks() {
  if (!tasksUL) return;
  const list = await api('/api/tasks');
  tasksUL.innerHTML = '';
  (list || []).forEach(t => {
    const li = document.createElement('li');
    li.className = 'p-4 rounded-xl border border-neutral-700 bg-neutral-800/40 flex items-center justify-between';
    li.innerHTML = `
      <div>
        <div class="font-bold">${t.title}</div>
        <div class="text-xs text-gray-400">Schedule: ${t.schedule || 'manual'} • ${t.enabled ? 'enabled' : 'disabled'}</div>
      </div>
      <div class="flex gap-2">
        <button data-act="toggle" data-id="${t.id}" class="border border-red-600 px-3 py-1 rounded-xl hover:bg-red-600/10">${t.enabled ? 'Disable' : 'Enable'}</button>
        <button data-act="delete" data-id="${t.id}" class="border border-neutral-600 px-3 py-1 rounded-xl hover:bg-neutral-600/10">Delete</button>
      </div>
    `;
    tasksUL.appendChild(li);
  });
}

async function loadHooks() {
  if (!hooksUL) return;
  const list = await api('/api/webhooks');
  hooksUL.innerHTML = '';
  (list || []).forEach(h => {
    const li = document.createElement('li');
    li.className = 'p-3 rounded-xl border border-neutral-700 bg-neutral-800/40 flex items-center justify-between';
    li.innerHTML = `
      <div class="truncate">${h.url}</div>
      <div class="flex gap-2">
        <button data-test="${h.id}" class="border border-red-600 px-3 py-1 rounded-xl hover:bg-red-600/10">Test</button>
      </div>
    `;
    hooksUL.appendChild(li);
  });
}

document.addEventListener('click', async (e) => {
  // Create task
  if (e.target.id === 'createTask') {
    const title = prompt('Task name?', 'New Task');
    if (!title) return;
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, enabled: true, schedule: 'manual' }) });
    loadTasks();
  }
  // Toggle / Delete
  if (e.target.dataset.act === 'toggle') {
    const id = e.target.dataset.id;
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.textContent.includes('Enable') }) });
    loadTasks();
  }
  if (e.target.dataset.act === 'delete') {
    const id = e.target.dataset.id;
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    loadTasks();
  }
  // Add Hook
  if (e.target.id === 'addHook') {
    if (!hookUrl.value) return alert('Enter webhook URL');
    await api('/api/webhooks/register', { method: 'POST', body: JSON.stringify({ url: hookUrl.value }) });
    hookUrl.value = '';
    loadHooks();
  }
  // Test Hook
  if (e.target.dataset.test) {
    const id = e.target.dataset.test;
    const res = await api(`/api/webhooks/test/${id}`, { method: 'POST' });
    alert(`Simulated to:\n${res.to}\n\nPayload:\n${JSON.stringify(res.payload, null, 2)}`);
  }
  // Logout
  if (e.target.id === 'logoutBtn') {
    localStorage.removeItem('token');
    window.location = '/';
  }
});

(async function init() {
  await ensureAuth();
  await loadTasks();
  await loadHooks();
})();