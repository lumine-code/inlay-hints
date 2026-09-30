const { CompositeDisposable } = require("lumine");
const ProviderRegistry = require("./provider-registry");
const ViewportTracker = require("./viewport-tracker");

const DEFAULT_MAX_LABEL_LENGTH = 48;

// JSON escapes such as \n and \t are not CSS string escapes. Keep labels
// literal even when a provider returns quotes, backslashes or control characters.
const cssStringFor = (label) =>
  `"${label.replace(/["\\\p{Cc}]/gu, (character) =>
    character === '"' || character === "\\"
      ? `\\${character}`
      : `\\${character.charCodeAt(0).toString(16)} `,
  )}"`;

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
      lumine.config.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("inlay-hints.enabled") ||
          event.affectsConfiguration("inlay-hints.maxLabelLength")
        ) {
          this.fetchAll();
        }
      }),
      lumine.commands.add("lumine-workspace", {
        "inlay-hints:toggle": {
          description: "Show or hide the inline type and parameter-name labels.",
          didDispatch: (event) => this.toggle(event),
        },
        "inlay-hints:refresh": {
          description: "Ask the providers for this file's hints again.",
          didDispatch: (event) => this.refresh(event),
        },
      }),
    );
  }

  // The global value, which is what the settings page shows. A language with an
  // override of its own keeps it, and says so rather than appearing to ignore
  // the command.
  toggle(event) {
    const next = !lumine.config.get("inlay-hints.enabled");
    lumine.config.set("inlay-hints.enabled", next);
    const element = event?.target?.closest?.("lumine-text-editor:not([mini])");
    const editor = element?.getModel?.() ?? lumine.workspace.getActiveTextEditor();
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

  refresh(event) {
    const element = event?.target?.closest?.("lumine-text-editor:not([mini])");
    const editor = element?.getModel?.() ?? lumine.workspace.getActiveTextEditor();
    if (!editor) return;
    if (!this.enabledFor(editor)) {
      lumine.notifications.addWarning("Inlay hints are disabled for this language", {
        description:
          "Enable Inlay Hints globally or in this language's scoped settings before refreshing.",
      });
      return;
    }
    if (!this.registry.getAllProvidersForEditor(editor).length) {
      lumine.notifications.addWarning("No inlay hints provider serves this file", {
        description: "Enable a language backend that supplies inlay hints for this grammar.",
      });
      return;
    }
    this.fetchEditor(editor);
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
      // Invalidate a response as soon as its source text changes, before the
      // debounced stopped-changing event starts the next request.
      editor.getBuffer().onDidChangeText(() => state.generation++),
      // A grammar change swaps which providers serve the editor.
      editor.onDidChangeGrammar(() => this.fetchEditor(editor)),
      // Save As and renaming can change the provider's document identity
      // without changing either its grammar or its text.
      editor.onDidChangePath(() => {
        this.clear(state);
        this.fetchEditor(editor);
      }),
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
    // Removing an edge must remove its labels immediately, even if another
    // provider's next request remains pending.
    if (
      Array.from(state.hints.values()).some((entry) =>
        entry.parts.some((part) => !providers.includes(part.provider)),
      )
    ) {
      this.render(
        state,
        providers.map((provider) => ({ provider, failed: true })),
        startRow,
        endRow,
      );
    }
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
    const characters = Array.from(label);
    return characters.length > max ? `${characters.slice(0, max).join("")}…` : label;
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
    const existing = new Map();
    const retained = new Map();
    for (const entry of state.hints.values()) {
      // A touched marker is invalid and cannot be brought back by reusing it.
      if (entry.marker.isDestroyed() || !entry.marker.isValid()) {
        entry.marker.destroy();
        continue;
      }
      // Markers move with edits. Index the live anchor rather than the position
      // from the last response, or an old key can reuse a marker in the wrong place.
      const point = entry.atEnd
        ? entry.marker.getEndBufferPosition()
        : entry.marker.getStartBufferPosition();
      existing.set(this.keyFor(point.row, point.column, entry), entry);
      for (const part of entry.parts) {
        if (!retained.has(part.provider)) retained.set(part.provider, []);
        retained.get(part.provider).push({ ...part, row: point.row, column: point.column });
      }
    }

    // One pseudo-element can show one string. Combine distinct labels at the
    // same anchor before decorating, in provider-priority and source order.
    const groups = new Map();
    const add = (provider, hint, row, requested) => {
      if (row > buffer.getLastRow()) return;
      const lineLength = buffer.lineLengthForRow(row);
      if (lineLength === 0) return;
      const label = this.labelFor(hint);
      if (!label) return;
      const column = Math.min(requested, lineLength);
      const atEnd = column >= lineLength;
      const key = `${row}:${column}:${atEnd ? "a" : "b"}`;
      if (!groups.has(key)) groups.set(key, { row, column, atEnd, parts: new Map() });
      const parts = groups.get(key).parts;
      const signature = JSON.stringify([label, !!hint.paddingLeft, !!hint.paddingRight]);
      if (!parts.has(signature)) parts.set(signature, { ...hint, provider, text: label });
    };
    for (const { provider, hints, failed } of results) {
      // A failure preserves this provider's last answer. An array replaces only
      // the requested rows; null and unregistered providers withdraw all rows.
      if (failed || hints) {
        for (const part of retained.get(provider) || []) {
          if (failed || part.row < startRow || part.row > endRow)
            add(provider, part, part.row, part.column);
        }
      }
      for (const hint of hints || []) {
        const point = pointFor(hint?.position);
        if (point && point[0] >= startRow && point[0] <= endRow) add(provider, hint, ...point);
      }
    }

    const next = new Map();
    for (const group of groups.values()) {
      const parts = [...group.parts.values()];
      const paddingLeft = !!parts[0].paddingLeft;
      const paddingRight = !!parts[parts.length - 1].paddingRight;
      const label = parts
        .map((part, index) => {
          const space = index > 0 && (parts[index - 1].paddingRight || part.paddingLeft);
          return `${space ? " " : ""}${part.text}`;
        })
        .join("");
      const data = { ...group, parts, label, paddingLeft, paddingRight };
      const key = this.keyFor(group.row, group.column, data);
      const entry = existing.get(key) ?? this.createHint(state, data);
      existing.delete(key);
      entry.parts = parts;
      entry.provider = parts[0].provider;
      next.set(key, entry);
    }
    for (const entry of existing.values()) entry.marker.destroy();
    state.hints = next;
  }

  keyFor(row, column, { atEnd, label, paddingLeft, paddingRight }) {
    const pads = `${paddingLeft ? "L" : ""}${paddingRight ? "R" : ""}`;
    return `${row}:${column}:${atEnd ? "a" : "b"}:${pads}:${label}`;
  }

  createHint(state, { row, column, atEnd, label, paddingLeft, paddingRight }) {
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
    if (paddingLeft) className += ` ${className}-pad-left`;
    if (paddingRight) className += ` ${atEnd ? "inlay-hints-after" : "inlay-hints"}-pad-right`;
    const properties = {
      type: "text",
      class: className,
      style: { [atEnd ? "--inlay-hints-after-text" : "--inlay-hints-text"]: cssStringFor(label) },
    };
    state.editor.decorateMarker(marker, properties);
    return { marker, properties, atEnd, label, paddingLeft, paddingRight };
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
