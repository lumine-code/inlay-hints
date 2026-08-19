const { CompositeDisposable } = require("lumine");
const ProviderRegistry = require("./provider-registry");
const ViewportTracker = require("./viewport-tracker");

const DEFAULT_MAX_LABEL_LENGTH = 48;

// A provider may return a Point or a bare [row, column] pair.
const pointFor = (position) => {
  if (!position) return null;
  const row = Array.isArray(position) ? position[0] : position.row;
  const column = Array.isArray(position) ? position[1] : position.column;
  if (!Number.isInteger(row) || row < 0) return null;
  return [row, Number.isInteger(column) && column > 0 ? column : 0];
};

// Renders the registered providers' hints as text decorations whose ::before
// (or ::after at end of line) content comes from a CSS custom property, so no
// extra DOM nodes or measurement work are needed beyond the renderer's own
// width-changing text-decoration support. Only the rows on screen are asked
// for, driven by the viewport tracker. The gate is the scoped config
// inlay-hints.enabled.
module.exports = class InlayHintsManager {
  constructor() {
    this.registry = new ProviderRegistry();
    this.tracker = new ViewportTracker();
    this.states = new Map();
    this.subscriptions = new CompositeDisposable(
      lumine.workspace.observeTextEditors((editor) => this.watchEditor(editor)),
      this.registry.onDidChange(() => this.fetchAll()),
      this.registry.onDidInvalidate(({ editor }) =>
        editor ? this.fetchEditor(editor) : this.fetchAll(),
      ),
      // The tracker also watches the buffer, so an edit arrives here too.
      this.tracker.onDidBecomeStale(({ editor, range }) => {
        const state = this.states.get(editor);
        if (state) this.fetch(state, range);
      }),
      lumine.config.onDidChange("inlay-hints.enabled", () => this.fetchAll()),
      lumine.config.onDidChange("inlay-hints.maxLabelLength", () => this.fetchAll()),
      lumine.commands.add("lumine-workspace", {
        "inlay-hints:toggle": {
          description: "Show or hide the inline type and parameter-name labels.",
          didDispatch: () => this.toggle(),
        },
        "inlay-hints:refresh": {
          description: "Ask the providers for this file's hints again.",
          didDispatch: () => this.refresh(),
        },
      }),
    );
  }

  // The global value, which is what the settings page shows. A language with an
  // override of its own keeps it, and says so rather than appearing to ignore
  // the command.
  toggle() {
    const next = !lumine.config.get("inlay-hints.enabled");
    lumine.config.set("inlay-hints.enabled", next);
    const editor = lumine.workspace.getActiveTextEditor();
    if (!editor) return;
    const scoped = lumine.config.get("inlay-hints.enabled", {
      scope: editor.getRootScopeDescriptor(),
    });
    if (scoped === next) return;
    lumine.notifications.addWarning(`Inlay hints stay ${scoped ? "on" : "off"} for this language`, {
      description:
        "This language has a setting of its own, which wins over the one just changed. Change it on the Inlay Hints settings page.",
    });
  }

  refresh() {
    const editor = lumine.workspace.getActiveTextEditor();
    if (editor) this.fetchEditor(editor);
  }

  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const state = {
      editor,
      hints: new Map(),
      layer: null,
      generation: 0,
      subscriptions: new CompositeDisposable(),
    };
    this.states.set(editor, state);
    state.subscriptions.add(
      // A grammar change swaps which providers serve the editor.
      editor.onDidChangeGrammar(() => this.fetchEditor(editor)),
      editor.onDidDestroy(() => this.detachEditor(editor)),
    );
    this.fetch(state, this.tracker.rangeForEditor(editor));
  }

  detachEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    state.generation++;
    state.subscriptions.dispose();
    this.clear(state);
    if (!editor.isDestroyed()) state.layer?.destroy();
    this.states.delete(editor);
  }

  enabledFor(editor) {
    return !!lumine.config.get("inlay-hints.enabled", {
      scope: editor.getRootScopeDescriptor(),
    });
  }

  fetchAll() {
    for (const state of this.states.values())
      this.fetch(state, this.tracker.rangeForEditor(state.editor));
  }

  fetchEditor(editor) {
    const state = this.states.get(editor);
    if (state) this.fetch(state, this.tracker.rangeForEditor(editor));
  }

  async fetch(state, range) {
    const { editor } = state;
    const generation = ++state.generation;
    // Nothing is asked while the feature is off, so an expensive provider costs
    // nothing until someone wants it.
    if (!this.enabledFor(editor)) return this.clear(state);
    const providers = this.registry.getAllProvidersForEditor(editor);
    if (!providers.length) return this.clear(state);
    const [startRow, endRow] = range;
    // Three outcomes, and each means something different for what is already on
    // screen: hints replace it, null withdraws it, and a rejection — a server
    // reindexing, say — leaves it alone until the next fetch.
    const results = await Promise.all(
      providers.map(async (provider) => {
        try {
          const hints = await provider.inlayHints(editor, [startRow, endRow]);
          return { provider, hints: Array.isArray(hints) ? hints : null };
        } catch {
          return { provider, failed: true };
        }
      }),
    );
    if (state.generation !== generation || editor.isDestroyed()) return;
    this.render(state, results, startRow, endRow);
  }

  labelFor(hint) {
    const label = typeof hint.label === "string" ? hint.label : "";
    const max = lumine.config.get("inlay-hints.maxLabelLength") ?? DEFAULT_MAX_LABEL_LENGTH;
    return label.length > max ? `${label.slice(0, max)}…` : label;
  }

  // Reconcile against the live entries: a hint that reappears identically keeps
  // its marker and decoration untouched, so its cached property object lets
  // textDecorationsEqual short-circuit the line rebuild. Only stale entries
  // inside the fetched range are destroyed, and only for a provider that
  // answered — rows outside the range were not re-queried, and a provider whose
  // request failed still has the best data available on screen.
  render(state, results, startRow, endRow) {
    const { editor } = state;
    const buffer = editor.getBuffer();
    const next = new Map();
    for (const { provider, hints } of results) {
      for (const hint of hints || []) {
        const point = pointFor(hint?.position);
        if (!point) continue;
        const label = this.labelFor(hint);
        if (!label) continue;
        const [row, requested] = point;
        if (row > buffer.getLastRow()) continue;
        const lineLength = buffer.lineLengthForRow(row);
        // Text decorations skip empty ranges, and an empty line offers no
        // character to span: skip the hint entirely.
        if (lineLength === 0) continue;
        const column = Math.min(requested, lineLength);
        const atEnd = column >= lineLength;
        const pads = `${hint.paddingLeft ? "L" : ""}${hint.paddingRight ? "R" : ""}`;
        const key = `${row}:${column}:${atEnd ? "a" : "b"}:${pads}:${label}`;
        // The providers arrive in priority order, so the first one to claim a
        // key keeps it and a lower-priority duplicate renders once.
        if (next.has(key)) continue;
        const existing = state.hints.get(key);
        if (existing) {
          state.hints.delete(key);
          existing.provider = provider;
          next.set(key, existing);
          continue;
        }
        next.set(key, this.createHint(state, { row, column, atEnd, label, hint, provider }));
      }
    }
    const answered = new Map(
      results.map(({ provider, hints, failed }) => [provider, { hints, failed }]),
    );
    for (const [key, entry] of state.hints) {
      const outcome = answered.get(entry.provider);
      if (outcome?.failed) {
        next.set(key, entry);
        continue;
      }
      // A provider that declined, or that is no longer registered, has nothing
      // to say about this editor any more, wherever its hints sit.
      if (!outcome?.hints) {
        entry.marker.destroy();
        continue;
      }
      const row = entry.marker.getStartBufferPosition().row;
      if (row >= startRow && row <= endRow) entry.marker.destroy();
      else next.set(key, entry);
    }
    state.hints = next;
  }

  createHint(state, { row, column, atEnd, label, hint, provider }) {
    if (!state.layer) state.layer = state.editor.addMarkerLayer({ maintainHistory: false });
    // The decorated span must wrap a real character: [P, P+1] renders the label
    // before the character at P via ::before; at end of line the marker covers
    // the last character and an ::after variant renders behind it. Never
    // [P, P] — the renderer skips empty text-decoration ranges.
    const range = atEnd
      ? [
          [row, column - 1],
          [row, column],
        ]
      : [
          [row, column],
          [row, column + 1],
        ];
    const marker = state.layer.markBufferRange(range, { invalidate: "touch" });
    let className = atEnd ? "inlay-hints-after" : "inlay-hints";
    if (hint.paddingLeft) className += " inlay-hints-pad-left";
    if (hint.paddingRight) className += " inlay-hints-pad-right";
    const properties = {
      type: "text",
      class: className,
      style: { "--inlay-hints-text": JSON.stringify(label) },
    };
    state.editor.decorateMarker(marker, properties);
    return { marker, properties, provider };
  }

  clear(state) {
    if (!state.editor.isDestroyed())
      for (const entry of state.hints.values()) entry.marker.destroy();
    state.hints.clear();
  }

  dispose() {
    for (const editor of [...this.states.keys()]) this.detachEditor(editor);
    this.subscriptions.dispose();
    this.tracker.dispose();
    this.registry.dispose();
  }
};
