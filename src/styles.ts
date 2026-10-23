const CSS = `
.web-page { display:flex; flex-direction:column; height:100%; background:var(--inspector-bg, var(--container-color-alt)); }
.web-toolbar { display:flex; align-items:center; gap:8px; height:var(--app-bar-height); padding:0 calc(var(--plugin-actions-offset, 0px) + 10px) 0 calc(var(--plugin-navigation-offset, 0px) + 10px); background:var(--container-color-alt); border-bottom:1px solid var(--border-light); flex:0 0 auto; -webkit-app-region:no-drag; }
.web-nav-group { display:flex; align-items:center; gap:2px; flex:0 0 auto; }
.web-nav-btn { display:grid; place-items:center; width:28px; height:28px; padding:0; border:none; border-radius:6px; background:none; color:var(--text-secondary); cursor:pointer; }
.web-nav-btn:hover { background:var(--hover-bg); color:var(--text-color); }
.web-nav-btn svg { display:block; }
.web-address { flex:1; min-width:0; height:30px; padding:0 12px; border:1px solid var(--border-medium); border-radius:7px; background:var(--container-color-alt); color:var(--text-color); font-size:0.75rem; outline:none; }
.web-address:focus { border-color:var(--accent-color); }
.web-toolbar-profile { display:flex; align-items:center; gap:5px; flex:0 1 auto; max-width:150px; min-width:0; height:26px; padding:0 7px; border:1px solid var(--border-light); border-radius:999px; color:var(--text-secondary); font-size:0.6875rem; }
.web-toolbar-profile > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.web-toolbar-profile .web-profile-mark { width:16px; height:16px; font-size:11px; }
.web-toolbar-profile .web-profile-mark svg { width:14px; height:14px; }
.web-host { flex:1; min-height:0; position:relative; display:flex; }
.web-host webview, .web-host .web-guest { flex:1; width:100%; height:100%; border:0; }
.web-shortcut-message { padding:var(--space-3); color:var(--text-secondary); font-size:0.75rem; }
.web-shortcut-message[role="alert"] { color:var(--negative-color); }
.web-archive { min-width:0; min-height:0; overflow:hidden; color:var(--text-color); }
.web-archive-label { flex:1; font-size:0.75rem; color:var(--text-secondary); }
.web-archive-frame { flex:1; width:100%; min-height:0; border:0; background:var(--inspector-bg, var(--container-color-alt)); }
.web-har-pagination { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) var(--space-3); font-size:0.75rem; border-bottom:1px solid var(--border-light); }
.web-har-pagination > span:first-child { flex:1; }
.web-archive button:disabled { opacity:.45; cursor:default; }
.web-har-content { flex:1; min-height:0; display:flex; flex-direction:column; }
.web-har-list { flex:1; min-height:120px; overflow:auto; }
.web-har-list table { width:100%; border-collapse:collapse; font-size:0.75rem; }
.web-har-list th { position:sticky; top:0; z-index:1; background:var(--container-color-alt); text-align:left; }
.web-har-list th, .web-har-list td { padding:var(--space-2) var(--space-3); border-bottom:1px solid var(--border-light); white-space:nowrap; }
.web-har-list tr:hover, .web-har-list tr.is-selected { background:var(--hover-bg); }
.web-har-list td { cursor:pointer; }
.web-har-url { display:block; max-width:36rem; padding:0; border:0; background:none; color:var(--accent-color); font:inherit; text-align:left; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.web-har-details { flex:1; min-height:0; overflow:auto; padding:var(--space-3); border-top:1px solid var(--border-medium); font-size:0.75rem; overflow-wrap:anywhere; }
.web-har-details h2 { font-size:0.875rem; margin:0 0 var(--space-2); }
.web-har-details h3 { font-size:0.75rem; margin:var(--space-3) 0 var(--space-2); }
.web-har-details pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:0.75rem; }
.web-har-pairs { display:grid; grid-template-columns:minmax(7rem, 1fr) minmax(0, 3fr); gap:var(--space-1) var(--space-3); }
.web-har-pairs dt { color:var(--text-secondary); }
.web-har-pairs dd { margin:0; white-space:pre-wrap; }

/* Favorite star in the page toolbar (reuses .web-nav-btn sizing). */
.web-star.is-active { color:var(--accent-color); }
.web-star:disabled { opacity:.4; cursor:default; }
.web-star:disabled:hover { background:none; color:var(--text-secondary); }

.web-panel.panel-body { padding:0; display:flex; flex-direction:column; min-height:0; overflow-y:auto; }

/* ── Topbar: profile dropdown + open-a-site icon, one 37px row ──────────────── */
.web-topbar { display:flex; align-items:center; gap:var(--space-1); height:var(--app-bar-height); padding:0 5px; background:var(--container-color); border-bottom:1px solid var(--border-light); flex:0 0 auto; -webkit-app-region:no-drag; }
.web-profile-btn { display:flex; align-items:center; gap:var(--space-2); flex:1; min-width:0; height:26px; padding:0 6px; border:none; border-radius:var(--radius-sm); background:transparent; color:var(--text-color); font-size:0.75rem; cursor:pointer; -webkit-app-region:no-drag; }
.web-profile-btn:hover { background:var(--hover-bg); }
.web-profile-label { flex:1; min-width:0; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.web-profile-chevron { flex:0 0 auto; font-size:13px; color:var(--text-tertiary); }
.web-profile-mark { display:grid; place-items:center; flex:0 0 auto; width:20px; height:20px; color:var(--text-secondary); font-size:13px; font-weight:600; line-height:1; }
.web-profile-btn > .web-profile-mark svg { width:17px; height:17px; }
.web-profile-mark--plain { width:auto; height:auto; background:none; color:inherit; }
.web-icon-btn { display:flex; align-items:center; justify-content:center; flex:0 0 auto; width:26px; height:26px; padding:0; border:none; border-radius:var(--radius-sm); background:transparent; color:var(--text-tertiary); font-size:14px; cursor:pointer; -webkit-app-region:no-drag; }
.web-icon-btn:hover { background:var(--hover-bg); color:var(--title-color); }
.web-icon-btn.danger:hover { color:var(--negative-color); }

/* ── Favorites / Reading list / Timeline switcher (icon tabs) ───────────────── */
.web-list-tabs { display:flex; align-items:center; gap:var(--space-1); height:var(--app-bar-height); padding:0 5px; background:var(--container-color); border-bottom:1px solid var(--border-light); flex:0 0 auto; -webkit-app-region:no-drag; }
.web-list-tab { display:flex; align-items:center; justify-content:center; flex:0 0 auto; width:26px; height:26px; padding:0; border:none; border-radius:var(--radius-sm); background:transparent; color:var(--text-tertiary); cursor:pointer; }
.web-list-tab:hover { background:var(--hover-bg); color:var(--title-color); }
.web-list-tab.active { background:var(--hover-bg); color:var(--accent-color); }

.web-sec { display:flex; flex-direction:column; }
.web-sec-head { display:flex; align-items:center; justify-content:flex-end; gap:4px; padding:6px 6px 0; }
.web-link-btn:disabled { opacity:.4; cursor:default; }
.web-link-btn:disabled:hover { background:none; }

.web-group { display:flex; flex-direction:column; }
.web-group-label { display:flex; align-items:center; gap:8px; padding:11px 10px 5px; font-size:0.6875rem; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--text-tertiary); }
.web-group-label::after { content:""; flex:1; height:1px; background:var(--border-light); }

.web-list { display:flex; flex-direction:column; padding:0 0 6px; }
.web-list-row { display:flex; align-items:center; gap:2px; border-bottom:1px solid var(--border-light); }
.web-list-row:hover { background:var(--hover-bg); }
.web-list-row:focus-within { background:var(--hover-bg); }
.web-list-open { display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; padding:7px 10px; border:none; background:none; text-align:left; cursor:pointer; -webkit-app-region:no-drag; }
.web-list-title { font-size:0.75rem; color:var(--text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.web-list-url { font-size:0.6875rem; color:var(--text-tertiary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.web-list-ts { color:var(--text-tertiary); }
.web-list-remove { flex:0 0 auto; width:22px; height:22px; margin-right:2px; padding:0; border:none; border-radius:5px; background:none; color:var(--text-tertiary); font-size:16px; line-height:1; cursor:pointer; opacity:0; -webkit-app-region:no-drag; }
.web-list-row:hover .web-list-remove, .web-list-row:focus-within .web-list-remove { opacity:1; }
.web-list-remove:hover { background:var(--container-color); color:var(--text-color); }
.web-list-tab { position:relative; }
.web-list-tab-dot { position:absolute; top:3px; right:3px; width:6px; height:6px; border-radius:50%; background:var(--accent-color); animation:web-activity-pulse 1.2s ease-in-out infinite; }
.web-activity-mark { display:flex; align-items:center; justify-content:center; flex:0 0 auto; width:16px; margin-left:8px; color:var(--text-tertiary); }
.web-activity-row .web-list-open { padding-left:6px; }
.web-activity-row.is-done .web-activity-mark { color:var(--positive-color, var(--accent-color)); }
.web-activity-row.is-error .web-activity-mark, .web-activity-row.is-error .web-list-url { color:var(--negative-color); }
.web-activity-spinner { width:10px; height:10px; border:1.5px solid var(--border-medium); border-top-color:var(--accent-color); border-radius:50%; animation:web-activity-spin .8s linear infinite; }
@keyframes web-activity-spin { to { transform:rotate(360deg); } }
@keyframes web-activity-pulse { 0%, 100% { opacity:1; } 50% { opacity:.35; } }
@media (prefers-reduced-motion: reduce) { .web-activity-spinner, .web-list-tab-dot { animation:none; } }

/* ── Settings (surfing.settings — General / Privacy & Ad-block / Profiles) ──────
   Layout only. Every control here is the settings kit's, on the shared
   shared control-token contract — a local frame would win the cascade (this sheet is
   injected after the bundle) and drift the page away from every other one. */
.web-settings { min-width:0; }
.web-embed-errors { margin:8px 0; padding:8px 10px; border:1px solid var(--negative-color); border-radius:7px; color:var(--negative-color); font-size:0.6875rem; overflow-wrap:anywhere; }
.web-adblock-list-row, .web-adblock-frequency-row, .web-profile-stats-row { flex-direction:column; align-items:stretch; gap:var(--space-3); }
.web-adblock-rules { display:flex; flex-direction:column; gap:var(--space-2); width:100%; min-width:0; }
.web-adblock-rule.settings-row-control { display:grid; grid-template-columns:minmax(0, 1fr) auto; align-items:center; gap:var(--space-2); width:100%; min-width:0; }
.web-adblock-rule > :first-child { width:100%; min-width:0; }
.web-adblock-add { display:flex; align-items:center; padding-top:var(--space-1); }
.web-adblock-frequency { width:min(320px, 100%); min-width:0; }
.web-profile-stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--space-2); width:100%; min-width:0; }
.web-profile-stats > span { display:flex; flex-direction:column; gap:2px; min-width:0; padding:7px 9px; border:1px solid var(--border-light); border-radius:7px; color:var(--text-secondary); font-size:0.6875rem; }
.web-profile-stats strong { color:var(--text-color); font-size:0.875rem; font-weight:600; }
.web-profile-actions.settings-row-actions { justify-content:flex-start; flex-wrap:wrap; gap:var(--space-3); padding:var(--space-4) 0; }
.web-profile-delete-row.settings-path-row { padding-bottom:var(--space-4); border-bottom:0; }
.web-metadata-icon { display:flex; align-items:center; min-width:0; }
.web-metadata-icon img { width:24px; height:24px; flex:0 0 auto; border-radius:5px; object-fit:contain; }

@media (max-width:720px) {
  .web-toolbar-profile { max-width:96px; }
}

/* Profiles is the shared settings list page (.settings-listpage-* / .settings-list-*
   in SettingsModal.css) — only the pieces that page has no class for live here. */
.web-profile-swatch { padding:0; border:none; cursor:pointer; -webkit-app-region:no-drag; }
.web-profile-swatch:hover { background:var(--border-light); color:var(--text-color); }
/* A profile's mark sizes to its well rather than to the 1em the sidebar gives it. */
.settings-list-glyph .web-profile-mark--plain { display:grid; place-items:center; font-size:inherit; }
.settings-list-glyph .web-profile-mark--plain svg { width:1.15em; height:1.15em; }
.web-profile-badge { flex:0 0 auto; padding:1px 7px; border:1px solid var(--border-light); border-radius:999px; color:var(--text-tertiary); font-size:0.6875rem; line-height:1.5; text-transform:lowercase; }
/* The detail page's identity header, matching Accounts'/Email's. */
.web-detail-identity { display:flex; align-items:center; gap:12px; padding:14px 0; }
.web-row-actions { display:flex; align-items:center; gap:var(--space-2); flex-shrink:0; }
.web-link-btn { padding:2px 6px; border:none; border-radius:5px; background:none; color:var(--accent-color); font-size:0.75rem; cursor:pointer; white-space:nowrap; -webkit-app-region:no-drag; }
.web-link-btn:hover { background:var(--hover-bg); }
.web-link-btn.danger { color:#e5484d; }

.web-empty { font-size:0.75rem; color:var(--text-secondary); padding:8px 6px; }
`

export function injectStyles(): () => void {
  const id = 'notes-web-styles'
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = CSS
  return () => {
    if (document.getElementById(id) === el) el.remove()
  }
}
