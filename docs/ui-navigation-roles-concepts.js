const docs = [
  {id:'inclusive',title:'Inclusive component handbook',path:'handbook/inclusive-components/index.html',collection:'Handbook',updated:'Sep 22',description:'A practical guide to interfaces that remain understandable across different inputs and contexts.',tags:['accessibility','components'],links:['keyboard','contrast','alerts']},
  {id:'keyboard',title:'Keyboard interaction patterns',path:'handbook/keyboard-interaction.html',collection:'Handbook',updated:'Sep 21',description:'Focus order, shortcuts, and interactions that work without a pointer.',tags:['accessibility','components'],links:['alerts']},
  {id:'contrast',title:'Color and contrast checks',path:'handbook/color-and-contrast.html',collection:'Handbook',updated:'Sep 20',description:'Making state and hierarchy legible across displays and lighting conditions.',tags:['accessibility','design'],links:['inclusive']},
  {id:'alerts',title:'Alert patterns',path:'patterns/alerts.html',collection:'Patterns',updated:'Sep 19',description:'Clear, timely feedback for success, warning, and failure.',tags:['components','design'],links:['inclusive']},
  {id:'resilience',title:'Designing for resilience',path:'editorial/field-notes/index.html',collection:'Editorial',updated:'Sep 23',description:'Field notes on making systems easier to understand under pressure.',tags:['operations','design'],links:['incident','latency']},
  {id:'latency',title:'Edge latency observatory',path:'dashboards/edge-observatory/index.html',collection:'Dashboards',updated:'Sep 23',description:'A dashboard for exploring latency signals across the edge.',tags:['operations','metrics'],links:['incident']},
  {id:'incident',title:'Incident review: edge timeout',path:'reports/edge-timeout.html',collection:'Reports',updated:'Sep 18',description:'A review of user impact, contributing factors, and follow-up work.',tags:['operations','metrics'],links:['latency','resilience']},
  {id:'search',title:'Search experience notes',path:'notes/search-experience.md',collection:'Notes',updated:'Sep 17',description:'How readers find a known artifact or explore an unfamiliar site.',tags:['design','discovery'],links:['inclusive']}
];
const byId = Object.fromEntries(docs.map(doc => [doc.id,doc]));
const initial = () => ({pattern:'A',page:'inclusive',panel:null,tab:'Suggested',query:'',pins:['resilience'],recent:['latency','resilience'],history:[]});
let state = initial();
const guides = {
  A:{title:'A · Palette first',body:'One navigation entry point. Open the palette, switch between Suggested, All, Recent, and Pinned, or type a query to search every document.',tradeoff:'Fewest header controls. Fast for keyboard users; readers must discover the palette to browse.'},
  B:{title:'B · Header library',body:'A visible Library button in the product header opens the site catalog. Suggested, Recent, Pinned, and All share one on-demand surface.',tradeoff:'Easiest broad browsing to discover. Moving to a related page asks readers to open Library and choose Suggested.'},
  C:{title:'C · Explore + Next',body:'The product header separates broad browsing from “where should I go from here?” Explore opens the library; Next opens contextual candidates. Search remains available.',tradeoff:'Strongest distinction between browse and continue. More header controls and two surfaces to learn.'}
};
const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const current = () => byId[state.page] || null;
function reason(doc) {
  const here = current();
  if (!here || here.id === doc.id) return '';
  if (here.links.includes(doc.id)) return 'Linked from this page';
  if (doc.links.includes(here.id)) return 'Links to this page';
  const shared = here.tags.filter(tag => doc.tags.includes(tag));
  if (shared.length) return 'Shared topic · ' + shared[0];
  if (here.collection === doc.collection) return 'Same collection';
  return '';
}
function suggested() {
  return docs.filter(doc => doc.id !== state.page).map(doc => {
    const why = reason(doc);
    const score = why.startsWith('Linked') ? 100 : why.startsWith('Links') ? 75 : why.startsWith('Shared') ? 50 : why.startsWith('Same') ? 25 : 0;
    return {doc,score};
  }).filter(item => item.score).sort((a,b) => b.score-a.score).map(item => item.doc);
}
function navigate(id) {
  if (state.page !== id) state.history.push(state.page);
  state.page = id;
  if (id && byId[id]) state.recent = [id,...state.recent.filter(entry => entry !== id)].slice(0,6);
  state.panel = null;
  state.query = '';
  render();
}
function openPanel(panel) {
  state.panel = state.panel === panel ? null : panel;
  state.tab = current() ? 'Suggested' : 'All';
  state.query = '';
  render();
  if (state.panel === 'palette' || state.panel === 'library') document.getElementById('filter')?.focus();
}
function row(doc, subtitle) {
  const pinned = state.pins.includes(doc.id);
  return `<div class="result"><button class="doc-row" data-open="${doc.id}"><span class="glyph">↗</span><span class="row-main"><strong>${esc(doc.title)}</strong><small>${esc(subtitle || doc.path)}</small></span><span class="row-end">${esc(doc.collection)}</span></button><button class="pin" data-pin="${doc.id}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(doc.title)}" title="${pinned ? 'Unpin' : 'Pin'}">${pinned ? '★' : '☆'}</button></div>`;
}
function group(title, ids, subtitle, limit=99) {
  const items = [...new Set(ids)].map(id => byId[id]).filter(Boolean).slice(0,limit);
  if (!items.length) return '';
  return `<div class="group-title">${esc(title)}<span>${items.length}</span></div>${items.map(doc => row(doc,typeof subtitle === 'function' ? subtitle(doc) : subtitle)).join('')}`;
}
function resultContent() {
  const query = state.query.trim().toLowerCase();
  if (query) {
    const tokens = query.split(/\s+/);
    const matches = docs.filter(doc => tokens.every(token => [doc.title,doc.path,doc.collection,...doc.tags].join(' ').toLowerCase().includes(token)));
    return matches.length ? `<div class="group-title">Search results<span>${matches.length}</span></div>${matches.map(doc => row(doc,doc.path)).join('')}` : '<div class="empty">No matching documents. Try a title, path, or topic.</div>';
  }
  if (state.panel === 'next') return group('Related to this page',suggested().map(doc => doc.id),reason,6) || '<div class="empty">No related documents in this prototype.</div>';
  if (state.panel === 'palette' && state.pattern === 'C') return '<div class="empty">Type a title, path, or topic to search all 8 documents.</div>';
  if (state.tab === 'Suggested') return group('Related to this page',suggested().map(doc => doc.id),reason,8) || '<div class="empty">Open a document to see contextual suggestions.</div>';
  if (state.tab === 'Recent') return group('Opened on this device',state.recent,doc => doc.path);
  if (state.tab === 'Pinned') return group('Saved by you',state.pins,doc => doc.path) || '<div class="empty">No pinned documents yet. Use ☆ beside a result to save one.</div>';
  return [...new Set(docs.map(doc => doc.collection))].map(collection => group(collection,docs.filter(doc => doc.collection === collection).map(doc => doc.id),doc => doc.path)).join('');
}
function panelMarkup() {
  if (!state.panel) return '';
  const panel = state.panel;
  const labels = {palette:'Go to a document',library:'HTML Showcase · Library',next:'Next from here',details:'Artifact details'};
  const tabs = panel === 'library' || (panel === 'palette' && state.pattern === 'A') ? `<div class="tabs" role="tablist" aria-label="${panel === 'library' ? 'Library' : 'Palette'} view">${(current() ? ['Suggested','All','Recent','Pinned'] : ['All','Recent','Pinned']).map(tab => `<button role="tab" data-tab="${tab}" aria-selected="${state.tab === tab}">${tab}</button>`).join('')}</div>` : '';
  const search = panel === 'palette' || panel === 'library' ? `<input class="search-field" id="filter" type="search" value="${esc(state.query)}" placeholder="Search title, path, or topic" aria-label="Search documents">` : '';
  const doc = current();
  const details = doc ? `<div class="details"><p>${esc(doc.description)}</p><dl><dt>Site</dt><dd>HTML Showcase</dd><dt>Path</dt><dd>${esc(doc.path)}</dd><dt>Updated</dt><dd>${esc(doc.updated)}</dd><dt>Source</dt><dd>example/showcase · main</dd><dt>Topics</dt><dd>${doc.tags.map(esc).join(', ')}</dd></dl><button class="control" data-pin="${doc.id}">${state.pins.includes(doc.id) ? '★ Unpin this document' : '☆ Pin this document'}</button></div>` : '';
  return `<div class="scrim" data-action="close"></div><div class="panel ${panel}" role="dialog" aria-modal="true" aria-label="${labels[panel]}"><div class="panel-head"><strong>${labels[panel]}</strong><button data-action="close" aria-label="Close panel">✕</button></div>${tabs}<div class="panel-body">${search}<div id="results">${panel === 'details' ? details : resultContent()}</div></div></div>`;
}
function header() {
  const doc = current();
  const back = state.history.length ? '<button class="back" data-action="back" title="Go back">←</button>' : '';
  const title = doc ? `<span class="crumb">/</span><span class="title" title="${esc(doc.title)}">${esc(doc.title)}</span>` : '';
  const browse = state.pattern === 'B' ? `<button class="action" data-panel="library" aria-expanded="${state.panel === 'library'}">Library</button>` : state.pattern === 'C' ? `<button class="action" data-panel="library" aria-expanded="${state.panel === 'library'}">Explore</button><button class="action" data-panel="next" aria-expanded="${state.panel === 'next'}" ${doc ? '' : 'disabled'}>Next</button>` : '';
  const search = state.pattern === 'B' ? '' : `<button class="action" data-panel="palette" aria-expanded="${state.panel === 'palette'}">${state.pattern === 'A' ? 'Search / Go to' : 'Search'}<span class="shortcut">⌘ / Ctrl K</span></button>`;
  return `<header class="appbar"><span class="brand" aria-hidden="true">G</span>${back}<button class="site" data-action="home">HTML Showcase</button>${title}<span class="spacer"></span>${browse}${search}${doc ? `<button class="action" data-panel="details" aria-expanded="${state.panel === 'details'}">Details</button>` : ''}</header>`;
}
function home() {
  const label = state.pattern === 'B' ? 'Open the library in the header →' : state.pattern === 'C' ? 'Explore the site from the header →' : 'Search or go to a document →';
  const panel = state.pattern === 'A' ? 'palette' : 'library';
  return `<div class="home"><h2>HTML Showcase</h2><p>Eight published artifacts across Handbook, Patterns, Editorial, Dashboards, Reports, and Notes.</p><button class="home-primary" data-panel="${panel}"><span>${label}</span><span>↗</span></button><div class="section-head">Continue reading <small>Opened on this device</small></div>${state.recent.slice(0,2).map(id => `<button class="doc-row" data-open="${id}"><span class="row-main"><strong>${esc(byId[id].title)}</strong><small>${esc(byId[id].path)}</small></span><span class="row-end">↗</span></button>`).join('')}<div class="section-head">Recently updated <small>From the site index</small></div>${['resilience','latency','inclusive'].map(id => `<button class="doc-row" data-open="${id}"><span class="row-main"><strong>${esc(byId[id].title)}</strong><small>${esc(byId[id].path)}</small></span><span class="row-end">${byId[id].updated}</span></button>`).join('')}</div>`;
}
function reader() {
  const doc = current();
  const related = suggested().slice(0,2);
  const handbook = ['inclusive','keyboard','contrast'].includes(doc.id);
  return `<div class="reader"><div class="artifact-shell"><div class="artifact-nav"><strong>${handbook ? 'GOODFORM' : 'SHOWCASE'}</strong><span>Principles</span><span>Patterns</span><span>Resources</span><span>v2.4</span></div><div class="artifact-layout"><aside class="artifact-toc"><strong>${handbook ? 'Foundations' : doc.collection}</strong><span class="selected">${esc(doc.title)}</span><span>Overview</span><span>Examples</span><span>Further reading</span></aside><article class="article"><div class="path">${esc(doc.collection)} / ${esc(doc.path)}</div><h2>${esc(doc.title)}</h2><p class="summary">${esc(doc.description)}</p><div class="callout">A standalone published artifact can include its own navigation and layout. The product header remains available above it.</div><h3>What to explore next</h3><p>Continue through a document link to <button data-open="${related[0]?.id || 'inclusive'}">${esc(related[0]?.title || 'the handbook')}</button>, or use the product navigation to compare its suggestions with Recent and Pinned.</p><div class="next-links">${related.map(item => `<button data-open="${item.id}">↗ ${esc(item.title)}</button>`).join('')}</div></article></div></div></div>`;
}
function render() {
  document.querySelectorAll('[data-pattern]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.pattern === state.pattern)));
  const guide = guides[state.pattern];
  document.getElementById('guide').innerHTML = `<div><strong>${guide.title}</strong><span>${guide.body}</span></div><div class="tradeoff">${guide.tradeoff}</div>`;
  document.getElementById('app').innerHTML = header() + (current() ? reader() : home()) + panelMarkup();
}
document.addEventListener('click', event => {
  const pattern = event.target.closest('[data-pattern]');
  if (pattern) { state.pattern = pattern.dataset.pattern; state.panel = null; state.query = ''; render(); return; }
  const tab = event.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; state.query = ''; render(); document.getElementById('filter')?.focus(); return; }
  const pin = event.target.closest('[data-pin]');
  if (pin) { const id = pin.dataset.pin; state.pins = state.pins.includes(id) ? state.pins.filter(item => item !== id) : [id,...state.pins]; render(); return; }
  const open = event.target.closest('[data-open]');
  if (open) { navigate(open.dataset.open); return; }
  const panel = event.target.closest('[data-panel]');
  if (panel) { openPanel(panel.dataset.panel); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') { state.panel = null; render(); }
  if (action === 'home') navigate(null);
  if (action === 'deep-link') navigate('inclusive');
  if (action === 'reset') { state = initial(); render(); }
  if (action === 'back' && state.history.length) { state.page = state.history.pop(); state.panel = null; state.query = ''; render(); }
});
document.addEventListener('input', event => {
  if (event.target.id !== 'filter') return;
  state.query = event.target.value;
  document.getElementById('results').innerHTML = resultContent();
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); state.panel = null; openPanel(state.pattern === 'B' ? 'library' : 'palette'); }
  if (event.key === 'Escape' && state.panel) { state.panel = null; render(); }
  if (event.key === 'Enter' && event.target.id === 'filter') {
    const first = document.querySelector('#results [data-open]');
    if (first) { event.preventDefault(); navigate(first.dataset.open); }
  }
});
render();
