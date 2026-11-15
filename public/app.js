(() => {
  document.querySelectorAll('.search-top').forEach((searchBar) => searchBar.remove());
  let refreshPromise = null;
  const clearSession = () => {
    localStorage.removeItem('tutoreshub_access_token');
    localStorage.removeItem('tutoreshub_refresh_token');
    localStorage.removeItem('tutoreshub_user');
  };
  const redirectToLogin = () => {
    if (window.location.pathname.endsWith('/login.html') || window.location.pathname.endsWith('/index.html')) return;
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const next =
      /^(?:mi-cuenta|dashboard|disponibilidad|mis-tutorias|clases-impartidas|aula-virtual|resena|asistente-ia|buscar-tutor|perfil-tutor|reserva)\.(?:html)$/.test(
        currentPage,
      )
        ? currentPage
        : '';
    const loginPath = window.location.pathname.includes('/pages/') ? 'login.html' : 'pages/login.html';
    window.location.href = next ? `${loginPath}?next=${encodeURIComponent(next)}` : loginPath;
  };
  const refreshAccessToken = async () => {
    const refreshToken = localStorage.getItem('tutoreshub_refresh_token');
    if (!refreshToken) throw new Error('No hay refresh token disponible.');
    if (!refreshPromise) {
      refreshPromise = fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
        .then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok || !body.data?.accessToken) throw new Error(body?.error?.message || 'La sesión expiró.');
          localStorage.setItem('tutoreshub_access_token', body.data.accessToken);
          localStorage.setItem('tutoreshub_refresh_token', body.data.refreshToken || refreshToken);
          if (body.data.user) localStorage.setItem('tutoreshub_user', JSON.stringify(body.data.user));
          return body.data.accessToken;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  };
  const api = async (path, options = {}, canRefresh = true) => {
    const token = localStorage.getItem('tutoreshub_access_token');
    const response = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && canRefresh && token && !path.includes('/api/auth/refresh')) {
      try {
        await refreshAccessToken();
        return api(path, options, false);
      } catch (error) {
        clearSession();
        redirectToLogin();
        throw error;
      }
    }
    if (!response.ok) throw new Error(body?.error?.message || 'No se pudo completar la solicitud.');
    return body.data;
  };

  const feedback = (form, message, isError = true) => {
    let node = form.querySelector('[data-api-feedback]');
    if (!node) {
      node = document.createElement('p');
      node.dataset.apiFeedback = 'true';
      node.className = 'hint';
      form.appendChild(node);
    }
    node.textContent = message;
    node.style.color = isError ? '#b42318' : '#087552';
  };

  const value = (form, selector) => form.querySelector(selector)?.value?.trim() || undefined;
  const formatUSD = (amount) =>
    amount === null || amount === undefined || amount === ''
      ? 'Por definir'
      : `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const escapeHtml = (text) =>
    String(text).replace(
      /[&<>'"]/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[character],
    );
  const availabilityRules = (payload) => {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.availability)) return payload.availability;
    if (Array.isArray(payload?.data)) return payload.data;
    throw new Error(
      'El servicio devolvió la disponibilidad en un formato inesperado. Actualiza la página e inténtalo de nuevo.',
    );
  };
  const dateInTimezone = (dateValue, timeValue, timezone = 'America/Bogota') => {
    const [year, month, day] = dateValue.split('-').map(Number);
    const [hour, minute] = timeValue.split(':').map(Number);
    const desired = Date.UTC(year, month - 1, day, hour, minute);
    let timestamp = desired;
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(timestamp))
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, Number(part.value)]),
      );
      const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
      const correction = desired - represented;
      if (!correction) break;
      timestamp += correction;
    }
    return new Date(timestamp);
  };
  const renderMarkdown = (text) => {
    const source = escapeHtml(String(text || '')).replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const output = [];
    let inCode = false;
    let code = [];
    let list = null;
    let table = null;
    let tableHeaders = [];
    const inline = (value) =>
      value
        .replace(
          /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
        )
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
        .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');
    const closeList = () => {
      if (list) {
        output.push(`</${list}>`);
        list = null;
      }
    };
    const closeTable = () => {
      if (table) {
        output.push('</tbody></table>');
        table = null;
        tableHeaders = [];
      }
    };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        if (inCode) {
          output.push(`<pre><code>${code.join('\n')}</code></pre>`);
          code = [];
          inCode = false;
        } else {
          closeList();
          closeTable();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        code.push(line);
        continue;
      }
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      const nextCells = (lines[i + 1] || '')
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (
        cells.length > 1 &&
        nextCells.length === cells.length &&
        nextCells.every((cell) => /^:?-{3,}:?$/.test(cell))
      ) {
        closeList();
        closeTable();
        table = true;
        tableHeaders = cells;
        output.push(
          `<table><thead><tr>${cells.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>`,
        );
        i += 1;
        continue;
      }
      if (table && cells.length > 1) {
        output.push(
          `<tr>${cells.map((cell, index) => `<td${tableHeaders[index] ? ` data-label="${tableHeaders[index]}"` : ''}>${inline(cell)}</td>`).join('')}</tr>`,
        );
        continue;
      }
      if (!line.trim()) {
        closeList();
        closeTable();
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        closeList();
        closeTable();
        const level = Math.min(6, heading[1].length);
        output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        closeList();
        closeTable();
        output.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        continue;
      }
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (bullet || numbered) {
        const kind = numbered ? 'ol' : 'ul';
        if (list !== kind) {
          closeList();
          list = kind;
          output.push(`<${kind}>`);
        }
        output.push(`<li>${inline((bullet || numbered)[1])}</li>`);
        continue;
      }
      closeList();
      closeTable();
      output.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    closeTable();
    if (inCode) output.push(`<pre><code>${code.join('\n')}</code></pre>`);
    return output.join('');
  };
  const initialsFor = (name) => {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return '';
    return `${parts[0][0] || ''}${parts.length > 1 ? parts[parts.length - 1][0] || '' : ''}`.toLocaleUpperCase('es');
  };
  const avatarMarkup = (user, size = '') => {
    const name = user?.fullName || user?.full_name || '';
    let url = user?.avatar_url || user?.avatarUrl || '';
    if (url) {
      try {
        const parsed = new URL(url, window.location.origin);
        url = ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
      } catch {
        url = '';
      }
    }
    url = url.replace(/["'()\\]/g, (character) => encodeURIComponent(character));
    const classes = ['avatar', size, url ? 'has-avatar' : ''].filter(Boolean).join(' ');
    return `<span class="${classes}"${url ? ` style="background-image:url('${escapeHtml(url)}')"` : ''}>${url ? '' : escapeHtml(initialsFor(name))}</span>`;
  };
  const applyAvatar = (nodes, user) => {
    nodes.forEach((node) => {
      const url = user?.avatar_url || user?.avatarUrl || '';
      node.textContent = url ? '' : initialsFor(user?.fullName || user?.full_name || '');
      node.classList.toggle('has-avatar', Boolean(url));
      if (url) node.style.backgroundImage = `url("${String(url).replaceAll('"', '%22')}")`;
      else node.style.removeProperty('background-image');
      node.setAttribute('aria-label', url ? 'Foto de perfil' : 'Iniciales del usuario');
    });
  };
  const homeForRole = (role) =>
    window.location.pathname.includes('/pages/')
      ? role === 'tutor'
        ? 'dashboard-tutor.html'
        : 'dashboard-estudiante.html'
      : role === 'tutor'
        ? 'pages/dashboard-tutor.html'
        : 'pages/dashboard-estudiante.html';
  const shellRole = (value) => {
    const candidate = String(value || '')
      .trim()
      .toLowerCase();
    if (['tutor', 'teacher', 'professor', 'profesor', 'instructor'].includes(candidate)) return 'tutor';
    if (['student', 'learner', 'estudiante'].includes(candidate)) return 'student';
    return null;
  };
  const storedUserData = () => {
    try {
      return JSON.parse(localStorage.getItem('tutoreshub_user') || '{}') || {};
    } catch {
      return {};
    }
  };
  const currentPageName = () => (window.location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
  const TUTOR_PAGES = [
    'dashboard-tutor',
    'radar-solicitudes',
    'clases-impartidas',
    'disponibilidad',
    'mi-cuenta-tutor',
    'detalle-clase',
    'detalle-solicitud',
  ];
  const STUDENT_PAGES = [
    'dashboard-estudiante',
    'buscar-tutores',
    'mis-tutorias',
    'mi-cuenta-estudiante',
    'confirmacion',
    'detalle-tutoria',
    'negociacion',
    'resena',
    'reserva',
  ];
  const SHARED_PAGES = ['asistente-ia'];
  const ACTIVE_ALIAS = {
    'aula-virtual': { student: 'mis-tutorias', tutor: 'clases-impartidas' },
    'detalle-clase': 'clases-impartidas',
    'detalle-solicitud': 'radar-solicitudes',
    'detalle-tutoria': 'mis-tutorias',
    negociacion: 'mis-tutorias',
    confirmacion: 'mis-tutorias',
    resena: 'mis-tutorias',
    reserva: 'buscar-tutores',
    'perfil-tutor': 'buscar-tutores',
  };
  const svgIcon = (paths) => `<span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg></span>`;
  const SHELL_NAV = {
    student: [
      { key: 'dashboard-estudiante', label: 'Inicio', short: 'Inicio', icon: '<span class="icon">⌂</span>' },
      { key: 'buscar-tutores', label: 'Buscar tutores', short: 'Buscar', icon: '<span class="icon">⌕</span>' },
      { key: 'mis-tutorias', label: 'Mis tutorías', short: 'Mis', icon: '<span class="icon">◷</span>' },
      { key: 'asistente-ia', label: 'Asistente IA', short: 'Asistente', icon: '<span class="icon">✦</span>' },
      { key: 'chat', label: 'Chat', short: 'Chat', icon: '<span class="icon">◌</span>' },
      {
        key: 'mi-cuenta-estudiante',
        label: 'Mi cuenta',
        short: 'Cuenta',
        icon: '<span class="icon">◎</span>',
        desktopOnly: true,
      },
    ],
    tutor: [
      {
        key: 'dashboard-tutor',
        label: 'Resumen',
        short: 'Resumen',
        icon: svgIcon('<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10Z"/>'),
      },
      {
        key: 'radar-solicitudes',
        label: 'Radar de solicitudes',
        short: 'Radar',
        icon: svgIcon(
          '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 4V2M20 12h2M12 20v2M4 12H2"/>',
        ),
      },
      {
        key: 'clases-impartidas',
        label: 'Mis clases',
        short: 'Clases',
        icon: svgIcon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>'),
      },
      {
        key: 'disponibilidad',
        label: 'Disponibilidad',
        short: 'Horarios',
        icon: svgIcon(
          '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M7 2.5v4M17 2.5v4M3 9h18M7 13h.01M12 13h.01M17 13h.01M7 17h.01M12 17h.01"/>',
        ),
      },
      { key: 'asistente-ia', label: 'Asistente IA', short: 'Asistente', icon: '<span class="icon">✦</span>' },
      {
        key: 'chat',
        label: 'Chat',
        short: 'Chat',
        icon: svgIcon(
          '<path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 3v-3.2a2 2 0 0 1-2-1.8v-8a2 2 0 0 1 2-2Z"/><path d="M8 11.5h.01M12 11.5h.01M16 11.5h.01"/>',
        ),
      },
      {
        key: 'mi-cuenta-tutor',
        label: 'Mi cuenta',
        short: 'Cuenta',
        icon: svgIcon('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.2 3.1-5 7-5s6.2 1.8 7 5"/>'),
        desktopOnly: true,
      },
    ],
  };
  const MOBILE_ICONS = {
    'dashboard-estudiante': '⌂',
    'buscar-tutores': '⌕',
    'mis-tutorias': '◷',
    'asistente-ia': '✦',
    chat: '◌',
    'dashboard-tutor': '⌂',
    'radar-solicitudes': '⌁',
    'clases-impartidas': '◷',
    disponibilidad: '▦',
  };
  // Pinta el menú lateral según el rol REAL del usuario y bloquea páginas del otro rol.
  // Devuelve false si redirigió a otra página.
  const applyRoleShell = (role) => {
    if (!role) return true;
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return true;
    const page = currentPageName();
    const expected = TUTOR_PAGES.includes(page)
      ? 'tutor'
      : STUDENT_PAGES.includes(page)
        ? 'student'
        : SHARED_PAGES.includes(page)
          ? role
          : null;
    if (expected && expected !== role) {
      window.location.replace(homeForRole(role));
      return false;
    }
    const alias = ACTIVE_ALIAS[page];
    const active = (alias && (typeof alias === 'string' ? alias : alias[role])) || page;
    const items = SHELL_NAV[role];
    const nav = sidebar.querySelector('.side-nav');
    if (nav)
      nav.innerHTML = items
        .map(
          (item) =>
            `<a class="${item.key === active ? 'active' : ''}" href="${item.key}.html"${item.key === active ? ' aria-current="page"' : ''}>${item.icon}${item.label}</a>`,
        )
        .join('');
    const label = sidebar.querySelector('.sidebar-label');
    if (label) label.textContent = role === 'tutor' ? 'Tutor' : 'Estudiante';
    const roleText = sidebar.querySelector('.user-mini > div > span');
    if (roleText) roleText.textContent = role === 'tutor' ? 'Profesor' : 'Estudiante';
    const mobile = document.querySelector('.mobile-nav');
    if (mobile)
      mobile.innerHTML = items
        .filter((item) => !item.desktopOnly)
        .map(
          (item) =>
            `<a class="${item.key === active ? 'active' : ''}" href="${item.key}.html"><span class="icon">${MOBILE_ICONS[item.key] || '•'}</span><span>${item.short}</span></a>`,
        )
        .join('');
    return true;
  };
  if (document.querySelector('.app-shell') && !localStorage.getItem('tutoreshub_access_token')) redirectToLogin();
  else if (document.querySelector('.app-shell')) applyRoleShell(shellRole(storedUserData().role));
  const hydrateAuthenticatedShell = (incoming) => {
    const previous = storedUserData();
    const user = { ...incoming, role: shellRole(incoming.role) || shellRole(previous.role) || undefined };
    if (user.role && applyRoleShell(user.role) === false) return;
    const name = user.fullName || user.full_name || 'Mi cuenta';
    const home = homeForRole(user.role);
    localStorage.setItem('tutoreshub_user', JSON.stringify({ ...previous, ...user, fullName: name }));
    document.querySelectorAll('[data-current-user-name], [data-user-name]').forEach((node) => {
      node.textContent = name;
    });
    document.querySelectorAll('[data-user-email]').forEach((node) => {
      node.textContent = user.email || '';
    });
    applyAvatar(document.querySelectorAll('[data-user-initials]'), { ...user, fullName: name });
    document.querySelectorAll('[data-role-home]').forEach((node) => {
      node.href = home;
    });
    document.querySelectorAll('.brand').forEach((brand) => {
      brand.setAttribute('href', home);
      brand.setAttribute('aria-label', `Ir al inicio de ${user.role === 'tutor' ? 'profesor' : 'estudiante'}`);
      if (brand.tagName !== 'A') {
        brand.setAttribute('role', 'link');
        brand.tabIndex = 0;
        brand.onclick = () => {
          window.location.href = home;
        };
        brand.onkeydown = (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            window.location.href = home;
          }
        };
      }
    });
  };
  const openLogoutDialog = (target) => {
    let modal = document.querySelector('[data-logout-dialog]');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal';
      modal.dataset.logoutDialog = 'true';
      modal.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="logout-title"><span class="status warning">Sesión activa</span><h2 id="logout-title" style="margin-top:13px">¿Cerrar sesión?</h2><p class="muted">Tu sesión seguirá abierta si cancelas. Solo se cerrará cuando confirmes esta acción.</p><div class="row" style="justify-content:flex-end;margin-top:22px"><button class="btn btn-secondary" type="button" data-logout-cancel>Cancelar</button><button class="btn btn-danger" type="button" data-logout-confirm>Cerrar sesión</button></div></div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.classList.remove('is-open');
      });
    }
    modal.classList.add('is-open');
    modal.querySelector('[data-logout-cancel]').onclick = () => modal.classList.remove('is-open');
    modal.querySelector('[data-logout-confirm]').onclick = () => {
      localStorage.removeItem('tutoreshub_access_token');
      localStorage.removeItem('tutoreshub_refresh_token');
      localStorage.removeItem('tutoreshub_user');
      window.location.href = target || (window.location.pathname.includes('/pages/') ? '../index.html' : 'index.html');
    };
    modal.querySelector('[data-logout-confirm]').focus();
  };

  const openAppConfirm = ({ title, message, confirmLabel = 'Confirmar', onConfirm }) => {
    let modal = document.querySelector('[data-app-confirm-dialog]');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal';
      modal.dataset.appConfirmDialog = 'true';
      modal.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="app-confirm-title"><span class="status warning">Confirmación</span><h2 id="app-confirm-title" data-app-confirm-title style="margin-top:13px"></h2><p class="muted" data-app-confirm-message></p><p class="hint" data-app-confirm-feedback></p><div class="row" style="justify-content:flex-end;margin-top:22px"><button class="btn btn-secondary" type="button" data-app-confirm-cancel>Cancelar</button><button class="btn btn-primary" type="button" data-app-confirm-ok>Confirmar</button></div></div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.classList.remove('is-open');
      });
    }
    modal.querySelector('[data-app-confirm-title]').textContent = title;
    modal.querySelector('[data-app-confirm-message]').textContent = message;
    modal.querySelector('[data-app-confirm-ok]').textContent = confirmLabel;
    modal.querySelector('[data-app-confirm-feedback]').textContent = '';
    modal.classList.add('is-open');
    modal.querySelector('[data-app-confirm-cancel]').onclick = () => modal.classList.remove('is-open');
    modal.querySelector('[data-app-confirm-ok]').onclick = async () => {
      const button = modal.querySelector('[data-app-confirm-ok]');
      const feedbackNode = modal.querySelector('[data-app-confirm-feedback]');
      button.disabled = true;
      try {
        await onConfirm();
        modal.classList.remove('is-open');
      } catch (error) {
        feedbackNode.textContent = error.message || 'No se pudo completar la acción.';
        feedbackNode.style.color = '#b42318';
      } finally {
        button.disabled = false;
      }
    };
    modal.querySelector('[data-app-confirm-ok]').focus();
  };

  const openCancelDialog = (sessionButton) => {
    let modal = document.querySelector('[data-cancel-dialog]');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal';
      modal.dataset.cancelDialog = 'true';
      modal.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="cancel-title"><span class="status warning">Cancelación</span><h2 id="cancel-title" style="margin-top:13px">¿Cancelar tutoría?</h2><p class="muted">La otra persona recibirá un correo con el motivo. Escribe una razón breve.</p><div class="field" style="margin-top:16px"><label for="cancel-reason">Motivo</label><textarea id="cancel-reason" maxlength="255" minlength="3" required placeholder="Ej. Necesito reprogramar la sesión."></textarea><span class="hint">Máximo 255 caracteres.</span></div><p class="hint" data-cancel-feedback></p><div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn btn-secondary" type="button" data-cancel-close>Volver</button><button class="btn btn-danger" type="button" data-cancel-confirm>Cancelar tutoría</button></div></div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.classList.remove('is-open');
      });
    }
    const reasonInput = modal.querySelector('#cancel-reason');
    const feedbackNode = modal.querySelector('[data-cancel-feedback]');
    const confirm = modal.querySelector('[data-cancel-confirm]');
    reasonInput.value = '';
    feedbackNode.textContent = '';
    modal.classList.add('is-open');
    reasonInput.focus();
    modal.querySelector('[data-cancel-close]').onclick = () => modal.classList.remove('is-open');
    confirm.onclick = async () => {
      const reason = reasonInput.value.trim();
      if (reason.length < 3) {
        feedbackNode.textContent = 'Escribe un motivo de al menos 3 caracteres.';
        feedbackNode.style.color = '#b42318';
        reasonInput.focus();
        return;
      }
      confirm.disabled = true;
      sessionButton.disabled = true;
      try {
        await api(`/api/sessions/${encodeURIComponent(sessionButton.dataset.cancelSession)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        modal.classList.remove('is-open');
        window.location.reload();
      } catch (error) {
        confirm.disabled = false;
        sessionButton.disabled = false;
        feedbackNode.textContent = error.message;
        feedbackNode.style.color = '#b42318';
      }
    };
  };
  const openRejectRequestDialog = (requestId, trigger) => {
    let modal = document.querySelector('[data-reject-request-dialog]');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal';
      modal.dataset.rejectRequestDialog = 'true';
      modal.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="reject-request-title"><span class="status warning">Rechazar solicitud</span><h2 id="reject-request-title" style="margin-top:13px">¿Quieres rechazar esta solicitud?</h2><p class="muted">El estudiante recibirá un correo. Puedes añadir una razón, pero es opcional.</p><div class="field" style="margin-top:16px"><label for="reject-request-reason">Razón (opcional)</label><textarea id="reject-request-reason" maxlength="255" placeholder="Ej. No tengo disponibilidad en ese horario."></textarea><span class="hint">Máximo 255 caracteres.</span></div><p class="hint" data-reject-request-feedback></p><div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn btn-secondary" type="button" data-reject-request-close>Volver</button><button class="btn btn-danger" type="button" data-reject-request-confirm>Rechazar solicitud</button></div></div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.classList.remove('is-open');
      });
    }
    const reason = modal.querySelector('#reject-request-reason');
    const feedbackNode = modal.querySelector('[data-reject-request-feedback]');
    const confirm = modal.querySelector('[data-reject-request-confirm]');
    reason.value = '';
    feedbackNode.textContent = '';
    modal.classList.add('is-open');
    reason.focus();
    modal.querySelector('[data-reject-request-close]').onclick = () => modal.classList.remove('is-open');
    confirm.onclick = async () => {
      confirm.disabled = true;
      trigger.disabled = true;
      try {
        await api(`/api/requests/${encodeURIComponent(requestId)}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason: reason.value.trim() || undefined }),
        });
        modal.classList.remove('is-open');
        window.location.href = 'radar-solicitudes.html';
      } catch (error) {
        confirm.disabled = false;
        trigger.disabled = false;
        feedbackNode.textContent = error.message;
        feedbackNode.style.color = '#b42318';
      }
    };
  };

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cancel-session]');
    if (!button || button.disabled) return;
    event.preventDefault();
    openCancelDialog(button);
  });

  if (localStorage.getItem('tutoreshub_access_token')) {
    api('/api/me')
      .then(hydrateAuthenticatedShell)
      .catch(() => undefined);
  }

  const loginForm = document.querySelector('[data-api-form="login"]');
  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = loginForm.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        const result = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            email: value(loginForm, '[name="email"]'),
            password: value(loginForm, '[name="password"]'),
          }),
        });
        localStorage.setItem('tutoreshub_access_token', result.accessToken);
        localStorage.setItem('tutoreshub_refresh_token', result.refreshToken || '');
        localStorage.setItem('tutoreshub_user', JSON.stringify(result.user));
        const requestedNext = new URLSearchParams(window.location.search).get('next');
        const safeNext =
          requestedNext && /^(mi-cuenta-(tutor|estudiante)|dashboard-(tutor|estudiante))\.html$/.test(requestedNext)
            ? requestedNext
            : null;
        window.location.href =
          safeNext || (result.user.role === 'tutor' ? 'dashboard-tutor.html' : 'dashboard-estudiante.html');
      } catch (error) {
        feedback(loginForm, error.message);
        if (button) button.disabled = false;
      }
    });
  }

  const recoveryForm = document.querySelector('[data-password-recovery]');
  if (recoveryForm) {
    recoveryForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = recoveryForm.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        const redirectTo = new URL('reset-password.html', window.location.href).toString();
        const result = await api('/api/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email: value(recoveryForm, '[name="email"]'), redirectTo }),
        });
        feedback(recoveryForm, result.message, false);
      } catch (error) {
        feedback(recoveryForm, error.message);
      } finally {
        if (button) button.disabled = false;
      }
    });
  }
  const passwordUpdateForm = document.querySelector('[data-password-update]');
  if (passwordUpdateForm) {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');
    const code = params.get('code');
    const invalidLink = (message) => {
      feedback(passwordUpdateForm, message);
      passwordUpdateForm.querySelector('button[type="submit"]')?.setAttribute('disabled', 'true');
    };
    const prepareRecoverySession = async () => {
      if (accessToken) {
        localStorage.setItem('tutoreshub_access_token', accessToken);
        if (refreshToken) localStorage.setItem('tutoreshub_refresh_token', refreshToken);
        return true;
      }
      if (code) {
        const result = await api('/api/auth/exchange-recovery-code', {
          method: 'POST',
          body: JSON.stringify({ code }),
        });
        localStorage.setItem('tutoreshub_access_token', result.accessToken);
        localStorage.setItem('tutoreshub_refresh_token', result.refreshToken || '');
        return true;
      }
      return false;
    };
    prepareRecoverySession()
      .then((ready) => {
        if (!ready) invalidLink('El enlace no contiene una sesión válida. Solicita uno nuevo desde Iniciar sesión.');
      })
      .catch((error) => invalidLink(error.message));
    passwordUpdateForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = value(passwordUpdateForm, '[name="password"]');
      const repeat = value(passwordUpdateForm, '[name="passwordRepeat"]');
      if (password !== repeat) {
        feedback(passwordUpdateForm, 'Las contraseñas no coinciden.');
        return;
      }
      const button = passwordUpdateForm.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        const result = await api('/api/auth/update-password', { method: 'POST', body: JSON.stringify({ password }) });
        feedback(passwordUpdateForm, `${result.message} Redirigiendo a iniciar sesión…`, false);
        clearSession();
        setTimeout(() => {
          window.location.href = 'login.html?password_updated=1';
        }, 1400);
      } catch (error) {
        feedback(passwordUpdateForm, error.message);
        if (button) button.disabled = false;
      }
    });
  }

  document.querySelectorAll('[data-api-form="register"]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      const role =
        { estudiante: 'student', student: 'student', tutor: 'tutor', profesor: 'tutor', teacher: 'tutor' }[
          String(form.dataset.role || '').toLowerCase()
        ] || form.dataset.role;
      const isStudent = role === 'student';
      try {
        const password = value(form, '[name="password"]');
        const passwordRepeat = value(form, '[name="passwordRepeat"]');
        if (password !== passwordRepeat) throw new Error('Las contraseñas no coinciden.');
        const result = await api('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            role,
            fullName: value(form, '[name="fullName"]'),
            phone: value(form, '[name="phone"]'),
            email: value(form, '[name="email"]'),
            password,
            educationLevel: value(form, '[name="educationLevel"]'),
            learningGoal: isStudent ? value(form, '[name="learningGoal"]') : undefined,
            professionalTitle: !isStudent ? value(form, '[name="professionalTitle"]') : undefined,
            bio: !isStudent ? value(form, '[name="bio"]') : undefined,
            teachingModality: !isStudent ? 'both' : undefined,
          }),
        });
        if (result.accessToken) {
          localStorage.setItem('tutoreshub_access_token', result.accessToken);
          localStorage.setItem('tutoreshub_refresh_token', result.refreshToken || '');
          localStorage.setItem('tutoreshub_user', JSON.stringify(result.user || {}));
          const accountPage = result.user?.role === 'tutor' ? 'mi-cuenta-tutor.html' : 'mi-cuenta-estudiante.html';
          window.location.href = `${accountPage}?registered=1`;
        } else {
          const accountPage = result.user?.role === 'tutor' ? 'mi-cuenta-tutor.html' : 'mi-cuenta-estudiante.html';
          window.location.href = `login.html?registered=1&requiresEmailConfirmation=${result.requiresEmailConfirmation ? '1' : '0'}&email=${encodeURIComponent(result.user?.email || '')}&next=${encodeURIComponent(accountPage)}`;
        }
      } catch (error) {
        feedback(form, error.message);
        if (button) button.disabled = false;
      }
    });
  });

  const accountPage = document.querySelector('[data-account-page]');
  if (accountPage) {
    const role = accountPage.dataset.accountPage;
    const token = localStorage.getItem('tutoreshub_access_token');
    const loginTarget = role === 'tutor' ? 'mi-cuenta-tutor.html' : 'mi-cuenta-estudiante.html';
    if (!token) {
      window.location.href = `login.html?next=${encodeURIComponent(loginTarget)}`;
    } else {
      const endpoint = role === 'tutor' ? '/api/tutors/me/profile' : '/api/students/me/profile';
      const setField = (selector, fieldValue) => {
        const node = accountPage.querySelector(selector);
        if (node && fieldValue !== undefined && fieldValue !== null) node.value = fieldValue;
      };
      const renderIdentity = (user) => {
        accountPage.querySelectorAll('[data-user-name]').forEach((node) => {
          node.textContent = user.full_name || user.fullName || 'Mi cuenta';
        });
        accountPage.querySelectorAll('[data-user-email]').forEach((node) => {
          node.textContent = user.email || '';
        });
        applyAvatar(accountPage.querySelectorAll('[data-user-initials]'), user);
        hydrateAuthenticatedShell(user);
      };
      const avatarInput = accountPage.querySelector('[data-avatar-input]');
      const avatarRemove = accountPage.querySelector('[data-avatar-remove]');
      const avatarFeedback = accountPage.querySelector('[data-avatar-feedback]');
      const avatarFeedbackText = (message, error = true) => {
        if (avatarFeedback) {
          avatarFeedback.textContent = message;
          avatarFeedback.style.color = error ? '#b42318' : '#087552';
        }
      };
      const optimizeAvatar = (file) =>
        new Promise((resolve, reject) => {
          if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            reject(new Error('Selecciona una imagen JPG, PNG o WebP.'));
            return;
          }
          if (file.size > 300 * 1024) {
            reject(new Error('La foto original debe pesar máximo 300 KB.'));
            return;
          }
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
          reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error('La imagen no es válida.'));
            image.onload = () => {
              const canvas = document.createElement('canvas');
              canvas.width = 400;
              canvas.height = 400;
              const context = canvas.getContext('2d');
              if (!context) {
                reject(new Error('No se pudo optimizar la imagen.'));
                return;
              }
              const scale = Math.max(400 / image.width, 400 / image.height);
              const width = image.width * scale;
              const height = image.height * scale;
              context.drawImage(image, (400 - width) / 2, (400 - height) / 2, width, height);
              const dataUrl = canvas.toDataURL('image/webp', 0.82);
              const bytes = Math.ceil(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);
              if (bytes > 300 * 1024) {
                reject(new Error('La imagen optimizada supera 300 KB. Elige otra foto.'));
                return;
              }
              resolve(dataUrl);
            };
            image.src = String(reader.result);
          };
          reader.readAsDataURL(file);
        });
      avatarInput?.addEventListener('change', async () => {
        const file = avatarInput.files?.[0];
        if (!file) return;
        avatarInput.disabled = true;
        avatarFeedbackText('Optimizando foto…', false);
        try {
          const dataUrl = await optimizeAvatar(file);
          const updated = await api('/api/me/avatar', { method: 'PATCH', body: JSON.stringify({ dataUrl }) });
          renderIdentity(updated);
          avatarFeedbackText('Foto de perfil actualizada.', false);
        } catch (error) {
          avatarFeedbackText(error.message);
        } finally {
          avatarInput.disabled = false;
          avatarInput.value = '';
        }
      });
      avatarRemove?.addEventListener('click', async () => {
        avatarRemove.disabled = true;
        avatarFeedbackText('Eliminando foto…', false);
        try {
          const updated = await api('/api/me/avatar', { method: 'PATCH', body: JSON.stringify({ dataUrl: null }) });
          renderIdentity(updated);
          avatarFeedbackText('Foto eliminada.', false);
        } catch (error) {
          avatarFeedbackText(error.message);
        } finally {
          avatarRemove.disabled = false;
        }
      });
      const publicModal = document.querySelector('[data-public-profile-modal]');
      const publicContent = publicModal?.querySelector('[data-public-profile-content]');
      const publicButton = accountPage.querySelector('[data-open-public-profile]');
      let publicProfile = null;
      const closePublicModal = () => {
        publicModal?.classList.remove('is-open');
        publicModal?.setAttribute('aria-hidden', 'true');
      };
      const renderPublicProfile = (profile) => {
        if (!publicContent) return;
        const publicUser = profile.user || {};
        const name = publicUser.full_name || '';
        const title = profile.professional_title || 'Perfil profesional';
        const subjects = (profile.subjects || []).map((item) => item.subjects?.name || item.name).filter(Boolean);
        const blogs = (profile.blogs || []).filter((blog) => blog.status === 'published');
        const reviews = profile.reviews || [];
        const primarySubject =
          (profile.subjects || []).find((item) => item.is_primary && item.hourly_rate !== null) ||
          (profile.subjects || []).find((item) => item.hourly_rate !== null);
        const rate =
          primarySubject?.hourly_rate !== undefined
            ? `Desde ${formatUSD(primarySubject.hourly_rate)} / hora`
            : 'Tarifa por definir';
        const subjectRatesMarkup = (profile.subjects || [])
          .map((item) => {
            const subject = item.subjects || item;
            const subjectRate =
              item.hourly_rate === null || item.hourly_rate === undefined
                ? ''
                : ` · ${formatUSD(item.hourly_rate)} / hora`;
            return `<span class="tag">${escapeHtml(subject.name || 'Materia')}${escapeHtml(subjectRate)}</span>`;
          })
          .join('');
        const blogsMarkup = blogs.length
          ? blogs
              .map(
                (blog) =>
                  `<article class="public-blog-card"><div class="row-between"><strong>${escapeHtml(blog.title)}</strong><span class="muted small">${escapeHtml(new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium' }).format(new Date(blog.updated_at || blog.created_at)))}</span></div><p class="muted small" style="white-space:pre-wrap">${escapeHtml(blog.content)}</p></article>`,
              )
              .join('')
          : '<p class="muted small">Todavía no hay artículos publicados.</p>';
        const reviewsMarkup = reviews.length
          ? `<span class="status success">${Number(profile.average_rating || 0).toFixed(1)} / 5 · ${reviews.length} reseñas</span>`
          : '<span class="status info">Sin reseñas todavía</span>';
        publicContent.innerHTML = `<div class="public-profile-hero"><div class="profile-main">${avatarMarkup(publicUser, 'lg purple')}<div><h2>${escapeHtml(name)}</h2><p class="muted">${escapeHtml(title)}</p><div class="row">${reviewsMarkup}</div></div></div><strong class="public-profile-rate">${escapeHtml(rate)}</strong></div><div class="public-profile-grid"><section class="card"><h3>Sobre ${escapeHtml(name.split(' ')[0])}</h3><p class="muted">${escapeHtml(profile.bio || 'Este tutor todavía está completando su presentación profesional.')}</p><p class="small"><strong>Zona de atención:</strong> ${escapeHtml(profile.service_area || 'Por definir')}</p><div class="skill-list">${subjectRatesMarkup || (subjects.length ? subjects : [title]).map((subject) => `<span class="tag">${escapeHtml(subject)}</span>`).join('')}</div></section><section class="card"><h3>Blog del tutor</h3><p class="muted small">Contenido publicado para sus estudiantes.</p><div class="stack-sm" style="margin-top:12px">${blogsMarkup}</div></section></div>`;
      };
      publicButton?.addEventListener('click', () => {
        if (!publicProfile) return;
        renderPublicProfile(publicProfile);
        publicModal?.classList.add('is-open');
        publicModal?.setAttribute('aria-hidden', 'false');
      });
      publicModal?.querySelector('[data-public-profile-close]')?.addEventListener('click', closePublicModal);
      publicModal?.addEventListener('click', (event) => {
        if (event.target === publicModal) closePublicModal();
      });
      api(endpoint)
        .then((payload) => {
          const user = payload.user || {};
          const profile = role === 'tutor' ? payload : payload.profile || {};
          if (role === 'tutor') publicProfile = profile;
          renderIdentity(user);
          setField('[name="fullName"]', user.full_name || user.fullName);
          setField('[name="phone"]', user.phone || '');
          setField('input[type="email"]', user.email || '');
          if (role === 'student') {
            setField('[name="educationLevel"]', profile.education_level || 'Universidad');
            setField('[name="learningGoal"]', profile.learning_goal || '');
          } else {
            setField('[name="professionalTitle"]', profile.professional_title || '');
            setField('[name="bio"]', profile.bio || '');
            setField('[name="serviceArea"]', profile.service_area || '');
            const status = accountPage.querySelector('[data-profile-status]');
            if (status && profile.verification_status)
              status.textContent =
                profile.verification_status === 'verified' ? 'Perfil verificado' : 'Verificación pendiente';
          }
          const form = accountPage.querySelector('[data-account-form]');
          const params = new URLSearchParams(window.location.search);
          if (form && params.get('registered') === '1') {
            feedback(form, 'Cuenta creada correctamente.', false);
            params.delete('registered');
            const queryString = params.toString();
            history.replaceState(
              null,
              '',
              `${window.location.pathname}${queryString ? `?${queryString}` : ''}${window.location.hash}`,
            );
          }
          form?.addEventListener('submit', async (event) => {
            event.preventDefault();
            const button = form.querySelector('button[type="submit"]');
            openAppConfirm({
              title: 'Guardar cambios',
              message: '¿Deseas confirmar la actualización de tu perfil?',
              confirmLabel: 'Guardar cambios',
              onConfirm: async () => {
                if (button) button.disabled = true;
                try {
                  const body = { fullName: value(form, '[name="fullName"]'), phone: value(form, '[name="phone"]') };
                  if (role === 'student') {
                    body.educationLevel = value(form, '[name="educationLevel"]');
                    body.learningGoal = value(form, '[name="learningGoal"]');
                  } else {
                    body.professionalTitle = value(form, '[name="professionalTitle"]');
                    body.bio = value(form, '[name="bio"]');
                    body.serviceArea = value(form, '[name="serviceArea"]');
                  }
                  const updated = await api(endpoint, { method: 'PATCH', body: JSON.stringify(body) });
                  renderIdentity(updated.user || user);
                  feedback(form, 'Cambios guardados correctamente.', false);
                } catch (error) {
                  feedback(form, error.message);
                  throw error;
                } finally {
                  if (button) button.disabled = false;
                }
              },
            });
          });
        })
        .catch((error) => {
          const form = accountPage.querySelector('[data-account-form]');
          if (form) feedback(form, error.message);
        });
    }
  }

  const subjectManager = document.querySelector('[data-subject-manager]');
  if (subjectManager) {
    const list = subjectManager.querySelector('[data-subject-list]');
    const count = subjectManager.querySelector('[data-subject-count]');
    const form = subjectManager.querySelector('[data-subject-form]');
    const options = subjectManager.querySelector('#subject-options');
    const subjectIdInput = form.querySelector('[name="subjectId"]');
    const subjectSubmit = form.querySelector('[data-subject-submit]');
    const subjectCancel = form.querySelector('[data-subject-cancel]');
    const resetSubjectForm = () => {
      form.reset();
      subjectIdInput.value = '';
      subjectSubmit.textContent = 'Agregar materia';
      subjectCancel.hidden = true;
    };
    const renderSubjects = (items) => {
      if (count) count.textContent = `${items.length} ${items.length === 1 ? 'materia' : 'materias'}`;
      if (list)
        list.innerHTML = items.length
          ? items
              .map((item) => {
                const subject = item.subjects || {};
                return `<div class="subject-row"><div class="subject-row-name"><strong>${escapeHtml(subject.name || 'Materia')}</strong><span class="muted small">${escapeHtml(subject.description || 'Materia activa en tu perfil')}</span></div><span class="subject-row-description">${escapeHtml(subject.description || 'Materia activa en tu perfil')}</span><span class="subject-row-rate">${formatUSD(item.hourly_rate)} <small>/ hora</small></span><div class="subject-actions"><button class="btn btn-secondary btn-sm" type="button" data-edit-subject="${encodeURIComponent(item.subject_id)}">Editar</button><button class="subject-remove" type="button" aria-label="Quitar ${escapeHtml(subject.name || 'materia')}" title="Quitar materia" data-remove-subject="${encodeURIComponent(item.subject_id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div></div>`;
              })
              .join('')
          : '<div class="subject-empty"><p class="muted">Aún no tienes materias asociadas.</p><span>Agrega tu primera materia para mostrarla en tu perfil público.</span></div>';
      list?.querySelectorAll('[data-edit-subject]').forEach((button) =>
        button.addEventListener('click', () => {
          const item = items.find(
            (entry) => String(entry.subject_id) === decodeURIComponent(button.dataset.editSubject),
          );
          if (!item) return;
          const subject = item.subjects || {};
          subjectIdInput.value = item.subject_id;
          form.querySelector('[name="name"]').value = subject.name || '';
          form.querySelector('[name="description"]').value = subject.description || '';
          form.querySelector('[name="hourlyRate"]').value = item.hourly_rate ?? '';
          subjectSubmit.textContent = 'Guardar cambios';
          subjectCancel.hidden = false;
          form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }),
      );
      list?.querySelectorAll('[data-remove-subject]').forEach((button) =>
        button.addEventListener('click', () =>
          openAppConfirm({
            title: 'Quitar materia',
            message: '¿Deseas quitar esta materia y su tarifa de tu perfil?',
            confirmLabel: 'Quitar materia',
            onConfirm: async () => {
              button.disabled = true;
              try {
                await api(`/api/subjects/${button.dataset.removeSubject}`, { method: 'DELETE' });
                await loadSubjects();
              } catch (error) {
                button.disabled = false;
                feedback(form, error.message);
                throw error;
              }
            },
          }),
        ),
      );
    };
    const loadSubjects = async () => {
      const items = await api('/api/subjects/mine');
      renderSubjects(items);
    };
    api('/api/subjects')
      .then((items) => {
        if (options)
          options.innerHTML = items
            .map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.description || '')}</option>`)
            .join('');
      })
      .catch((error) => feedback(form, error.message));
    loadSubjects().catch((error) => {
      if (list) list.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
    });
    subjectCancel?.addEventListener('click', resetSubjectForm);
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        name: value(form, '[name="name"]'),
        description: value(form, '[name="description"]') || null,
        hourlyRate: Number(value(form, '[name="hourlyRate"]') || 0),
      };
      if (subjectIdInput.value) {
        openAppConfirm({
          title: 'Guardar cambios de materia',
          message:
            '¿Confirmas la edición? El nombre y la descripción pertenecen al catálogo compartido y pueden verse actualizados en otros perfiles.',
          confirmLabel: 'Guardar cambios',
          onConfirm: async () => {
            subjectSubmit.disabled = true;
            try {
              await api(`/api/subjects/${encodeURIComponent(subjectIdInput.value)}`, {
                method: 'PATCH',
                body: JSON.stringify(payload),
              });
              feedback(form, 'Materia actualizada correctamente.', false);
              resetSubjectForm();
              await loadSubjects();
            } finally {
              subjectSubmit.disabled = false;
            }
          },
        });
        return;
      }
      subjectSubmit.disabled = true;
      try {
        await api('/api/subjects', { method: 'POST', body: JSON.stringify({ ...payload, isPrimary: false }) });
        feedback(form, 'Materia guardada en tu perfil.', false);
        resetSubjectForm();
        await loadSubjects();
      } catch (error) {
        feedback(form, error.message);
      } finally {
        subjectSubmit.disabled = false;
      }
    });
  }

  const blogManager = document.querySelector('[data-blog-manager]');
  if (blogManager) {
    const list = blogManager.querySelector('[data-blog-list]');
    const count = blogManager.querySelector('[data-blog-count]');
    const form = blogManager.querySelector('[data-blog-form]');
    const cancel = blogManager.querySelector('[data-blog-cancel]');
    const renderBlogs = (items) => {
      if (count) count.textContent = `${items.length} ${items.length === 1 ? 'publicación' : 'publicaciones'}`;
      if (list)
        list.innerHTML = items.length
          ? items
              .map(
                (blog) =>
                  `<article class="card"><div class="row-between"><div><span class="status ${blog.status === 'published' ? 'success' : 'info'}">${blog.status === 'published' ? 'Publicado' : 'Borrador'}</span><h3 style="margin-top:8px">${escapeHtml(blog.title)}</h3></div><span class="muted small">${new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium' }).format(new Date(blog.updated_at))}</span></div><p class="muted small" style="white-space:pre-wrap">${escapeHtml(blog.content.slice(0, 240))}${blog.content.length > 240 ? '…' : ''}</p><div class="row"><button class="btn btn-secondary btn-sm" type="button" data-edit-blog="${encodeURIComponent(blog.id)}">Editar</button><button class="btn btn-ghost btn-sm" type="button" data-delete-blog="${encodeURIComponent(blog.id)}">Eliminar</button></div></article>`,
              )
              .join('')
          : '<div class="card ghost" style="text-align:center;padding:24px"><p class="muted">Todavía no has publicado artículos.</p></div>';
      list?.querySelectorAll('[data-edit-blog]').forEach((button) =>
        button.addEventListener('click', () => {
          const blog = items.find((item) => item.id === decodeURIComponent(button.dataset.editBlog));
          if (!blog) return;
          form.querySelector('[name="blogId"]').value = blog.id;
          form.querySelector('[name="title"]').value = blog.title;
          form.querySelector('[name="content"]').value = blog.content;
          form.querySelector('[data-blog-submit]').textContent = 'Guardar cambios';
          cancel.hidden = false;
          form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }),
      );
      list?.querySelectorAll('[data-delete-blog]').forEach((button) =>
        button.addEventListener('click', () =>
          openAppConfirm({
            title: 'Eliminar artículo',
            message: 'Esta acción no se puede deshacer. ¿Deseas eliminar esta publicación?',
            confirmLabel: 'Eliminar',
            onConfirm: async () => {
              button.disabled = true;
              try {
                await api(`/api/tutors/me/blogs/${button.dataset.deleteBlog}`, { method: 'DELETE' });
                await loadBlogs();
              } catch (error) {
                feedback(form, error.message);
                button.disabled = false;
                throw error;
              }
            },
          }),
        ),
      );
    };
    const loadBlogs = async () => renderBlogs(await api('/api/tutors/me/blogs'));
    loadBlogs().catch((error) => {
      if (list) list.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
    });
    cancel?.addEventListener('click', () => {
      form.reset();
      form.querySelector('[name="blogId"]').value = '';
      form.querySelector('[data-blog-submit]').textContent = 'Publicar artículo';
      cancel.hidden = true;
    });
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('[data-blog-submit]');
      const id = value(form, '[name="blogId"]');
      const save = async () => {
        button.disabled = true;
        try {
          await api(id ? `/api/tutors/me/blogs/${encodeURIComponent(id)}` : '/api/tutors/me/blogs', {
            method: id ? 'PATCH' : 'POST',
            body: JSON.stringify({
              title: value(form, '[name="title"]'),
              content: value(form, '[name="content"]'),
              status: 'published',
            }),
          });
          feedback(form, id ? 'Artículo actualizado.' : 'Artículo publicado.', false);
          cancel?.click();
          await loadBlogs();
        } catch (error) {
          feedback(form, error.message);
          if (id) throw error;
        } finally {
          button.disabled = false;
        }
      };
      if (id)
        openAppConfirm({
          title: 'Confirmar cambios',
          message: '¿Deseas guardar los cambios de este material?',
          confirmLabel: 'Guardar cambios',
          onConfirm: save,
        });
      else await save();
    });
  }

  const tutorSearch = document.querySelector('[data-tutor-search]');
  if (tutorSearch) {
    const form = tutorSearch.querySelector('[data-tutor-filters]');
    const tutorList = tutorSearch.querySelector('[data-tutor-list]');
    const count = tutorSearch.querySelector('[data-tutor-count]');
    const subjectSelect = form.querySelector('[name="subject"]');
    const levelSelect = form.querySelector('[name="educationLevel"]');
    const modalitySelect = form.querySelector('[name="modality"]');
    const areaOptions = tutorSearch.querySelector('#tutor-filter-areas');
    const minRateInput = form.querySelector('[name="minRate"]');
    const maxRateInput = form.querySelector('[name="maxRate"]');
    const daySelect = form.querySelector('[name="availabilityDay"]');
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    let requestSequence = 0;
    let debounceTimer;

    const renderTutorCards = (tutors) => {
      if (count)
        count.textContent = `${tutors.length} ${tutors.length === 1 ? 'tutor encontrado' : 'tutores encontrados'}`;
      if (!tutors.length) {
        tutorList.innerHTML =
          '<div class="card" style="grid-column:1/-1;text-align:center;padding:42px 24px"><p class="muted">No hay tutores registrados que coincidan con esos filtros.</p></div>';
        return;
      }
      tutorList.innerHTML = tutors
        .map((tutor) => {
          const id = tutor.tutor_id;
          const name = tutor.full_name || '';
          const title = tutor.professional_title || 'Tutor';
          const subjects = tutor.subjects || title;
          const modality =
            tutor.teaching_modality === 'online'
              ? 'Virtual'
              : tutor.teaching_modality === 'in_person'
                ? 'Presencial'
                : 'Virtual y presencial';
          const rate =
            tutor.hourly_rate === null || tutor.hourly_rate === undefined
              ? 'Tarifa por definir'
              : `${formatUSD(tutor.hourly_rate)} / hora`;
          const days = (tutor.availability_days || [])
            .map((day) => dayNames[Number(day)])
            .filter(Boolean)
            .join(', ');
          const levels = (tutor.education_levels || []).join(', ');
          return `<article class="card tutor-card"><div class="tutor-top"><div class="tutor-id">${avatarMarkup(tutor)}<div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(title)}</span></div></div><span class="status ${tutor.verification_status === 'verified' ? 'success' : 'info'}">${tutor.verification_status === 'verified' ? 'Verificado' : 'Perfil activo'}</span></div><div class="row"><span class="status info">${escapeHtml(subjects)}</span><span class="muted small">${Number(tutor.review_count || 0)} reseñas</span></div><div class="meta"><span>◉ ${escapeHtml(modality)}</span>${levels ? `<span>▥ ${escapeHtml(levels)}</span>` : ''}<span>◷ ${escapeHtml(days)}</span>${tutor.service_area ? `<span>⌖ ${escapeHtml(tutor.service_area)}</span>` : ''}</div><div class="row-between"><strong>${escapeHtml(rate)}</strong><a class="btn btn-secondary btn-sm" href="perfil-tutor.html?tutor=${encodeURIComponent(id)}">Ver perfil</a></div></article>`;
        })
        .join('');
    };

    const loadTutors = async () => {
      const currentRequest = ++requestSequence;
      const params = new URLSearchParams();
      new FormData(form).forEach((rawValue, key) => {
        const fieldValue = String(rawValue).trim();
        if (fieldValue) params.set(key, fieldValue);
      });
      const minimum = Number(params.get('minRate'));
      const maximum = Number(params.get('maxRate'));
      if (params.has('minRate') && params.has('maxRate') && minimum > maximum) {
        if (count) count.textContent = 'Revisa el rango de tarifas';
        tutorList.innerHTML =
          '<div class="card" style="grid-column:1/-1;text-align:center;padding:42px 24px"><p class="muted">La tarifa mínima no puede superar la tarifa máxima.</p></div>';
        return;
      }
      if (count) count.textContent = 'Actualizando resultados…';
      try {
        const queryString = params.toString();
        const tutors = await api(`/api/tutors${queryString ? `?${queryString}` : ''}`);
        if (currentRequest === requestSequence) renderTutorCards(tutors);
      } catch (error) {
        if (currentRequest !== requestSequence) return;
        if (count) count.textContent = 'No se pudieron cargar los tutores';
        tutorList.innerHTML = `<div class="card" style="grid-column:1/-1;text-align:center;padding:42px 24px"><p class="muted">${escapeHtml(error.message)}</p></div>`;
      }
    };

    api('/api/tutors/filter-options')
      .then((filters) => {
        subjectSelect.innerHTML =
          '<option value="">Todas las materias</option>' +
          filters.subjects
            .map((subject) => `<option value="${escapeHtml(subject.name)}">${escapeHtml(subject.name)}</option>`)
            .join('');
        levelSelect.innerHTML =
          '<option value="">Todos los niveles</option>' +
          filters.educationLevels
            .map((level) => `<option value="${escapeHtml(level)}">${escapeHtml(level)}</option>`)
            .join('');
        modalitySelect.innerHTML =
          '<option value="">Cualquier modalidad</option>' +
          filters.modalities
            .map(
              (modality) => `<option value="${modality}">${modality === 'online' ? 'Virtual' : 'Presencial'}</option>`,
            )
            .join('');
        daySelect.innerHTML =
          '<option value="">Cualquier día</option>' +
          filters.availabilityDays.map((day) => `<option value="${day}">${dayNames[day]}</option>`).join('');
        if (areaOptions)
          areaOptions.innerHTML = filters.areas.map((area) => `<option value="${escapeHtml(area)}"></option>`).join('');
        if (filters.rates) {
          minRateInput.placeholder = `Mín. ${Number(filters.rates.min).toFixed(2)}`;
          maxRateInput.placeholder = `Máx. ${Number(filters.rates.max).toFixed(2)}`;
        }
      })
      .catch((error) => {
        if (count) count.textContent = error.message;
      });

    form.addEventListener('input', () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(loadTutors, 250);
    });
    form.addEventListener('change', loadTutors);
    form.addEventListener('reset', () => window.setTimeout(loadTutors, 0));
    loadTutors();
  }

  const studentDashboard = document.querySelector('[data-student-dashboard]');
  if (studentDashboard) {
    const formatHours = (hours) => `${Number(hours || 0).toLocaleString('es-CO', { maximumFractionDigits: 2 })} h`;
    api('/api/students/me/metrics')
      .then((metrics) => {
        const totalHours = Number(metrics.totalHours || 0);
        const completedCount = Number(metrics.completedCount || 0);
        const streakDays = Number(metrics.streakDays || 0);
        const weeklyProgress = Number(metrics.weeklyProgress || 0);
        studentDashboard
          .querySelector('[data-student-metric="totalHours"]')
          ?.replaceChildren(document.createTextNode(formatHours(totalHours)));
        studentDashboard
          .querySelector('[data-student-metric="completedCount"]')
          ?.replaceChildren(document.createTextNode(String(completedCount)));
        studentDashboard
          .querySelector('[data-student-metric="streakDays"]')
          ?.replaceChildren(document.createTextNode(`${streakDays} ${streakDays === 1 ? 'día' : 'días'}`));
        studentDashboard
          .querySelector('[data-student-metric="weeklyProgress"]')
          ?.replaceChildren(document.createTextNode(`${weeklyProgress}%`));
        const progress = studentDashboard.querySelector('[data-student-progress]');
        if (progress) progress.style.width = `${weeklyProgress}%`;
        const summary = studentDashboard.querySelector('[data-student-summary]');
        if (summary)
          summary.textContent = completedCount
            ? `Ya completaste ${completedCount} ${completedCount === 1 ? 'tutoría' : 'tutorías'} y acumulaste ${formatHours(totalHours)} de aprendizaje.`
            : 'Todavía no tienes tutorías completadas. Cuando termines una sesión, tu progreso aparecerá aquí.';
        const notes = {
          totalHours: totalHours ? 'Tiempo acumulado en tutorías completadas' : 'Aún sin sesiones completadas',
          completedCount: completedCount ? 'Tutorías completadas' : 'Sin tutorías completadas',
          streakDays: streakDays ? 'Días consecutivos con tutoría' : 'Comienza tu primera meta',
        };
        Object.entries(notes).forEach(([key, text]) => {
          const node = studentDashboard.querySelector(`[data-student-metric-note="${key}"]`);
          if (node) node.textContent = text;
        });
      })
      .catch(() => undefined);
  }

  const primaryTutor = document.querySelector('[data-primary-tutor]');
  if (primaryTutor) {
    const tutorList = primaryTutor.parentElement;
    const tutorSectionHeading = tutorList.previousElementSibling;
    const tutorHeading = tutorSectionHeading?.querySelector('h2');
    const tutorDescription = tutorSectionHeading?.querySelector('p');
    const browseTutorsLink = tutorSectionHeading?.querySelector('a');
    if (tutorHeading) tutorHeading.textContent = 'Tutores disponibles';
    if (tutorDescription)
      tutorDescription.textContent =
        'Explora los perfiles de tutores registrados y disponibles para recibir solicitudes.';
    if (browseTutorsLink) {
      browseTutorsLink.href = 'buscar-tutores.html';
      browseTutorsLink.textContent = 'Ver todos';
    }
    tutorList.innerHTML = '<p class="muted">Cargando tutores disponibles…</p>';
    api('/api/tutors')
      .then((tutors) => {
        if (!tutors.length) {
          tutorList.innerHTML = '<p class="muted">Todavía no hay tutores con perfil y disponibilidad publicados.</p>';
          return;
        }
        tutorList.innerHTML = tutors
          .map((tutor) => {
            const id = tutor.tutor_id || tutor.id;
            const name = tutor.full_name || 'Tutor de ÁgoraHub';
            const title = tutor.professional_title || 'Perfil profesional';
            const modality =
              tutor.teaching_modality === 'online'
                ? 'Virtual'
                : tutor.teaching_modality === 'in_person'
                  ? 'Presencial'
                  : 'Virtual y presencial';
            const rate =
              tutor.hourly_rate === null || tutor.hourly_rate === undefined
                ? 'Tarifa por definir'
                : `${formatUSD(tutor.hourly_rate)}<span class="muted small"> / hora</span>`;
            const days =
              (tutor.availability_days || [])
                .map((day) => ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][Number(day)])
                .filter(Boolean)
                .join(', ') || 'Horario por confirmar';
            const reviewCount = Number(tutor.review_count || 0);
            const status = tutor.verification_status === 'verified' ? 'Verificado' : 'Perfil activo';
            return `<article class="card tutor-card"><div class="tutor-top"><div class="tutor-id">${avatarMarkup(tutor)}<div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(title)}</span></div></div><span class="status ${tutor.verification_status === 'verified' ? 'success' : 'info'}">${status}</span></div><div class="row"><span class="status info">${escapeHtml(tutor.subjects || title)}</span><span class="muted small">${reviewCount} ${reviewCount === 1 ? 'reseña' : 'reseñas'}</span></div><div class="meta"><span>◉ ${escapeHtml(modality)}</span><span>◷ ${escapeHtml(days)}</span></div><div class="row-between"><strong>${rate}</strong><a class="btn btn-secondary btn-sm" href="perfil-tutor.html?tutor=${encodeURIComponent(id)}">Ver perfil</a></div></article>`;
          })
          .join('');
      })
      .catch((error) => {
        tutorList.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
      });
  }

  const tutorProfile = document.querySelector('[data-tutor-profile]');
  if (tutorProfile) {
    const requestedTutor = new URLSearchParams(window.location.search).get('tutor');
    const loadProfile = requestedTutor
      ? api(`/api/tutors/${encodeURIComponent(requestedTutor)}`)
      : api('/api/tutors').then((tutors) => {
          if (!tutors.length) throw new Error('Todavía no hay perfiles de profesor publicados.');
          return api(`/api/tutors/${encodeURIComponent(tutors[0].tutor_id || tutors[0].id)}`);
        });
    loadProfile
      .then((profile) => {
        const user = profile.user || {};
        const name = user.full_name || '';
        const title = profile.professional_title || 'Perfil profesional en construcción';
        const subjects = (profile.subjects || []).map((item) => item.subjects?.name || item.name).filter(Boolean);
        const availability = profile.availability || [];
        const reviews = profile.reviews || [];
        const reviewsMarkup = reviews.length
          ? reviews
              .map(
                (review) =>
                  `<article class="review-item"><div class="row-between"><strong>${escapeHtml(review.student_name || 'Estudiante')}</strong><span class="rating">${'★'.repeat(Number(review.rating || 0))}${'☆'.repeat(5 - Number(review.rating || 0))}</span></div><p class="muted small">${escapeHtml(review.comment || 'El estudiante no dejó comentario.')}</p><span class="muted small">${new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium' }).format(new Date(review.created_at))}</span></article>`,
              )
              .join('')
          : '<p class="muted">Todavía no hay reseñas publicadas.</p>';
        const rate =
          profile.hourly_rate === null || profile.hourly_rate === undefined
            ? 'Tarifa por definir'
            : `Desde ${formatUSD(profile.hourly_rate)} / hora`;
        const subjectRatesMarkup = (profile.subjects || [])
          .map((item) => {
            const subject = item.subjects || item;
            const subjectRate =
              item.hourly_rate === null || item.hourly_rate === undefined
                ? ''
                : ` · ${formatUSD(item.hourly_rate)} / hora`;
            return `<span class="tag">${escapeHtml(subject.name || 'Materia')}${escapeHtml(subjectRate)}</span>`;
          })
          .join('');
        tutorProfile.innerHTML = `<div class="eyebrow">Descubrir · Perfil del tutor</div><div class="page-heading"><div><h1>Conoce a tu próximo tutor</h1><p class="lead">Información profesional guardada en ÁgoraHub.</p></div><a class="btn btn-secondary" href="buscar-tutores.html">← Volver a resultados</a></div><section class="stack"><div class="profile-hero"><div class="profile-main">${avatarMarkup(user, 'lg')}<div><h1>${escapeHtml(name)}</h1><p>${escapeHtml(title)}</p><div class="row"><span class="status ${profile.verification_status === 'verified' ? 'success' : 'info'}">${profile.verification_status === 'verified' ? 'Tutor verificado' : 'Perfil activo'}</span><span class="muted small">${Number(profile.review_count || 0)} reseñas</span></div></div></div><div class="row"><strong style="font-size:22px">${rate}</strong><a class="btn btn-secondary" href="chat.html?tutor=${encodeURIComponent(user.id || '')}">Chat con el tutor</a><a class="btn btn-primary" href="reserva.html?tutor=${encodeURIComponent(user.id || '')}">Solicitar tutoría →</a></div></div><div class="grid grid-sidebar"><div class="stack"><section class="card"><h2>Sobre ${escapeHtml(name.split(' ')[0])}</h2><p class="muted">${escapeHtml(profile.bio || 'Este tutor todavía está completando su presentación profesional.')}</p><p class="small"><strong>Zona de atención:</strong> ${escapeHtml(profile.service_area || 'Por definir')}</p><div class="skill-list">${subjectRatesMarkup || (subjects.length ? subjects : [title]).map((subject) => `<span class="tag">${escapeHtml(subject)}</span>`).join('')}</div></section><section class="card"><div class="row-between"><h2>Reputación</h2><span class="status info">${profile.review_count ? `${Number(profile.average_rating).toFixed(1)} / 5` : 'Sin reseñas'}</span></div><div class="stack-sm" style="margin-top:14px">${reviewsMarkup}</div></section></div><section class="card"><h2>Blog del tutor</h2><div class="stack-sm" style="margin-top:14px">${(profile.blogs || []).length ? profile.blogs.map((blog) => `<article class="public-blog-card"><h3>${escapeHtml(blog.title)}</h3><p class="muted small" style="white-space:pre-wrap">${escapeHtml(blog.content)}</p></article>`).join('') : '<p class="muted small">Este tutor aún no ha publicado artículos.</p>'}</div></section></div><aside class="card"><div class="row-between"><h2>Disponibilidad</h2><span class="status info">${availability.length ? 'Configurada' : 'A confirmar'}</span></div><p class="muted small">${availability.length ? `${availability.length} bloques de disponibilidad guardados.` : 'El tutor confirmará el horario después de revisar tu solicitud.'}</p><hr class="divider"><div class="row-between small"><span class="muted">Modalidad</span><strong>${profile.teaching_modality === 'online' ? 'Virtual' : profile.teaching_modality === 'in_person' ? 'Presencial' : 'Virtual y presencial'}</strong></div><div class="row-between small" style="margin-top:10px"><span class="muted">Zona</span><strong>${escapeHtml(profile.service_area || 'Por definir')}</strong></div></aside></div></section>`;
      })
      .catch((error) => {
        const status = tutorProfile.querySelector('[data-profile-status]');
        if (status) status.textContent = error.message;
      });
  }

  const reservationPage = document.querySelector('[data-reservation-page]');
  if (reservationPage) {
    const requestedTutor = new URLSearchParams(window.location.search).get('tutor');
    let reservationTutorId = requestedTutor || null;
    let reservationAvailability = [];
    let selectedRule = null;
    let tutorHourlyRate = 0;
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const modalityLabel = (modality) =>
      ({ online: 'Virtual', in_person: 'Presencial', both: 'Virtual y presencial' })[modality] || 'No especificada';
    const form = reservationPage.querySelector('[data-api-form="request"]');
    const blockSelect = form?.querySelector('[data-availability-select]');
    const educationLevelSelect = form?.querySelector('[name="educationLevelId"]');
    const dateInput = form?.querySelector('[data-reservation-date]');
    const timeSelect = form?.querySelector('[data-reservation-time]');
    const durationSelect = form?.querySelector('[data-reservation-duration]');
    const budgetInput = form?.querySelector('[data-reservation-budget]');
    const totalNode = form?.querySelector('[data-reservation-total]');
    const reservationAvatar = reservationPage.querySelector('aside .row > .avatar');
    if (reservationAvatar) reservationAvatar.textContent = '';
    const toMinutes = (value) => {
      const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
      return hours * 60 + minutes;
    };
    const timeText = (minutes) => {
      const date = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
      return new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(date);
    };
    const dateForNextDay = (day) => {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const offset = (Number(day) - now.getDay() + 7) % 7;
      now.setDate(now.getDate() + offset);
      return now;
    };
    const dateString = (date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const updateTotal = () => {
      const rate = Number(budgetInput?.value || 0);
      const hours = Number(durationSelect?.value || 0);
      if (totalNode)
        totalNode.textContent = `$${(rate * hours).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
    };
    let selectedIntervals = [];
    let slotRequest = 0;
    const refreshTimeAndDuration = async () => {
      if (!selectedRule || !timeSelect || !durationSelect) return;
      const currentRequest = ++slotRequest;
      const modality = form.querySelector('[name="modality"]')?.value || '';
      timeSelect.disabled = true;
      durationSelect.disabled = true;
      try {
        const available = availabilityRules(
          await api(
            `/api/tutors/${encodeURIComponent(reservationTutorId)}/availability?date=${encodeURIComponent(dateInput.value)}&modality=${encodeURIComponent(modality)}`,
          ),
        );
        if (currentRequest !== slotRequest) return;
        const selected = available.find((rule) => String(rule.id) === String(selectedRule.id));
        selectedIntervals = (selected?.free_intervals || []).map((interval) => ({
          start: toMinutes(interval.start_time),
          end: toMinutes(interval.end_time),
        }));
        const starts = [
          ...new Set(
            selectedIntervals.flatMap((interval) =>
              Array.from(
                { length: Math.max(0, Math.floor((interval.end - interval.start - 60) / 30) + 1) },
                (_, index) => interval.start + index * 30,
              ),
            ),
          ),
        ].sort((a, b) => a - b);
        timeSelect.innerHTML = starts.length
          ? starts
              .map(
                (minute) =>
                  `<option value="${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}">${escapeHtml(timeText(minute))}</option>`,
              )
              .join('')
          : '<option value="">No hay horarios libres este día</option>';
        timeSelect.disabled = !starts.length;
        const syncDuration = () => {
          const chosen = toMinutes(timeSelect.value || '');
          const interval = selectedIntervals.find((slot) => chosen >= slot.start && chosen + 60 <= slot.end);
          const max = interval ? Math.floor((interval.end - chosen) / 60) : 0;
          durationSelect.innerHTML = Array.from({ length: max }, (_, index) => index + 1)
            .map((hours) => `<option value="${hours}">${hours} ${hours === 1 ? 'hora' : 'horas'}</option>`)
            .join('');
          durationSelect.disabled = !max;
          updateTotal();
        };
        timeSelect.onchange = syncDuration;
        durationSelect.onchange = updateTotal;
        syncDuration();
      } catch (error) {
        if (currentRequest !== slotRequest) return;
        selectedIntervals = [];
        timeSelect.innerHTML = '<option value="">No se pudo consultar la disponibilidad</option>';
        durationSelect.innerHTML = '<option value="">Selecciona un horario disponible</option>';
        feedback(form, error.message);
      }
    };
    const selectRule = (ruleId) => {
      selectedRule = reservationAvailability.find((rule) => String(rule.id) === String(ruleId)) || null;
      if (!selectedRule) {
        dateInput.disabled = true;
        timeSelect.disabled = true;
        durationSelect.disabled = true;
        budgetInput.disabled = true;
        return;
      }
      const next = dateForNextDay(selectedRule.day_of_week);
      dateInput.disabled = false;
      dateInput.min = dateString(next);
      dateInput.max = dateString(new Date(next.getTime() + 180 * 24 * 60 * 60 * 1000));
      dateInput.step = '7';
      dateInput.value = dateString(next);
      dateInput.dataset.allowedDay = selectedRule.day_of_week;
      budgetInput.disabled = false;
      if (!budgetInput.value) budgetInput.value = tutorHourlyRate || '';
      const modality = form?.querySelector('[name="modality"]');
      if (modality && ['online', 'in_person'].includes(selectedRule.modality)) modality.value = selectedRule.modality;
      refreshTimeAndDuration();
      updateTotal();
    };
    blockSelect?.addEventListener('change', () => selectRule(blockSelect.value));
    dateInput?.addEventListener('change', () => {
      if (selectedRule && new Date(`${dateInput.value}T12:00:00`).getDay() !== Number(selectedRule.day_of_week)) {
        dateInput.setCustomValidity(`Elige un ${days[Number(selectedRule.day_of_week)]}.`);
        slotRequest += 1;
        selectedIntervals = [];
        timeSelect.disabled = true;
        durationSelect.disabled = true;
        timeSelect.innerHTML = '<option value="">Selecciona una fecha válida</option>';
        durationSelect.innerHTML = '<option value="">Selecciona un horario disponible</option>';
        return;
      }
      dateInput.setCustomValidity('');
      refreshTimeAndDuration();
    });
    form?.querySelector('[name="modality"]')?.addEventListener('change', refreshTimeAndDuration);
    budgetInput?.addEventListener('input', updateTotal);
    const loadReservationTutor = requestedTutor
      ? api(`/api/tutors/${encodeURIComponent(requestedTutor)}`)
      : api('/api/tutors').then((tutors) => {
          if (!tutors.length) throw new Error('No hay profesores publicados para solicitar una tutoría.');
          reservationTutorId = tutors[0].tutor_id || tutors[0].id;
          return api(`/api/tutors/${encodeURIComponent(reservationTutorId)}`);
        });
    loadReservationTutor
      .then((profile) => {
        reservationTutorId = profile.user?.id || reservationTutorId;
        reservationAvailability = profile.availability || [];
        const name = profile.user?.full_name || 'Profesor seleccionado';
        const title = profile.professional_title || 'Perfil profesional';
        reservationPage.querySelectorAll('[data-reservation-tutor-name]').forEach((node) => {
          node.textContent = name;
        });
        reservationPage.querySelectorAll('[data-reservation-tutor-title]').forEach((node) => {
          node.textContent = title;
        });
        if (reservationAvatar) applyAvatar([reservationAvatar], profile.user || {});
        const subjectSelect = form?.querySelector('[name="subjectId"]');
        const tutorSubjects = (profile.subjects || [])
          .map((item) => ({ ...(item.subjects || item), hourly_rate: item.hourly_rate, is_primary: item.is_primary }))
          .filter((item) => item?.id);
        const updateSubjectRate = () => {
          const selectedSubject = tutorSubjects.find((subject) => String(subject.id) === subjectSelect?.value);
          tutorHourlyRate = Number(selectedSubject?.hourly_rate ?? 0);
          if (budgetInput) budgetInput.value = selectedSubject?.hourly_rate ?? '';
          updateTotal();
        };
        if (subjectSelect && tutorSubjects.length) {
          subjectSelect.innerHTML = tutorSubjects
            .map(
              (subject) =>
                `<option value="${Number(subject.id)}"${subject.is_primary ? ' selected' : ''}>${escapeHtml(subject.name)}</option>`,
            )
            .join('');
          subjectSelect.addEventListener('change', updateSubjectRate);
          updateSubjectRate();
        }
        api('/api/education-levels')
          .then((levels) => {
            if (!educationLevelSelect) return;
            const preferred = levels.find((level) => level.name === 'Universidad') || levels[0];
            educationLevelSelect.innerHTML = levels
              .map(
                (level) =>
                  `<option value="${Number(level.id)}"${level.id === preferred?.id ? ' selected' : ''}>${escapeHtml(level.name)}</option>`,
              )
              .join('');
          })
          .catch((error) => feedback(form, error.message));
        if (blockSelect) {
          blockSelect.innerHTML = reservationAvailability.length
            ? reservationAvailability
                .map(
                  (rule) =>
                    `<option value="${escapeHtml(rule.id)}">${escapeHtml(days[Number(rule.day_of_week)])} · ${escapeHtml(String(rule.start_time).slice(0, 5))} – ${escapeHtml(String(rule.end_time).slice(0, 5))} · ${escapeHtml(modalityLabel(rule.modality))}</option>`,
                )
                .join('')
            : '<option value="">El profesor aún no tiene bloques disponibles</option>';
          if (reservationAvailability.length) selectRule(blockSelect.value);
        }
      })
      .catch((error) => {
        if (form) feedback(form, error.message);
      });
    reservationPage._reservationTutorId = () => reservationTutorId;
    reservationPage._reservationAvailability = () => reservationAvailability;
    reservationPage._selectedReservationRule = () => selectedRule;
  }
  const availabilityPage = document.querySelector('[data-availability-page]');
  if (availabilityPage) {
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const modalityLabel = (modality) =>
      ({ online: 'Virtual', in_person: 'Presencial', both: 'Virtual y presencial' })[modality] || 'No especificada';
    const calendar = availabilityPage.querySelector('[data-availability-calendar]');
    const list = availabilityPage.querySelector('[data-availability-list]');
    const count = availabilityPage.querySelector('[data-availability-count]');
    const weeklyHours = availabilityPage.querySelector('[data-weekly-hours]');
    const dailySummary = availabilityPage.querySelector('[data-daily-summary]');
    const bestSlots = availabilityPage.querySelector('[data-best-slots]');
    const weekTitle = availabilityPage.querySelector('[data-calendar-title]');
    const addForm = availabilityPage.querySelector('[data-availability-form]');
    const viewModal = availabilityPage.querySelector('[data-availability-view-modal]');
    const editModal = availabilityPage.querySelector('[data-availability-edit-modal]');
    const deleteModal = availabilityPage.querySelector('[data-availability-delete-modal]');
    const editForm = availabilityPage.querySelector('[data-availability-edit-form]');
    let availabilityItems = [];
    let assignedSessions = [];
    let selectedId = null;
    let weekOffset = 0;
    const startMinute = 6 * 60 + 30;
    const baseEndMinute = 12 * 60;
    const slotMinutes = 30;
    const slotHeight = 38;
    const formatTime = (value) => {
      const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
      const date = new Date(2000, 0, 1, hours, minutes);
      return new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(date);
    };
    const formatDate = (date, options = { day: 'numeric', month: 'short' }) =>
      new Intl.DateTimeFormat('es-CO', options).format(date);
    const minutesFromTime = (value) => {
      const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
      return hours * 60 + minutes;
    };
    const durationHours = (item) =>
      Math.max(0, (minutesFromTime(item.end_time) - minutesFromTime(item.start_time)) / 60);
    const localDateKey = (date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const sessionDateKey = (session) => localDateKey(new Date(session.starts_at));
    const sessionMinutes = (session, field) => {
      const date = new Date(session[field]);
      return date.getHours() * 60 + date.getMinutes();
    };
    const availabilitySegments = (item, date) => {
      const ruleStart = minutesFromTime(item.start_time);
      const ruleEnd = minutesFromTime(item.end_time);
      const occupied = assignedSessions
        .filter(
          (session) =>
            ['scheduled', 'in_progress'].includes(session.status) && sessionDateKey(session) === localDateKey(date),
        )
        .map((session) => ({
          start: sessionMinutes(session, 'starts_at'),
          end: sessionMinutes(session, 'ends_at'),
          session,
        }))
        .filter((slot) => slot.end > ruleStart && slot.start < ruleEnd)
        .sort((a, b) => a.start - b.start);
      const segments = [];
      let cursor = ruleStart;
      occupied.forEach((slot) => {
        const start = Math.max(ruleStart, slot.start);
        const end = Math.min(ruleEnd, slot.end);
        if (start > cursor) segments.push({ start: cursor, end: start, type: 'available', item });
        if (end > Math.max(cursor, start))
          segments.push({ start: Math.max(cursor, start), end, type: 'occupied', session: slot.session });
        cursor = Math.max(cursor, end);
      });
      if (cursor < ruleEnd) segments.push({ start: cursor, end: ruleEnd, type: 'available', item });
      return segments.filter((segment) => segment.end > segment.start);
    };
    const weekDates = () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      today.setDate(today.getDate() + weekOffset * 7);
      return Array.from({ length: 7 }, (_, index) => {
        const date = new Date(today);
        date.setDate(today.getDate() + index);
        return date;
      });
    };
    const openModal = (modal) => {
      if (modal) {
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
      }
    };
    const closeModal = (modal) => {
      if (modal) {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
      }
    };
    const selectedItem = () => availabilityItems.find((item) => item.id === selectedId);
    const setEditForm = (item) => {
      if (!editForm || !item) return;
      const set = (selector, nextValue) => {
        const node = editForm.querySelector(selector);
        if (node) node.value = nextValue;
      };
      set('[name="dayOfWeek"]', String(item.day_of_week));
      set('[name="modality"]', item.modality);
      set('[name="startTime"]', String(item.start_time).slice(0, 5));
      set('[name="endTime"]', String(item.end_time).slice(0, 5));
    };
    const showViewModal = (item) => {
      selectedId = item.id;
      const setText = (selector, text) => {
        const node = viewModal?.querySelector(selector);
        if (node) node.textContent = text;
      };
      setText('[data-modal-title]', `Horario del ${days[Number(item.day_of_week)] || 'día'}`);
      setText('[data-modal-day]', days[Number(item.day_of_week)] || 'Día');
      setText('[data-modal-time]', `${formatTime(item.start_time)} – ${formatTime(item.end_time)}`);
      setText('[data-modal-modality]', modalityLabel(item.modality));
      openModal(viewModal);
    };
    const showEditModal = (item) => {
      selectedId = item.id;
      setEditForm(item);
      closeModal(viewModal);
      openModal(editModal);
    };
    const showDeleteModal = (item) => {
      selectedId = item.id;
      const copy = deleteModal?.querySelector('[data-delete-modal-copy]');
      if (copy)
        copy.textContent = `Se eliminará el horario del ${days[Number(item.day_of_week)] || 'día'}, de ${formatTime(item.start_time)} a ${formatTime(item.end_time)}. Esta acción no se puede deshacer.`;
      closeModal(viewModal);
      openModal(deleteModal);
    };
    const renderCalendar = () => {
      const dates = weekDates();
      const endMinute = Math.max(
        baseEndMinute,
        ...availabilityItems.map((item) => minutesFromTime(item.end_time)).filter((value) => value > startMinute),
        baseEndMinute,
      );
      const rangeMinutes = endMinute - startMinute;
      const rows = Math.ceil(rangeMinutes / slotMinutes);
      if (weekTitle)
        weekTitle.textContent = `${formatDate(dates[0], { day: 'numeric', month: 'long' })} – ${formatDate(dates[6], { day: 'numeric', month: 'long', year: 'numeric' })}`;
      const totalHours = dates.reduce(
        (sum, date) =>
          sum +
          availabilityItems
            .filter((item) => Number(item.day_of_week) === date.getDay())
            .reduce(
              (daySum, item) =>
                daySum +
                availabilitySegments(item, date)
                  .filter((segment) => segment.type === 'available')
                  .reduce((segmentSum, segment) => segmentSum + (segment.end - segment.start) / 60, 0),
              0,
            ),
        0,
      );
      if (weeklyHours) weeklyHours.textContent = `${totalHours.toFixed(1)} h`;
      if (count)
        count.textContent = `${availabilityItems.length} ${availabilityItems.length === 1 ? 'horario' : 'horarios'}`;
      if (dailySummary)
        dailySummary.innerHTML = dates
          .map((date) => {
            const hours = availabilityItems
              .filter((item) => Number(item.day_of_week) === date.getDay())
              .reduce(
                (sum, item) =>
                  sum +
                  availabilitySegments(item, date)
                    .filter((segment) => segment.type === 'available')
                    .reduce((segmentSum, segment) => segmentSum + (segment.end - segment.start) / 60, 0),
                0,
              );
            const maxHours = Math.max(
              ...dates.map((day) =>
                availabilityItems
                  .filter((item) => Number(item.day_of_week) === day.getDay())
                  .reduce(
                    (sum, item) =>
                      sum +
                      availabilitySegments(item, day)
                        .filter((segment) => segment.type === 'available')
                        .reduce((segmentSum, segment) => segmentSum + (segment.end - segment.start) / 60, 0),
                    0,
                  ),
              ),
              1,
            );
            return `<div class="availability-summary-row"><span>${days[date.getDay()]}</span><div class="availability-summary-bar"><i style="width:${Math.min(100, (hours / maxHours) * 100)}%"></i></div><strong>${hours.toFixed(1)} h</strong></div>`;
          })
          .join('');
      const ranked = availabilityItems
        .slice()
        .sort((a, b) => durationHours(b) - durationHours(a))
        .slice(0, 3);
      if (bestSlots)
        bestSlots.innerHTML = ranked.length
          ? ranked
              .map(
                (item) =>
                  `<li><span>◷</span><strong>${escapeHtml(days[Number(item.day_of_week)] || 'Día')}</strong><span>${escapeHtml(formatTime(item.start_time))} – ${escapeHtml(formatTime(item.end_time))}</span></li>`,
              )
              .join('')
          : '<li class="muted">Añade horarios para ver tus mejores bloques.</li>';
      if (!calendar) return;
      const headers = dates
        .map(
          (date) =>
            `<div class="availability-calendar-head ${date.toDateString() === new Date().toDateString() ? 'is-today' : ''}"><strong>${escapeHtml(days[date.getDay()])}</strong><span>${escapeHtml(formatDate(date))}</span></div>`,
        )
        .join('');
      const axis = Array.from({ length: rows }, (_, index) => {
        const minute = startMinute + index * slotMinutes;
        return `<div>${escapeHtml(formatTime(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`))}</div>`;
      }).join('');
      const columns = dates
        .map((date) => {
          const items = availabilityItems.filter((item) => Number(item.day_of_week) === date.getDay());
          const segments = items.flatMap((item) => availabilitySegments(item, date));
          const cards = segments
            .map((segment) => {
              const itemStart = Math.max(startMinute, segment.start);
              const itemEnd = Math.min(endMinute, segment.end);
              if (itemEnd <= startMinute || itemStart >= endMinute) return '';
              const top = ((itemStart - startMinute) / rangeMinutes) * 100;
              const height = Math.max(5, ((itemEnd - itemStart) / rangeMinutes) * 100);
              if (segment.type === 'occupied')
                return `<div class="availability-calendar-card is-occupied" style="top:${top}%;height:${height}%"><strong>Ocupada</strong><span>${escapeHtml(formatTime(`${String(Math.floor(itemStart / 60)).padStart(2, '0')}:${String(itemStart % 60).padStart(2, '0')}`))} – ${escapeHtml(formatTime(`${String(Math.floor(itemEnd / 60)).padStart(2, '0')}:${String(itemEnd % 60).padStart(2, '0')}`))}</span><small>Tutoría asignada</small></div>`;
              return `<button type="button" class="availability-calendar-card" style="top:${top}%;height:${height}%" data-open-view="${escapeHtml(segment.item.id)}"><strong>Disponible</strong><span>${escapeHtml(formatTime(`${String(Math.floor(itemStart / 60)).padStart(2, '0')}:${String(itemStart % 60).padStart(2, '0')}`))} – ${escapeHtml(formatTime(`${String(Math.floor(itemEnd / 60)).padStart(2, '0')}:${String(itemEnd % 60).padStart(2, '0')}`))}</span><small>${escapeHtml(modalityLabel(segment.item.modality))}</small></button>`;
            })
            .join('');
          return `<div class="availability-calendar-day" style="--calendar-height:${rows * slotHeight}px"><div class="availability-calendar-lines" style="--calendar-rows:${rows}"></div>${cards || '<span class="availability-empty-day">Sin horario</span>'}</div>`;
        })
        .join('');
      calendar.innerHTML = `<div class="availability-calendar-grid"><div class="availability-calendar-corner">Hora</div>${headers}<div class="availability-time-axis" style="--calendar-rows:${rows}">${axis}</div>${columns}</div>`;
      calendar.querySelectorAll('[data-open-view]').forEach((button) =>
        button.addEventListener('click', () => {
          const item = availabilityItems.find((entry) => entry.id === button.dataset.openView);
          if (item) showViewModal(item);
        }),
      );
    };
    const renderAvailabilityList = () => {
      if (!list) return;
      list.innerHTML = availabilityItems.length
        ? availabilityItems
            .map(
              (item) =>
                `<div class="list-item availability-saved-row"><span class="status success">${escapeHtml(days[Number(item.day_of_week)] || 'Día')}</span><strong>${escapeHtml(formatTime(item.start_time))} – ${escapeHtml(formatTime(item.end_time))}</strong><span class="muted small">${escapeHtml(modalityLabel(item.modality))}</span><span class="row availability-actions"><button class="btn btn-ghost btn-sm" type="button" data-open-edit="${escapeHtml(item.id)}">Editar</button><button class="btn btn-danger btn-sm" type="button" data-open-delete="${escapeHtml(item.id)}">Eliminar</button></span></div>`,
            )
            .join('')
        : '<div class="card ghost" style="text-align:center;padding:32px 16px"><p class="muted">Aún no tienes horarios guardados.</p></div>';
      list.querySelectorAll('[data-open-edit]').forEach((button) =>
        button.addEventListener('click', () => {
          const item = availabilityItems.find((entry) => entry.id === button.dataset.openEdit);
          if (item) showEditModal(item);
        }),
      );
      list.querySelectorAll('[data-open-delete]').forEach((button) =>
        button.addEventListener('click', () => {
          const item = availabilityItems.find((entry) => entry.id === button.dataset.openDelete);
          if (item) showDeleteModal(item);
        }),
      );
    };
    const renderAvailability = (items) => {
      availabilityItems = items || [];
      renderCalendar();
      renderAvailabilityList();
    };
    const loadAvailability = () =>
      Promise.all([api('/api/tutors/me/availability'), api('/api/sessions')])
        .then(([items, sessions]) => {
          assignedSessions = sessions || [];
          renderAvailability(items);
        })
        .catch((error) => {
          if (list)
            list.innerHTML = `<div class="card ghost" style="text-align:center;padding:32px 16px"><p class="muted">${escapeHtml(error.message)}</p></div>`;
        });
    const deleteSelected = async () => {
      const item = selectedItem();
      if (!item) return;
      const button = deleteModal?.querySelector('[data-delete-modal-confirm]');
      if (button) button.disabled = true;
      try {
        await api(`/api/tutors/me/availability/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        closeModal(deleteModal);
        selectedId = null;
        await loadAvailability();
      } catch (error) {
        const copy = deleteModal?.querySelector('[data-delete-modal-copy]');
        if (copy) copy.textContent = error.message;
      } finally {
        if (button) button.disabled = false;
      }
    };
    availabilityPage.querySelector('[data-calendar-prev]')?.addEventListener('click', () => {
      weekOffset -= 1;
      renderCalendar();
    });
    availabilityPage.querySelector('[data-calendar-next]')?.addEventListener('click', () => {
      weekOffset += 1;
      renderCalendar();
    });
    availabilityPage.querySelector('[data-calendar-today]')?.addEventListener('click', () => {
      weekOffset = 0;
      renderCalendar();
    });
    viewModal?.querySelector('[data-modal-close]')?.addEventListener('click', () => closeModal(viewModal));
    viewModal?.querySelector('[data-modal-edit]')?.addEventListener('click', () => {
      const item = selectedItem();
      if (item) showEditModal(item);
    });
    viewModal?.querySelector('[data-modal-delete]')?.addEventListener('click', () => {
      const item = selectedItem();
      if (item) showDeleteModal(item);
    });
    editModal?.querySelector('[data-edit-modal-close]')?.addEventListener('click', () => closeModal(editModal));
    editModal?.querySelector('[data-edit-modal-cancel]')?.addEventListener('click', () => closeModal(editModal));
    deleteModal?.querySelector('[data-delete-modal-cancel]')?.addEventListener('click', () => closeModal(deleteModal));
    deleteModal?.querySelector('[data-delete-modal-confirm]')?.addEventListener('click', deleteSelected);
    [viewModal, editModal, deleteModal].forEach((modal) =>
      modal?.addEventListener('click', (event) => {
        if (event.target === modal) closeModal(modal);
      }),
    );
    loadAvailability();
    addForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = addForm.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        await api('/api/tutors/me/availability', {
          method: 'POST',
          body: JSON.stringify({
            dayOfWeek: Number(value(addForm, '[name="dayOfWeek"]')),
            startTime: value(addForm, '[name="startTime"]'),
            endTime: value(addForm, '[name="endTime"]'),
            modality: value(addForm, '[name="modality"]'),
          }),
        });
        feedback(addForm, 'Horario guardado correctamente.', false);
        addForm.reset();
        await loadAvailability();
      } catch (error) {
        feedback(addForm, error.message);
      } finally {
        if (button) button.disabled = false;
      }
    });
    editForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const item = selectedItem();
      if (!item) return;
      const button = editForm.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        await api(`/api/tutors/me/availability/${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            dayOfWeek: Number(value(editForm, '[name="dayOfWeek"]')),
            startTime: value(editForm, '[name="startTime"]'),
            endTime: value(editForm, '[name="endTime"]'),
            modality: value(editForm, '[name="modality"]'),
          }),
        });
        closeModal(editModal);
        selectedId = null;
        await loadAvailability();
      } catch (error) {
        feedback(editForm, error.message);
      } finally {
        if (button) button.disabled = false;
      }
    });
  }
  const requestForm = document.querySelector('[data-api-form="request"]');
  if (requestForm) {
    requestForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = requestForm.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        const reservation = document.querySelector('[data-reservation-page]');
        const rule = reservation?._selectedReservationRule?.();
        const date = value(requestForm, '[name="preferredDate"]');
        const time = value(requestForm, '[name="preferredTime"]');
        const hours = Number(value(requestForm, '[name="durationHours"]'));
        if (!rule || !date || !time || !hours)
          throw new Error('Selecciona un bloque, una fecha, una hora y la duración.');
        const selectedDate = new Date(`${date}T12:00:00`);
        if (selectedDate.getDay() !== Number(rule.day_of_week))
          throw new Error(
            `La fecha debe ser un ${['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][Number(rule.day_of_week)]}.`,
          );
        const startsAtDate = dateInTimezone(date, time, rule.timezone || 'America/Bogota');
        const endsAtDate = new Date(startsAtDate.getTime() + hours * 60 * 60 * 1000);
        const tutorId = reservation?._reservationTutorId?.();
        if (!tutorId) throw new Error('No se pudo identificar al profesor seleccionado.');
        const result = await api('/api/requests', {
          method: 'POST',
          body: JSON.stringify({
            subjectId: Number(value(requestForm, '[name="subjectId"]')),
            educationLevelId: Number(value(requestForm, '[name="educationLevelId"]')),
            objective: value(requestForm, '[name="objective"]'),
            modality: value(requestForm, '[name="modality"]'),
            preferredStartsAt: startsAtDate.toISOString(),
            preferredEndsAt: endsAtDate.toISOString(),
            budgetPerHour: Number(value(requestForm, '[name="budgetPerHour"]')),
            tutorId,
          }),
        });
        window.location.href = `mis-tutorias.html?request=${encodeURIComponent(result.id)}`;
      } catch (error) {
        feedback(requestForm, error.message);
        if (button) button.disabled = false;
      }
    });
  }
  const agenda = document.querySelector('[data-agenda]');
  if (agenda) {
    const formatDate = (date) =>
      new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
    const sessionsNode = agenda.querySelector('[data-live-sessions]');
    const requestsNode = agenda.querySelector('[data-live-requests]');
    const tabs = agenda.querySelectorAll('[data-student-filter]');
    const renderEmpty = (message, action = true) =>
      `<div class="card soft-blue" style="text-align:center;padding:38px 24px"><span class="feature-icon" style="margin:0 auto 14px">◷</span><p class="muted" style="margin:0 auto ${action ? '18px' : '0'};max-width:460px">${message}</p>${action ? '<a class="btn btn-primary" href="buscar-tutores.html">Buscar un tutor →</a>' : ''}</div>`;
    const sessionLabel = (session) =>
      ({
        scheduled: 'Próxima',
        in_progress: 'En curso',
        review_pending: 'Próxima a completarse',
        completed: 'Completada',
        cancelled: 'Cancelada',
        no_show: 'No asistió',
      })[session.status] || session.status;
    const sessionActions = (session) =>
      `${session.modality === 'online' && !['completed', 'cancelled'].includes(session.status) ? `<a class="btn btn-primary btn-sm" href="aula-virtual.html?session=${encodeURIComponent(session.id)}">${session.status === 'review_pending' ? 'Volver al aula' : 'Entrar al aula'}</a>` : ''}${session.status === 'review_pending' ? `<a class="btn btn-success btn-sm" href="resena.html?session=${encodeURIComponent(session.id)}">Dejar reseña</a>` : ''}${!['completed', 'cancelled'].includes(session.status) ? `<button class="btn btn-danger btn-sm" type="button" data-cancel-session="${encodeURIComponent(session.id)}">Cancelar</button>` : ''}`;
    Promise.all([api('/api/sessions'), api('/api/requests')])
      .then(([sessions, requests]) => {
        const render = () => {
          const filter =
            new URLSearchParams(window.location.search).get('tab') ||
            window.location.hash.replace('#', '') ||
            'proximas';
          tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.studentFilter === filter));
          const visibleSessions =
            filter === 'completadas'
              ? sessions.filter((session) => session.status === 'completed')
              : filter === 'canceladas'
                ? sessions.filter((session) => session.status === 'cancelled')
                : sessions.filter((session) => ['scheduled', 'in_progress', 'review_pending'].includes(session.status));
          sessionsNode.innerHTML = visibleSessions.length
            ? visibleSessions
                .map(
                  (session) =>
                    `<article class="card"><div class="row-between"><div><span class="tag">${escapeHtml(session.modality === 'online' ? 'Virtual' : 'Presencial')}</span><h3 style="margin-top:10px">Tutoría ${escapeHtml(sessionLabel(session).toLowerCase())}</h3><p class="muted small" style="margin:5px 0 0">${formatDate(session.starts_at)} · ${escapeHtml(sessionLabel(session))}</p></div><div class="row">${sessionActions(session)}</div></div>${session.cancellation_reason ? `<p class="hint" style="margin:14px 0 0">Motivo de cancelación: ${escapeHtml(session.cancellation_reason)}</p>` : ''}</article>`,
                )
                .join('')
            : renderEmpty(
                filter === 'completadas'
                  ? 'Todavía no tienes tutorías completadas.'
                  : filter === 'canceladas'
                    ? 'No tienes tutorías canceladas.'
                    : 'No tienes tutorías próximas. Elige un tutor para crear una nueva solicitud.',
              );
          requestsNode.closest('[data-request-section]')?.classList.toggle('hidden', filter !== 'proximas');
          if (filter === 'proximas')
            requestsNode.innerHTML = requests.length
              ? requests
                  .map(
                    (request) =>
                      `<article class="card"><div class="row-between"><div><span class="status info">${escapeHtml(request.status)}</span><h3 style="margin-top:10px">Solicitud de tutoría</h3><p class="muted small" style="margin:5px 0 0">${escapeHtml(request.objective)} · ${formatDate(request.preferred_starts_at)}</p></div><a class="btn btn-secondary btn-sm" href="negociacion.html?request=${encodeURIComponent(request.id)}">Ver solicitud</a></div></article>`,
                  )
                  .join('')
              : renderEmpty('Todavía no has enviado solicitudes. Elige el perfil del tutor y cuéntale qué necesitas.');
        };
        tabs.forEach((tab) =>
          tab.addEventListener('click', (event) => {
            event.preventDefault();
            const filter = tab.dataset.studentFilter;
            window.history.replaceState({}, '', `mis-tutorias.html#${filter}`);
            render();
          }),
        );
        window.addEventListener('hashchange', render);
        render();
        const created = new URLSearchParams(window.location.search).get('request');
        if (created) {
          const notice = document.createElement('div');
          notice.className = 'card soft-green';
          notice.innerHTML =
            '<strong>Solicitud enviada</strong><p class="muted small" style="margin:6px 0 0">Tu solicitud quedó registrada. El tutor podrá revisarla y responderte desde la plataforma.</p>';
          agenda.querySelector('[data-agenda-notice]').appendChild(notice);
        }
      })
      .catch((error) => {
        sessionsNode.innerHTML = renderEmpty(error.message, false);
        requestsNode.innerHTML = renderEmpty('No se pudieron cargar tus solicitudes.', false);
      });
  }

  const tutorMetricsNodes = document.querySelectorAll('[data-tutor-metrics]');
  if (tutorMetricsNodes.length) {
    api('/api/tutors/me/metrics')
      .then((metrics) => {
        const formatUsd = (amount) =>
          `$${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        document.querySelectorAll('[data-tutor-metric="incomeUsd"]').forEach((node) => {
          node.textContent = formatUsd(metrics.incomeUsd);
        });
        document.querySelectorAll('[data-tutor-metric="upcomingCount"]').forEach((node) => {
          node.textContent = String(metrics.upcomingCount || 0);
        });
        document.querySelectorAll('[data-tutor-metric="completedCount"]').forEach((node) => {
          node.textContent = String(metrics.completedCount || 0);
        });
        document.querySelectorAll('[data-tutor-metric="cancelledCount"]').forEach((node) => {
          node.textContent = String(metrics.cancelledCount || 0);
        });
        document.querySelectorAll('[data-tutor-metric="hours"]').forEach((node) => {
          node.textContent = `${Number(metrics.hours || 0).toFixed(2)} h`;
        });
        document.querySelectorAll('[data-tutor-metric="responseRate"]').forEach((node) => {
          node.textContent = metrics.responseRate === null ? '—' : `${metrics.responseRate}%`;
        });
        document.querySelectorAll('[data-tutor-metric-note="responseRate"]').forEach((node) => {
          node.textContent =
            metrics.responseRate === null ? 'Aún no hay solicitudes respondidas' : 'Solicitudes respondidas';
        });
      })
      .catch(() => undefined);
  }

  const tutorSessionsPage = document.querySelector('[data-tutor-sessions-page]');
  if (tutorSessionsPage) {
    const list = tutorSessionsPage.querySelector('[data-tutor-session-list]');
    const tabs = tutorSessionsPage.querySelectorAll('[data-class-filter]');
    api('/api/sessions')
      .then((sessions) => {
        const labels = {
          scheduled: 'Próxima',
          in_progress: 'En curso',
          review_pending: 'Pendiente de reseña',
          completed: 'Completada',
          cancelled: 'Cancelada',
          no_show: 'No asistió',
        };
        const render = () => {
          const filter = window.location.hash.replace('#', '') || 'todas';
          tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.classFilter === filter));
          const visible =
            filter === 'proximas'
              ? sessions.filter((session) => ['scheduled', 'in_progress', 'review_pending'].includes(session.status))
              : filter === 'historial'
                ? sessions.filter((session) => ['completed', 'cancelled', 'no_show'].includes(session.status))
                : sessions;
          list.innerHTML = visible.length
            ? visible
                .map(
                  (session) =>
                    `<article class="card"><div class="row-between"><div><span class="tag">${escapeHtml(labels[session.status] || session.status)}</span><h3 style="margin-top:10px">Tutoría ${session.modality === 'online' ? 'virtual' : 'presencial'}</h3><p class="muted small">${new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.starts_at))}</p></div><div class="row">${session.modality === 'online' && !['completed', 'cancelled'].includes(session.status) ? `<a class="btn btn-primary btn-sm" href="aula-virtual.html?session=${encodeURIComponent(session.id)}">Abrir aula</a>` : ''}${!['completed', 'cancelled'].includes(session.status) ? `<button class="btn btn-danger btn-sm" type="button" data-cancel-session="${encodeURIComponent(session.id)}">Cancelar</button>` : ''}</div></div>${session.cancellation_reason ? `<p class="hint">Motivo: ${escapeHtml(session.cancellation_reason)}</p>` : ''}</article>`,
                )
                .join('')
            : `<div class="card ghost"><p class="muted">No tienes tutorías en ${filter === 'proximas' ? 'próximas' : filter === 'historial' ? 'el historial' : 'esta vista'}.</p></div>`;
        };
        tabs.forEach((tab) =>
          tab.addEventListener('click', (event) => {
            event.preventDefault();
            window.history.replaceState({}, '', `clases-impartidas.html#${tab.dataset.classFilter}`);
            render();
          }),
        );
        window.addEventListener('hashchange', render);
        render();
      })
      .catch((error) => {
        list.innerHTML = `<div class="card ghost"><p class="muted">${escapeHtml(error.message)}</p></div>`;
      });
  }

  const tutorDashboard = document.querySelector('[data-tutor-dashboard]');
  if (tutorDashboard) {
    const nextSession = tutorDashboard.querySelector('[data-tutor-next-session]');
    const agenda = tutorDashboard.querySelector('[data-tutor-agenda]');
    const reputation = tutorDashboard.querySelector('[data-tutor-reputation]');
    const welcome = tutorDashboard.querySelector('[data-tutor-welcome]');
    const requestList = tutorDashboard.querySelector('[data-tutor-request-list]');
    const requestCount = tutorDashboard.querySelector('[data-tutor-request-count]');
    Promise.all([api('/api/sessions'), api('/api/tutors/me/profile'), api('/api/requests')])
      .then(([sessions, profile, requests]) => {
        const availability = profile.availability || [];
        const reviews = profile.reviews || [];
        const formatDate = (date) =>
          new Intl.DateTimeFormat('es-CO', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(date));
        if (agenda) {
          agenda.innerHTML = availability.length
            ? `<span class="tag">Agenda configurada</span><h2 style="margin-top:12px">Tienes ${availability.length} ${availability.length === 1 ? 'bloque disponible' : 'bloques disponibles'}.</h2><p class="muted">Tus estudiantes podrán elegir estos horarios al solicitar una tutoría.</p><a class="btn btn-secondary btn-sm" href="disponibilidad.html">Gestionar horarios</a>`
            : '<h2>Tu agenda está disponible para configurar.</h2><p class="muted">Aún no hay bloques guardados. Añade tus horarios para que los estudiantes puedan elegirlos.</p><a class="btn btn-secondary btn-sm" href="disponibilidad.html">Definir horarios</a>';
        }
        if (requestCount)
          requestCount.textContent = `${requests.length} ${requests.length === 1 ? 'activa' : 'activas'}`;
        if (requestList) {
          const formatUsd = (amount, suffix = '') =>
            amount === null || amount === undefined || amount === ''
              ? 'Por definir'
              : `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${suffix}`;
          const requestHours = (request) =>
            Math.max(
              0,
              (new Date(
                request.preferred_ends_at || new Date(new Date(request.preferred_starts_at).getTime() + 3600000),
              ).getTime() -
                new Date(request.preferred_starts_at).getTime()) /
                3600000,
            );
          const requestStatus = (status) => (status === 'negotiating' ? 'En negociación' : 'Nueva solicitud');
          const formatRequestDate = (date) =>
            date
              ? new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date))
              : 'Fecha por confirmar';
          requestList.innerHTML = requests.length
            ? requests
                .slice(0, 4)
                .map((request) => {
                  const hours = requestHours(request);
                  const hourly = Number(request.budget_per_hour || 0);
                  const total = hourly * hours;
                  return `<article class="tutor-request-summary"><div class="row-between"><div><span class="status info">${requestStatus(request.status)}</span><h3 style="margin-top:8px">Solicitud de tutoría</h3></div><strong class="tutor-request-budget">${formatUsd(hourly, ' / hora')}</strong></div><p class="muted small">${escapeHtml(request.objective)}</p><div class="grid grid-4 tutor-request-details"><span><b>Horas</b>${hours.toFixed(1)} h</span><span><b>Inicio</b>${escapeHtml(formatRequestDate(request.preferred_starts_at))}</span><span><b>Por hora</b>${formatUsd(hourly)}</span><span><b>Total</b>${formatUsd(total)}</span></div><div class="row-between tutor-request-meta"><span>${escapeHtml(request.modality === 'online' ? 'Virtual' : 'Presencial')}</span><a class="btn btn-primary btn-sm" href="detalle-solicitud.html?request=${encodeURIComponent(request.id)}">Revisar solicitud →</a></div></article>`;
                })
                .join('')
            : '<div class="card ghost" style="text-align:center;padding:30px 15px"><span class="feature-icon" style="margin:0 auto 12px">⌁</span><p class="muted small" style="margin-bottom:14px">No hay solicitudes abiertas por ahora.</p><a class="btn btn-secondary btn-sm" href="radar-solicitudes.html">Abrir radar</a></div>';
        }
        const average = Number(profile.average_rating || 0);
        document.querySelectorAll('[data-tutor-metric="averageRating"]').forEach((node) => {
          node.textContent = reviews.length ? `${average.toFixed(1)} / 5` : '—';
        });
        document.querySelectorAll('[data-tutor-metric-note="averageRating"]').forEach((node) => {
          node.textContent = reviews.length
            ? `${reviews.length} ${reviews.length === 1 ? 'reseña publicada' : 'reseñas publicadas'}`
            : 'Aún no hay reseñas';
        });
        if (welcome)
          welcome
            .querySelector('p')
            ?.replaceChildren(
              document.createTextNode(
                'Sigue avanzando: tu actividad, agenda y tutorías se actualizan desde tus datos reales.',
              ),
            );
        if (reputation) {
          const average = Number(profile.average_rating || 0);
          reputation.innerHTML = `<div class="row-between"><h2>Tu reputación</h2><span class="tag">${reviews.length ? `${reviews.length} ${reviews.length === 1 ? 'reseña' : 'reseñas'}` : 'Sin reseñas'}</span></div><div style="font-size:34px;font-weight:800;letter-spacing:-.05em">${reviews.length ? `${average.toFixed(1)} / 5` : '—'}</div><p class="muted small">${reviews.length ? 'Calificación basada en las reseñas publicadas por tus estudiantes.' : 'Tu calificación aparecerá después de cerrar una tutoría.'}</p><a class="btn btn-ghost" href="mi-cuenta-tutor.html">Ver mi perfil →</a>`;
        }
        const upcoming = sessions
          .filter((item) => ['scheduled', 'in_progress'].includes(item.status))
          .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
        const session = upcoming[0];
        if (!nextSession) return;
        if (!session) {
          nextSession.className = 'card soft-blue';
          nextSession.innerHTML =
            '<div class="row-between"><div><span class="tag">Agenda al día</span><h2 style="margin-top:12px">No tienes tutorías pendientes.</h2><p class="muted">Las próximas sesiones que aceptes aparecerán aquí automáticamente.</p></div><a class="btn btn-secondary" href="clases-impartidas.html#proximas">Ver próximas</a></div>';
          return;
        }
        nextSession.className = 'card soft-green';
        nextSession.innerHTML = `<div class="row-between"><div><span class="tag">${session.status === 'in_progress' ? 'En curso' : 'Próxima'}</span><h2 style="margin-top:12px">Tu próxima tutoría está confirmada.</h2><p class="muted">${escapeHtml(formatDate(session.starts_at))} · ${session.modality === 'online' ? 'Virtual' : 'Presencial'}</p></div><div class="row">${session.modality === 'online' ? `<a class="btn btn-primary" href="aula-virtual.html?session=${encodeURIComponent(session.id)}">Entrar al aula →</a>` : `<a class="btn btn-secondary" href="clases-impartidas.html#proximas">Ver clase →</a>`}<button class="btn btn-danger" type="button" data-cancel-session="${encodeURIComponent(session.id)}">Cancelar</button></div></div>`;
      })
      .catch(() => undefined);
  }

  const requestView = document.querySelector('[data-request-view]');
  if (requestView) {
    const requestId = new URLSearchParams(window.location.search).get('request');
    const content = requestView.querySelector('[data-request-content]');
    const status = requestView.querySelector('[data-request-status]');
    if (!requestId) {
      status.textContent = 'Selecciona una solicitud desde Mis tutorías para consultar sus propuestas.';
      content.innerHTML =
        '<div class="card soft-blue" style="text-align:center;padding:42px 24px"><p class="muted" style="margin:0 0 18px">No hay una solicitud seleccionada.</p><a class="btn btn-primary" href="mis-tutorias.html">Ir a Mis tutorías</a></div>';
    } else {
      api(`/api/requests/${encodeURIComponent(requestId)}`)
        .then((request) => {
          status.textContent = `Estado: ${request.status}`;
          const proposals = request.proposals || [];
          content.innerHTML = `<div class="grid grid-sidebar"><section class="stack"><section class="card soft-blue"><div class="row-between"><div><span class="tag">Solicitud registrada</span><h2 style="margin-top:11px">Tu objetivo</h2><p class="muted">${escapeHtml(request.objective)}</p></div><span class="status info">${escapeHtml(request.status)}</span></div><div class="grid grid-4 tutor-request-details" style="margin-top:18px"><div><span class="muted small">Modalidad</span><strong style="display:block;margin-top:5px">${escapeHtml(request.modality === 'online' ? 'Virtual' : 'Presencial')}</strong></div><div><span class="muted small">Inicio</span><strong style="display:block;margin-top:5px">${new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(request.preferred_starts_at))}</strong></div><div><span class="muted small">Horas solicitadas</span><strong style="display:block;margin-top:5px">${Math.max(0, (new Date(request.preferred_ends_at || new Date(new Date(request.preferred_starts_at).getTime() + 3600000)).getTime() - new Date(request.preferred_starts_at).getTime()) / 3600000).toFixed(1)} h</strong></div><div><span class="muted small">Presupuesto total</span><strong style="display:block;margin-top:5px">$${(Number(request.budget_per_hour || 0) * Math.max(0, (new Date(request.preferred_ends_at || new Date(new Date(request.preferred_starts_at).getTime() + 3600000)).getTime() - new Date(request.preferred_starts_at).getTime()) / 3600000)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD</strong><span class="muted small">$${Number(request.budget_per_hour || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / hora</span></div></div></section><section><h2>Propuestas recibidas</h2><div class="stack-sm" style="margin-top:12px">${proposals.length ? proposals.map((proposal) => `<article class="card"><div class="row-between"><div><span class="status ${proposal.status === 'accepted' ? 'success' : 'info'}">${escapeHtml(proposal.status)}</span><h3 style="margin-top:10px">Propuesta del tutor</h3></div><strong>$${Number(proposal.proposed_hourly_rate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="muted small">/ hora</span></strong></div>${proposal.message ? `<p class="muted small">${escapeHtml(proposal.message)}</p>` : ''}${proposal.status === 'pending' ? `<button class="btn btn-primary btn-sm" type="button" data-accept-proposal="${encodeURIComponent(proposal.id)}">Aceptar propuesta</button>` : ''}</article>`).join('') : '<div class="card" style="text-align:center;padding:32px 24px"><p class="muted" style="margin:0">Aún no hay propuestas. El tutor podrá responder cuando revise tu solicitud.</p></div>'}</div></section></section><aside class="card"><h2>Siguiente paso</h2><p class="muted small">Cuando aceptes una propuesta, se creará la tutoría y podrás verla en tu agenda.</p><a class="btn btn-secondary btn-block" href="mis-tutorias.html">Volver a Mis tutorías</a></aside></div>`;
          content.querySelectorAll('[data-accept-proposal]').forEach((button) =>
            button.addEventListener('click', async () => {
              button.disabled = true;
              try {
                await api(`/api/proposals/${button.dataset.acceptProposal}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ status: 'accepted' }),
                });
                window.location.href = `mis-tutorias.html?request=${encodeURIComponent(requestId)}`;
              } catch (error) {
                button.disabled = false;
                status.textContent = error.message;
              }
            }),
          );
        })
        .catch((error) => {
          status.textContent = error.message;
          content.innerHTML =
            '<div class="card soft-blue" style="text-align:center;padding:42px 24px"><p class="muted" style="margin:0">No se pudo cargar la solicitud.</p></div>';
        });
    }
  }

  const tutorRequestView = document.querySelector('[data-tutor-request-view]');
  if (tutorRequestView) {
    const requestId = new URLSearchParams(window.location.search).get('request');
    const content = tutorRequestView.querySelector('[data-tutor-request-content]');
    const status = tutorRequestView.querySelector('[data-tutor-request-status]');
    if (!requestId) {
      status.textContent = 'Selecciona una solicitud abierta desde el radar.';
    } else {
      api(`/api/requests/${encodeURIComponent(requestId)}`)
        .then((request) => {
          status.textContent = `Estado: ${request.status}`;
          content.innerHTML = `<div class="grid grid-sidebar"><section class="stack"><section class="card"><span class="status info">Solicitud abierta</span><h2 style="margin-top:12px">Objetivo del estudiante</h2><p class="small"><strong>Estudiante:</strong> ${escapeHtml(request.student?.full_name || 'Estudiante')} · ${escapeHtml(request.student?.email || '')}</p><p class="muted">${escapeHtml(request.objective)}</p><div class="grid grid-4 tutor-request-details" style="margin-top:18px"><div><span class="muted small">Modalidad</span><strong style="display:block;margin-top:5px">${escapeHtml(request.modality === 'online' ? 'Virtual' : 'Presencial')}</strong></div><div><span class="muted small">Inicio</span><strong style="display:block;margin-top:5px">${new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(request.preferred_starts_at))}</strong></div><div><span class="muted small">Horas solicitadas</span><strong style="display:block;margin-top:5px">${Math.max(0, (new Date(request.preferred_ends_at || new Date(new Date(request.preferred_starts_at).getTime() + 3600000)).getTime() - new Date(request.preferred_starts_at).getTime()) / 3600000).toFixed(1)} h</strong></div><div><span class="muted small">Presupuesto total</span><strong style="display:block;margin-top:5px">$${(Number(request.budget_per_hour || 0) * Math.max(0, (new Date(request.preferred_ends_at || new Date(new Date(request.preferred_starts_at).getTime() + 3600000)).getTime() - new Date(request.preferred_starts_at).getTime()) / 3600000)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD</strong><span class="muted small">$${Number(request.budget_per_hour || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / hora</span></div></div><a class="btn btn-secondary btn-sm" href="chat.html?student=${encodeURIComponent(request.student_id)}&request=${encodeURIComponent(request.id)}">Escribir al estudiante</a></section><section class="card soft-green"><div class="row-between"><div><h2>Aceptar oferta del estudiante</h2><p class="muted small">Puedes aceptar directamente la fecha, hora y presupuesto que propuso el estudiante.</p></div><button class="btn btn-success" type="button" data-accept-request>Aceptar oferta →</button></div></section><section class="card"><div class="row-between"><div><h2>Rechazar solicitud</h2><p class="muted small">Si no puedes tomar esta tutoría, informa al estudiante y continúa con otra oportunidad.</p></div><button class="btn btn-danger" type="button" data-reject-request>Rechazar solicitud</button></div></section><section class="card"><div class="row-between"><div><h2>Enviar contraoferta</h2><p class="muted small">Modifica la fecha, hora y tarifa. El total se calcula automáticamente.</p></div><span class="tag">USD</span></div><form class="stack" style="margin-top:18px" data-tutor-proposal-form><div class="form-grid"><div class="field"><label for="proposal-date">Fecha de inicio</label><input id="proposal-date" name="proposedDate" type="date" required></div><div class="field"><label for="proposal-time">Hora de inicio</label><input id="proposal-time" name="proposedTime" type="time" required></div><div class="field"><label for="proposal-duration">Cantidad de horas</label><input id="proposal-duration" name="durationHours" type="number" min="1" step="1" inputmode="numeric" required></div><div class="field"><label for="proposal-rate">Presupuesto por hora (USD)</label><input id="proposal-rate" name="proposedHourlyRate" type="number" min="0" step="0.01" required></div><div class="field"><label for="proposal-total">Presupuesto total (USD)</label><input id="proposal-total" name="proposedTotal" type="text" readonly></div><div class="field full"><label for="proposal-message">Mensaje</label><textarea id="proposal-message" name="message" minlength="10" maxlength="1000" required placeholder="Explica cómo abordarías el objetivo."></textarea></div></div><div class="row-between"><button class="btn btn-primary" type="submit">Enviar propuesta →</button></div></form></section></section><aside class="card soft-lavender"><h2>Buenas prácticas</h2><p class="muted small">Propón un horario que puedas cumplir y describe brevemente tu enfoque. El estudiante podrá aceptar o rechazar la propuesta.</p></aside></div>`;
          const proposalForm = content.querySelector('[data-tutor-proposal-form]');
          const dateField = proposalForm.querySelector('[name="proposedDate"]');
          const timeField = proposalForm.querySelector('[name="proposedTime"]');
          const proposalDate = document.createElement('select');
          const proposalTime = document.createElement('select');
          proposalDate.id = 'proposal-date';
          proposalDate.name = 'proposedDate';
          proposalDate.required = true;
          proposalDate.className = dateField.className;
          proposalTime.id = 'proposal-time';
          proposalTime.name = 'proposedTime';
          proposalTime.required = true;
          proposalTime.className = timeField.className;
          dateField.replaceWith(proposalDate);
          timeField.replaceWith(proposalTime);
          proposalForm.querySelector('label[for="proposal-date"]').textContent = 'Fecha';
          const durationInput = proposalForm.querySelector('[name="durationHours"]');
          const rateInput = proposalForm.querySelector('[name="proposedHourlyRate"]');
          const totalInput = proposalForm.querySelector('[name="proposedTotal"]');
          const requestStart = new Date(request.preferred_starts_at);
          const requestEnd = new Date(request.preferred_ends_at || requestStart.getTime() + 3600000);
          const hours = Math.max(1, Math.round((requestEnd.getTime() - requestStart.getTime()) / 3600000));
          const pad = (number) => String(number).padStart(2, '0');
          const localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
          const localTime = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
          let proposalTutorId = '';
          let proposalTimezone = 'America/Bogota';
          let proposalTimeRequest = 0;
          durationInput.value = String(hours);
          rateInput.value = request.budget_per_hour ?? '';
          const updateProposalTotal = () => {
            const hoursValue =
              Number.isFinite(Number(durationInput.value)) && Number(durationInput.value) > 0
                ? Math.round(Number(durationInput.value))
                : 0;
            const total = Number(rateInput.value || 0) * hoursValue;
            totalInput.value = `$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          };
          const refreshProposalTimes = async () => {
            if (!proposalDate.value || !proposalTutorId) return;
            const currentRequest = ++proposalTimeRequest;
            proposalTime.disabled = true;
            try {
              const available = availabilityRules(
                await api(
                  `/api/tutors/${encodeURIComponent(proposalTutorId)}/availability?date=${encodeURIComponent(proposalDate.value)}&modality=${encodeURIComponent(request.modality)}`,
                ),
              );
              if (currentRequest !== proposalTimeRequest) return;
              const duration = Math.max(1, Math.round(Number(durationInput.value) || 1)) * 60;
              const starts = [
                ...new Set(
                  available.flatMap((rule) =>
                    (rule.free_intervals || []).flatMap((interval) => {
                      const start =
                        Number(interval.start_time.slice(0, 2)) * 60 + Number(interval.start_time.slice(3, 5));
                      const end = Number(interval.end_time.slice(0, 2)) * 60 + Number(interval.end_time.slice(3, 5));
                      return Array.from(
                        { length: Math.max(0, Math.floor((end - start - duration) / 30) + 1) },
                        (_, index) => start + index * 30,
                      );
                    }),
                  ),
                ),
              ].sort((a, b) => a - b);
              proposalTime.innerHTML = starts.length
                ? starts
                    .map(
                      (minute) =>
                        `<option value="${pad(Math.floor(minute / 60))}:${pad(minute % 60)}">${escapeHtml(new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60)))}</option>`,
                    )
                    .join('')
                : '<option value="">No hay horarios disponibles</option>';
              proposalTime.disabled = !starts.length;
            } catch (error) {
              if (currentRequest !== proposalTimeRequest) return;
              proposalTime.innerHTML = '<option value="">No se pudo consultar la disponibilidad</option>';
              feedback(proposalForm, error.message);
            }
          };
          const loadAvailabilityDates = async () => {
            const [user, rules] = await Promise.all([api('/api/me'), api('/api/tutors/me/availability')]);
            proposalTutorId = user.id;
            const activeRules = rules.filter(
              (rule) => rule.is_active && (rule.modality === 'both' || rule.modality === request.modality),
            );
            proposalTimezone = activeRules[0]?.timezone || proposalTimezone;
            const today = new Date();
            const cursor = new Date(`${localDate(today)}T00:00:00.000Z`);
            const dates = [];
            for (let offset = 0; offset < 366; offset += 1) {
              const date = new Date(cursor.getTime() + offset * 24 * 60 * 60 * 1000);
              if (activeRules.some((rule) => Number(rule.day_of_week) === date.getUTCDay())) {
                const key = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
                dates.push({ key, date: new Date(`${key}T12:00:00`) });
              }
            }
            proposalDate.innerHTML = dates.length
              ? dates
                  .map(
                    ({ key, date }) =>
                      `<option value="${key}">${escapeHtml(new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date))}</option>`,
                  )
                  .join('')
              : '<option value="">Configura disponibilidad para enviar una contraoferta</option>';
            proposalDate.disabled = !dates.length;
            const requestedDate = localDate(requestStart);
            if (dates.some((date) => date.key === requestedDate)) proposalDate.value = requestedDate;
            await refreshProposalTimes();
            return user;
          };
          rateInput.addEventListener('input', updateProposalTotal);
          durationInput.addEventListener('input', () => {
            updateProposalTotal();
            refreshProposalTimes();
          });
          proposalDate.addEventListener('change', refreshProposalTimes);
          updateProposalTotal();
          loadAvailabilityDates().catch((error) => feedback(proposalForm, error.message));
          proposalForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const button = proposalForm.querySelector('button[type=submit]');
            button.disabled = true;
            try {
              const start = dateInTimezone(proposalDate.value, proposalTime.value, proposalTimezone);
              if (Number.isNaN(start.getTime())) throw new Error('Define una fecha y hora válidas.');
              const end = new Date(
                start.getTime() + Math.max(1, Math.round(Number(durationInput.value))) * 60 * 60 * 1000,
              );
              await api(`/api/requests/${encodeURIComponent(requestId)}/proposals`, {
                method: 'POST',
                body: JSON.stringify({
                  proposedHourlyRate: Number(rateInput.value),
                  proposedStartsAt: start.toISOString(),
                  proposedEndsAt: end.toISOString(),
                  message: value(proposalForm, '[name="message"]'),
                }),
              });
              window.location.href = 'radar-solicitudes.html';
            } catch (error) {
              feedback(proposalForm, error.message);
              button.disabled = false;
            }
          });
          content
            .querySelector('[data-reject-request]')
            ?.addEventListener('click', (event) => openRejectRequestDialog(requestId, event.currentTarget));
          const directAccept = content.querySelector('[data-accept-request]');
          directAccept?.addEventListener('click', async () => {
            directAccept.disabled = true;
            try {
              await api(`/api/requests/${encodeURIComponent(requestId)}/accept`, { method: 'POST' });
              window.location.href = 'dashboard-tutor.html';
            } catch (error) {
              directAccept.disabled = false;
              status.textContent = error.message;
            }
          });
        })
        .catch((error) => {
          status.textContent = error.message;
          content.innerHTML =
            '<div class="card soft-blue" style="text-align:center;padding:42px 24px"><p class="muted" style="margin:0">No se pudo cargar la solicitud.</p></div>';
        });
    }
  }

  const tutorRadar = document.querySelector('[data-tutor-radar]');
  if (tutorRadar) {
    const listNode = tutorRadar.querySelector('[data-radar-list]');
    const count = tutorRadar.querySelector('[data-radar-count]');
    const filters = [...tutorRadar.querySelectorAll('[data-radar-filter]')];
    const filterNode = (name) => filters.find((filter) => filter.dataset.radarFilter === name);
    const requestHours = (request) => {
      const start = new Date(request.preferred_starts_at).getTime();
      const end = request.preferred_ends_at ? new Date(request.preferred_ends_at).getTime() : start + 3600000;
      return Math.max(0, (end - start) / 3600000);
    };
    const formatHours = (hours) => {
      const whole = Math.floor(hours);
      const minutes = Math.round((hours - whole) * 60);
      return minutes ? `${whole}h ${String(minutes).padStart(2, '0')}m` : `${whole}h`;
    };
    const requestDate = (date) => {
      if (!date) return 'Fecha por confirmar';
      const value = new Date(date);
      const day = new Intl.DateTimeFormat('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }).format(value);
      const time = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true }).format(value);
      return `${day} · ${time}`;
    };
    const modalityLabel = (modality) => (modality === 'online' ? 'En línea' : 'Presencial');
    const requestStatus = (status) => (status === 'negotiating' ? 'En negociación' : 'Nueva solicitud');
    const levelName = (request) => request.education_level?.name || request.education_level_name || '';
    let allRequests = [];

    const cardMarkup = (request) => {
      const student = request.student || {};
      const studentName = student.full_name || 'Estudiante';
      const hours = requestHours(request);
      const hourly = Number(request.budget_per_hour || 0);
      const total = hourly * hours;
      const subject = request.subject?.name || 'Materia por confirmar';
      const level = levelName(request) || 'Nivel por confirmar';
      const detailUrl = `detalle-solicitud.html?request=${encodeURIComponent(request.id)}`;
      const avatar = student.avatar_url
        ? `<span class="avatar lg has-avatar" style="background-image:url('${escapeHtml(student.avatar_url)}')"></span>`
        : `<span class="avatar lg">${escapeHtml(initialsFor(studentName))}</span>`;
      const where =
        request.modality === 'in_person' && request.location_text ? ` · ${escapeHtml(request.location_text)}` : '';
      return `<article class="radar-request-card">
        <div class="radar-request-student">${avatar}<div><strong>${escapeHtml(studentName)}</strong><span class="muted small">Estudiante · ${escapeHtml(requestStatus(request.status))}</span></div></div>
        <div class="radar-request-main"><h2>${escapeHtml(subject)}</h2><p class="muted small">${escapeHtml(request.objective)}</p>
          <div class="radar-request-meta"><span>▥ Nivel: ${escapeHtml(level)}</span><span>▭ Modalidad: ${escapeHtml(modalityLabel(request.modality))}${where}</span><span>▦ ${escapeHtml(requestDate(request.preferred_starts_at))}</span></div></div>
        <div class="radar-request-budget"><strong>${formatUSD(hourly)}<small>/ hora</small></strong><span>${formatHours(hours)} · ${formatUSD(total)} total</span>
          <div class="radar-request-actions"><a class="btn btn-primary btn-sm" href="${detailUrl}">Revisar solicitud →</a></div></div>
      </article>`;
    };

    const emptyMarkup = (hasRequests) =>
      `<div class="card soft-blue" style="text-align:center;padding:54px 24px"><span class="feature-icon" style="margin:0 auto 16px">⌁</span><h2>${hasRequests ? 'No hay solicitudes con estos filtros' : 'No hay solicitudes nuevas'}</h2><p class="muted" style="max-width:500px;margin:0 auto 20px">${hasRequests ? 'Prueba otra combinación de filtros para ver más oportunidades.' : 'Las solicitudes compatibles con tus materias, tarifa y disponibilidad aparecerán aquí. Mientras tanto, completa tu perfil y configura tus horarios para estar listo.'}</p>${hasRequests ? '' : '<div class="row" style="justify-content:center"><a class="btn btn-primary" href="mi-cuenta-tutor.html">Completar perfil</a><a class="btn btn-secondary" href="disponibilidad.html">Configurar disponibilidad</a></div>'}</div>`;

    const renderRequests = () => {
      const selected = Object.fromEntries(filters.map((filter) => [filter.dataset.radarFilter, filter.value]));
      const visible = allRequests.filter((request) => {
        const rate = Number(request.budget_per_hour || 0);
        return (
          (selected.subject === 'all' || String(request.subject?.id) === selected.subject) &&
          (selected.modality === 'all' || request.modality === selected.modality) &&
          (selected.level === 'all' || String(request.education_level?.id) === selected.level) &&
          rate >= Number(selected.rate || 0)
        );
      });
      if (count) count.textContent = `${visible.length} ${visible.length === 1 ? 'activa' : 'activas'}`;
      listNode.className = visible.length ? 'stack-sm radar-request-list' : '';
      listNode.innerHTML = visible.length ? visible.map(cardMarkup).join('') : emptyMarkup(allRequests.length > 0);
    };

    const fillOptions = (name, allLabel, items) => {
      const node = filterNode(name);
      if (!node) return;
      node.innerHTML =
        `<option value="all">${allLabel}</option>` +
        items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    };
    const uniqueBy = (requests, key) => [
      ...new Map(
        requests.filter((request) => request[key]?.id).map((request) => [request[key].id, request[key]]),
      ).values(),
    ];

    api('/api/requests')
      .then((requests) => {
        allRequests = Array.isArray(requests) ? requests : [];
        fillOptions('subject', 'Materia: Todas', uniqueBy(allRequests, 'subject'));
        fillOptions('level', 'Nivel: Todos', uniqueBy(allRequests, 'education_level'));
        renderRequests();
      })
      .catch((error) => {
        if (count) count.textContent = '0 activas';
        listNode.innerHTML = `<div class="card soft-blue" style="text-align:center;padding:42px 24px"><p class="muted" style="margin:0">${escapeHtml(error.message || 'No se pudieron cargar las solicitudes.')}</p></div>`;
      });
    filters.forEach((filter) => filter.addEventListener('change', renderRequests));
  }

  document.querySelectorAll('[data-logout]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openLogoutDialog(link.getAttribute('href'));
    });
  });

  const query = new URLSearchParams(window.location.search);
  if (query.get('registered') === '1') {
    const loginHeading = document.querySelector('h1');
    if (loginHeading) {
      const notice = document.createElement('p');
      notice.className = 'lead';
      notice.style.color = '#087552';
      notice.textContent =
        query.get('requiresEmailConfirmation') === '1'
          ? 'Tu cuenta fue creada. Confirma tu correo para activar el acceso y luego inicia sesión.'
          : 'Tu cuenta fue creada correctamente. Ya puedes iniciar sesión.';
      loginHeading.insertAdjacentElement('afterend', notice);
      const emailField = document.querySelector('[name="email"]');
      if (emailField && query.get('email')) emailField.value = query.get('email');
    }
  }

  const aiChat = document.querySelector('[data-ai-chat]');
  if (aiChat) {
    const messagesNode = aiChat.querySelector('[data-ai-messages]');
    const form = aiChat.querySelector('[data-ai-form]');
    const input = aiChat.querySelector('[data-ai-input]');
    const status = aiChat.querySelector('[data-ai-status]');
    let conversationId = null;

    const renderMessages = (messages) => {
      messagesNode.innerHTML = messages.length
        ? messages
            .map(
              (message) =>
                `<div class="chat-bubble ${message.role === 'user' ? 'mine' : ''}" style="max-width:82%">${message.role === 'assistant' ? renderMarkdown(message.content) : escapeHtml(message.content).replace(/\n/g, '<br>')}</div>`,
            )
            .join('')
        : '<p class="muted small" data-ai-empty>Escribe tu primera pregunta para iniciar la conversación.</p>';
      messagesNode.scrollTop = messagesNode.scrollHeight;
    };

    const loadConversation = async () => {
      const conversations = await api('/api/ai/conversations');
      if (conversations.length) conversationId = conversations[0].id;
      else
        conversationId = (
          await api('/api/ai/conversations', {
            method: 'POST',
            body: JSON.stringify({ title: 'Conversación de estudio' }),
          })
        ).id;
      const conversation = await api(`/api/ai/conversations/${conversationId}`);
      renderMessages(conversation.messages || []);
      status.textContent = 'Listo para tu pregunta';
      status.className = 'status success';
    };

    loadConversation().catch((error) => {
      status.textContent = error.message;
      status.className = 'status warning';
      form.querySelector('button').disabled = true;
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const content = input.value.trim();
      if (!content || !conversationId) return;
      const button = form.querySelector('button');
      button.disabled = true;
      input.disabled = true;
      status.textContent = 'Procesando…';
      status.className = 'status info';
      try {
        const result = await api(`/api/ai/conversations/${conversationId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content }),
        });
        const current = await api(`/api/ai/conversations/${conversationId}`);
        renderMessages(current.messages || []);
        input.value = '';
        status.textContent = `Conectado a ${result.provider === 'groq' ? 'Groq' : 'Grok'} IA · ${result.model || 'modelo activo'}`;
      } catch (error) {
        status.textContent = error.message;
        status.className = 'status warning';
      } finally {
        button.disabled = false;
        input.disabled = false;
        input.focus();
      }
    });

    aiChat.querySelectorAll('[data-ai-prompt]').forEach((chip) =>
      chip.addEventListener('click', () => {
        input.value = chip.dataset.aiPrompt || chip.textContent.trim();
        input.focus();
      }),
    );
  }

  const chatPage = document.querySelector('[data-chat-page]');
  if (chatPage) {
    const conversationsNode = chatPage.querySelector('[data-chat-conversations]');
    const messagesNode = chatPage.querySelector('[data-chat-messages]');
    const titleNode = chatPage.querySelector('[data-chat-title]');
    const statusNode = chatPage.querySelector('[data-chat-status]');
    const form = chatPage.querySelector('[data-chat-form]');
    const input = form?.querySelector('input[name="body"]');
    const button = form?.querySelector('button');
    let storedUser = {};
    try {
      storedUser = JSON.parse(localStorage.getItem('tutoreshub_user') || '{}');
    } catch {
      storedUser = {};
    }
    const normaliseRole = (value) => {
      const candidate = String(value || '')
        .trim()
        .toLowerCase();
      if (['tutor', 'teacher', 'professor', 'profesor', 'instructor'].includes(candidate)) return 'tutor';
      if (['student', 'learner', 'estudiante'].includes(candidate)) return 'student';
      return null;
    };
    let role = normaliseRole(storedUser.role || storedUser.userRole || storedUser.user_role);
    const applyChatIdentity = (user) => {
      const nextRole = normaliseRole(user?.role) || role;
      if (!nextRole) return;
      storedUser = { ...storedUser, ...user, role: nextRole };
      role = storedUser.role;
      localStorage.setItem('tutoreshub_user', JSON.stringify(storedUser));
      applyAvatar(document.querySelectorAll('[data-user-initials]'), storedUser);
      chatPage.querySelectorAll('[data-chat-student-link]').forEach((node) => {
        node.hidden = role !== 'student';
      });
      chatPage.querySelectorAll('[data-chat-tutor-link]').forEach((node) => {
        node.hidden = role !== 'tutor';
      });
      const accountLink = chatPage.querySelector('[data-chat-account-link]');
      if (accountLink) accountLink.href = role === 'tutor' ? 'mi-cuenta-tutor.html' : 'mi-cuenta-estudiante.html';
      chatPage
        .querySelector('[data-chat-user-role]')
        ?.replaceChildren(document.createTextNode(role === 'tutor' ? 'Profesor' : 'Estudiante'));
    };
    if (role) applyChatIdentity(storedUser);
    let conversations = [];
    let activeId = null;
    const renderMessages = (messages) => {
      messagesNode.innerHTML = messages.length
        ? messages
            .map(
              (message) =>
                `<div class="chat-bubble ${message.sender_id === storedUser.id ? 'mine' : ''}" style="max-width:82%;white-space:pre-wrap">${escapeHtml(message.body)}</div>`,
            )
            .join('')
        : '<p class="muted small">Todavía no hay mensajes. Escribe el primero.</p>';
      messagesNode.scrollTop = messagesNode.scrollHeight;
    };
    const loadConversation = async (id) => {
      const conversation = await api(`/api/chat/conversations/${encodeURIComponent(id)}`);
      activeId = conversation.id;
      const other = conversations.find((item) => item.id === activeId)?.other_user;
      titleNode.textContent = other?.full_name || 'Conversación';
      statusNode.textContent = other?.email || 'Mensajes persistentes';
      input.disabled = false;
      button.disabled = false;
      renderMessages(conversation.messages || []);
      conversationsNode
        .querySelectorAll('[data-chat-conversation]')
        .forEach((node) => node.classList.toggle('active', node.dataset.chatConversation === activeId));
    };
    const renderConversations = () => {
      conversationsNode.innerHTML = conversations.length
        ? conversations
            .map((conversation) => {
              const other = conversation.other_user || {};
              const name = other.full_name || 'Usuario';
              const initials = initialsFor(name);
              return `<button type="button" class="chat-conversation-item ${conversation.id === activeId ? 'active' : ''}" data-chat-conversation="${escapeHtml(conversation.id)}"><span class="avatar chat-conversation-avatar${other.avatar_url ? ' has-avatar' : ''}"${other.avatar_url ? ` style="background-image:url('${escapeHtml(other.avatar_url)}')"` : ''}>${other.avatar_url ? '' : escapeHtml(initials)}</span><span><strong>${escapeHtml(name)}</strong><span>${escapeHtml(role === 'student' ? 'Tutor' : 'Estudiante')}</span></span></button>`;
            })
            .join('')
        : '<p class="muted small">Aún no tienes conversaciones. Abre Chat desde un perfil o una solicitud.</p>';
      conversationsNode.querySelectorAll('[data-chat-conversation]').forEach((node) =>
        node.addEventListener('click', () =>
          loadConversation(node.dataset.chatConversation).catch((error) => {
            statusNode.textContent = error.message;
          }),
        ),
      );
    };
    const start = async () => {
      const authenticatedUser = await api('/api/me');
      applyChatIdentity(authenticatedUser);
      const query = new URLSearchParams(window.location.search);
      const targetTutor = query.get('tutor');
      const targetStudent = query.get('student');
      if (targetTutor || targetStudent) {
        const created = await api('/api/chat/conversations', {
          method: 'POST',
          body: JSON.stringify(
            role === 'student'
              ? { tutorId: targetTutor }
              : { studentId: targetStudent, requestId: query.get('request') || undefined },
          ),
        });
        conversations = await api('/api/chat/conversations');
        renderConversations();
        await loadConversation(created.id);
      } else {
        conversations = await api('/api/chat/conversations');
        renderConversations();
        if (conversations[0]) await loadConversation(conversations[0].id);
      }
    };
    start().catch((error) => {
      applyChatIdentity(storedUser);
      statusNode.textContent = error.message;
      statusNode.className = 'status warning';
      conversationsNode.innerHTML = `<p class="muted small">${escapeHtml(error.message)}</p>`;
    });
    window.setInterval(async () => {
      if (!activeId || document.hidden) return;
      try {
        const conversation = await api(`/api/chat/conversations/${encodeURIComponent(activeId)}`);
        renderMessages(conversation.messages || []);
      } catch {
        /* La sesión global gestiona la expiración. */
      }
    }, 5000);
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = input.value.trim();
      if (!activeId || !body) return;
      button.disabled = true;
      input.disabled = true;
      try {
        await api(`/api/chat/conversations/${encodeURIComponent(activeId)}/messages`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        });
        input.value = '';
        await loadConversation(activeId);
      } catch (error) {
        statusNode.textContent = error.message;
      } finally {
        button.disabled = false;
        input.disabled = false;
        input.focus();
      }
    });
  }

  const reviewPage = document.querySelector('[data-review-page]');
  if (reviewPage) {
    const sessionId = new URLSearchParams(window.location.search).get('session');
    const content = reviewPage.querySelector('[data-review-content]');
    const status = reviewPage.querySelector('[data-review-status]');
    if (!sessionId) {
      status.textContent = 'Selecciona una tutoría';
      content.innerHTML =
        '<div class="card soft-yellow"><h2>No hay una tutoría seleccionada</h2><p class="muted">Vuelve a Mis tutorías para elegir una sesión pendiente de reseña.</p><a class="btn btn-secondary" href="mis-tutorias.html">Ir a Mis tutorías</a></div>';
    } else {
      api(`/api/sessions/${encodeURIComponent(sessionId)}`)
        .then((session) => {
          if (session.status !== 'review_pending')
            throw new Error(
              'La tutoría todavía no está lista para reseñarse. Regresa al aula y marca que terminaste la llamada.',
            );
          status.textContent = 'Pendiente de reseña';
          status.className = 'status info';
          content.innerHTML = `<section class="card"><div class="row-between"><div><span class="tag">Tutoría ${session.status === 'completed' ? 'completada' : 'finalizada'}</span><h2 style="margin-top:12px">¿Cómo fue tu experiencia?</h2><p class="muted">Califica al profesor y añade un comentario opcional. Al enviar, la tutoría quedará completada.</p></div><span class="rating">★★★★★</span></div><form class="stack" data-review-form style="margin-top:22px"><div class="field"><label for="review-rating">Calificación</label><select id="review-rating" name="rating" required><option value="5">5 · Excelente</option><option value="4">4 · Muy buena</option><option value="3">3 · Buena</option><option value="2">2 · Puede mejorar</option><option value="1">1 · Mala</option></select></div><div class="field"><label for="review-comment">Comentario (opcional)</label><textarea id="review-comment" name="comment" maxlength="1000" placeholder="Comparte un detalle útil para otros estudiantes."></textarea></div><div class="row-between"><a class="btn btn-secondary" href="mis-tutorias.html">Ahora no</a><button class="btn btn-primary" type="submit">Publicar reseña →</button></div></form></section>`;
          const form = content.querySelector('[data-review-form]');
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const button = form.querySelector('button[type=submit]');
            button.disabled = true;
            try {
              await api(`/api/sessions/${encodeURIComponent(sessionId)}/reviews`, {
                method: 'POST',
                body: JSON.stringify({
                  rating: Number(value(form, '[name=rating]')),
                  comment: value(form, '[name=comment]'),
                }),
              });
              window.location.href = 'mis-tutorias.html?reviewed=1';
            } catch (error) {
              feedback(form, error.message);
              button.disabled = false;
            }
          });
        })
        .catch((error) => {
          status.textContent = 'No disponible';
          status.className = 'status warning';
          content.innerHTML = `<div class="card soft-yellow"><h2>No se puede publicar todavía</h2><p class="muted">${escapeHtml(error.message)}</p><a class="btn btn-secondary" href="mis-tutorias.html">Volver a Mis tutorías</a></div>`;
        });
    }
  }

  const video = document.querySelector('[data-external-room]');
  if (video) {
    const sessionId = new URLSearchParams(window.location.search).get('session');
    const statuses = video.querySelectorAll('[data-video-status]');
    const setVideoStatus = (message, className) =>
      statuses.forEach((node) => {
        node.textContent = message;
        node.className = `status ${className}`;
      });
    const meetingLink = video.querySelector('[data-external-meeting]');
    const roomLabel = video.querySelector('[data-meeting-room]');
    const finishButton = video.querySelector('[data-finish-session]');
    const lifecycle = video.querySelector('[data-session-lifecycle]');
    meetingLink?.addEventListener('click', (event) => {
      if (meetingLink.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
      }
    });
    if (!sessionId) setVideoStatus('Abre el aula desde una tutoría confirmada.', 'warning');
    else {
      Promise.all([
        api(`/api/sessions/${encodeURIComponent(sessionId)}/meeting`),
        api(`/api/sessions/${encodeURIComponent(sessionId)}`),
        api('/api/me'),
      ])
        .then(([meeting, session, currentUser]) => {
          const now = Date.now();
          const startAt = new Date(session.starts_at).getTime();
          const endAt = new Date(session.ends_at).getTime();
          const availableNow = now >= startAt && now <= endAt && !['completed', 'cancelled'].includes(session.status);
          meetingLink.href = availableNow ? meeting.meetingUrl : '#';
          meetingLink.toggleAttribute('aria-disabled', !availableNow);
          meetingLink.classList.toggle('disabled', !availableNow);
          meetingLink.tabIndex = availableNow ? 0 : -1;
          setVideoStatus(
            availableNow
              ? 'Aula habilitada · abre en otra pestaña'
              : `Aula disponible ${new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(startAt))}`,
            availableNow ? 'success' : 'warning',
          );
          if (!availableNow) meetingLink.textContent = 'Disponible durante la tutoría';
          if (roomLabel) roomLabel.textContent = `Sala: ${meeting.roomName}`;
          const studentReminder = video.querySelector('[data-student-call-reminder]');
          if (studentReminder) studentReminder.hidden = currentUser.role !== 'student';
          const studentLabel = video.querySelector('[data-session-student]');
          const tutorLabel = video.querySelector('[data-session-tutor]');
          if (studentLabel) studentLabel.textContent = session.student?.full_name || 'Estudiante';
          if (tutorLabel) tutorLabel.textContent = session.tutor?.full_name || 'Tutor';
          if (lifecycle)
            lifecycle.textContent =
              session.status === 'review_pending'
                ? 'La llamada terminó. Falta registrar la reseña para completar la tutoría.'
                : session.status === 'completed'
                  ? 'Esta tutoría ya está completada.'
                  : 'La sesión está lista para comenzar.';
          if (currentUser.role === 'tutor') {
            finishButton.textContent = 'Terminar la tutoría';
          }
          if (session.status === 'completed') {
            finishButton.disabled = true;
            finishButton.textContent = 'Tutoría completada';
          }
          finishButton?.addEventListener('click', async () => {
            finishButton.disabled = true;
            try {
              await api(`/api/sessions/${encodeURIComponent(sessionId)}/finish`, { method: 'POST' });
              window.location.href =
                currentUser.role === 'tutor'
                  ? 'clases-impartidas.html'
                  : `resena.html?session=${encodeURIComponent(sessionId)}`;
            } catch (error) {
              finishButton.disabled = false;
              window.alert(error.message);
            }
          });
        })
        .catch((error) => {
          setVideoStatus(error.message, 'warning');
          if (meetingLink) meetingLink.classList.add('disabled');
        });
    }
  }
})();
