const { Emitter, CompositeDisposable } = require("lumine");

// Emit only after scrolling settles so a flick through a long file does not
// fire a request per frame.
const SCROLL_SETTLE_MS = 150;
// Rows fetched beyond the visible range, so small scrolls are already covered.
const MARGIN_ROWS = 50;

// Per-editor visible-row-range watcher driving the hint requests. Emits
// "stale" with the visible screen-row range converted to buffer rows, padded by
// MARGIN_ROWS and clamped to the buffer.
module.exports = class ViewportTracker {
  constructor() {
    this.emitter = new Emitter();
    this.states = new Map();
    this.subscriptions = new CompositeDisposable(
      lumine.workspace.observeTextEditors((editor) => this.watchEditor(editor)),
      // Font and theme updates change the visible row count even when the
      // unwrapped display layer and the editor's outer dimensions stay put.
      ...["onDidAddStyleElement", "onDidUpdateStyleElement", "onDidRemoveStyleElement"].map(
        (event) =>
          lumine.styles[event](() => {
            for (const state of this.states.values()) this.scheduleRangeCheck(state);
          }),
      ),
    );
  }
  // fn({editor, range: [startBufferRow, endBufferRow]})
  onDidBecomeStale(fn) {
    return this.emitter.on("stale", fn);
  }
  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const element = editor.getElement();
    const state = {
      editor,
      timer: null,
      rangeTimer: null,
      range: this.rangeForEditor(editor),
      bufferChanging: false,
      forceRangeCheck: false,
      visible: null,
      subscriptions: new CompositeDisposable(),
    };
    this.states.set(editor, state);
    state.subscriptions.add(
      element.onDidChangeScrollTop(() => this.scheduleEmit(state)),
      // Folding and wrap reflow can reveal different buffer rows without any
      // scroll. Wait for the renderer to update before comparing the ranges.
      editor.onDidChange(() => this.scheduleRangeCheck(state)),
      editor.getBuffer().onDidChangeText(() => {
        state.bufferChanging = true;
      }),
      // The buffer already debounces this event (~300 ms after typing stops),
      // so no extra timer is layered on top.
      editor.onDidStopChanging(() => {
        state.bufferChanging = false;
        this.emitStale(state);
      }),
      editor.onDidDestroy(() => this.unwatchEditor(editor)),
    );
    for (const [event, callback] of [
      ["onDidAttach", () => this.bindEditorWindow(state)],
      ["onDidDetach", () => this.releaseEditorWindow(state)],
    ]) {
      const subscription = element[event]?.(callback);
      if (subscription) state.subscriptions.add(subscription);
    }
    this.bindEditorWindow(state);
  }
  bindEditorWindow(state) {
    if (this.states.get(state.editor) !== state) return;
    const element = state.editor.getElement();
    const ownerWindow = element.ownerDocument.defaultView;
    if (state.ownerWindow === ownerWindow) return;
    const initialBinding = state.presentationGeneration == null;
    this.releaseEditorWindow(state);
    state.ownerWindow = ownerWindow;
    if (initialBinding) state.visible = null;

    const generation = state.presentationGeneration;
    const current = () =>
      this.states.get(state.editor) === state &&
      state.ownerWindow === ownerWindow &&
      state.presentationGeneration === generation;
    // A background pane reports a meaningless viewport; emit when the editor
    // is revealed so rows scrolled to while hidden catch up. The
    // editor's own observer may run after this one, so defer the range check
    // until its reveal measurements have settled.
    const observer = new ownerWindow.IntersectionObserver((entries) => {
      if (!current()) return;
      const { intersectionRect } = entries[entries.length - 1];
      const visible = intersectionRect.width > 0 || intersectionRect.height > 0;
      if (visible && state.visible !== true)
        this.scheduleRangeCheck(state, state.visible === false);
      state.visible = visible;
    });
    observer.observe(element);
    // Growing a pane at scrollTop 0 exposes rows without scrolling or changing
    // the display layer. IntersectionObserver only detects visibility changes.
    const resizeObserver = new ownerWindow.ResizeObserver(() => {
      if (current()) this.scheduleRangeCheck(state);
    });
    resizeObserver.observe(element);
    state.intersectionObserver = observer;
    state.resizeObserver = resizeObserver;
  }
  releaseEditorWindow(state) {
    state.presentationGeneration = (state.presentationGeneration ?? 0) + 1;
    this.clearTimers(state);
    state.ownerWindow = null;
    state.intersectionObserver?.disconnect();
    state.resizeObserver?.disconnect();
    state.intersectionObserver = null;
    state.resizeObserver = null;
    state.visible = false;
  }
  clearTimers(state) {
    for (const key of ["timer", "rangeTimer"]) {
      if (state[key] != null) state.ownerWindow?.clearTimeout(state[key]);
      state[key] = null;
    }
  }

  unwatchEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    this.releaseEditorWindow(state);
    state.subscriptions.dispose();
    this.states.delete(editor);
  }
  scheduleEmit(state) {
    if (this.states.get(state.editor) !== state || !state.ownerWindow) return;
    const ownerWindow = state.ownerWindow;
    const generation = state.presentationGeneration;
    if (state.timer != null) state.ownerWindow?.clearTimeout(state.timer);
    const timer = ownerWindow.setTimeout(() => {
      if (
        state.ownerWindow !== ownerWindow ||
        state.presentationGeneration !== generation ||
        state.timer !== timer
      )
        return;
      state.timer = null;
      this.emitStale(state);
    }, SCROLL_SETTLE_MS);
    state.timer = timer;
  }
  scheduleRangeCheck(state, force = false) {
    if (this.states.get(state.editor) !== state || !state.ownerWindow) return;
    const ownerWindow = state.ownerWindow;
    const generation = state.presentationGeneration;
    state.forceRangeCheck ||= force;
    if (state.rangeTimer != null) state.ownerWindow?.clearTimeout(state.rangeTimer);
    const timer = ownerWindow.setTimeout(() => {
      if (
        state.ownerWindow !== ownerWindow ||
        state.presentationGeneration !== generation ||
        state.rangeTimer !== timer
      )
        return;
      state.rangeTimer = null;
      // Buffer changes already get one request after typing stops. Display
      // layer events generated by those changes must not add an earlier one.
      if (state.bufferChanging) return;
      const range = this.rangeForEditor(state.editor);
      if (state.forceRangeCheck || range[0] !== state.range[0] || range[1] !== state.range[1])
        this.emitStale(state);
    }, SCROLL_SETTLE_MS);
    state.rangeTimer = timer;
  }
  emitStale(state) {
    if (this.states.get(state.editor) !== state || !state.ownerWindow) return;
    if (state.editor.isDestroyed()) return;
    // Scroll and layout notifications can describe the same settled viewport.
    // Whichever fires first owns the fetch and consumes the other pending check.
    if (state.timer != null) state.ownerWindow?.clearTimeout(state.timer);
    if (state.rangeTimer != null) state.ownerWindow?.clearTimeout(state.rangeTimer);
    state.timer = null;
    state.rangeTimer = null;
    state.forceRangeCheck = false;
    state.range = this.rangeForEditor(state.editor);
    this.emitter.emit("stale", { editor: state.editor, range: state.range });
  }
  rangeForEditor(editor) {
    const lastBufferRow = editor.getBuffer().getLastRow();
    // An editor that has never been rendered — one opened in a background tab,
    // or observed before its element is attached — reports no visible rows at
    // all. Treat it as showing the top of the buffer rather than converting
    // NaN into a screen position.
    const firstScreenRow = editor.getFirstVisibleScreenRow();
    const lastScreenRow = editor.getLastVisibleScreenRow();
    if (!Number.isFinite(firstScreenRow) || !Number.isFinite(lastScreenRow))
      return [0, Math.min(lastBufferRow, MARGIN_ROWS)];
    const first = editor.bufferRowForScreenRow(firstScreenRow);
    const last = editor.bufferRowForScreenRow(lastScreenRow);
    return [Math.max(0, first - MARGIN_ROWS), Math.min(lastBufferRow, last + MARGIN_ROWS)];
  }
  dispose() {
    for (const editor of [...this.states.keys()]) this.unwatchEditor(editor);
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
};
