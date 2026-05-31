import { FAILURE_COMMANDS } from '../../shared/failure-commands.mjs';

export { FAILURE_COMMANDS };  // 重导出供 verify-app-shell 漂移守卫读取

export function renderFailureCard(card, { onAction }) {
  const el = document.createElement('article');
  el.className = `failure-card kind-${card.kind}`;
  el.dataset.failureId = card.id;
  el.dataset.ts = card.ts;

  const head = document.createElement('header');
  head.className = 'failure-head';
  head.textContent = `故障 #${card.seq} · ${card.title} · ${formatTime(card.ts)}`;
  el.appendChild(head);

  const body = document.createElement('p');
  body.className = 'failure-body';
  body.textContent = card.body;
  el.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'failure-actions';
  for (const action of card.actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    if (action.destructive) btn.classList.add('destructive');
    btn.disabled = !!card.resolution;
    btn.addEventListener('click', () => onAction(card, action));
    actions.appendChild(btn);
  }
  el.appendChild(actions);

  if (card.resolution) {
    const done = document.createElement('p');
    done.className = 'failure-resolved';
    done.textContent = `已选: ${card.resolution.action} · ${formatTime(card.resolution.submittedAt)}`;
    el.appendChild(done);
  }

  const details = document.createElement('details');
  details.className = 'failure-diagnostics';
  const summary = document.createElement('summary');
  summary.textContent = '看技术细节';
  details.appendChild(summary);
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(card.diagnostics, null, 2);
  details.appendChild(pre);
  el.appendChild(details);

  return el;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
