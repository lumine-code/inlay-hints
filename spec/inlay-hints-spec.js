const os = require("os");
const path = require("path");
const { CompositeDisposable, Emitter } = require("lumine");
const ViewportTracker = require("../lib/viewport-tracker");

const packageRoot = path.join(__dirname, "..");

// Flushes pending microtasks so the fetch chains settle without advancing the
// fake clock.
async function microtasks(count = 40) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

const hintAt = (row, column, label, extra = {}) => ({
  position: [row, column],
  label,
  ...extra,
});

describe("inlay-hints", () => {
  let mainModule, manager, editor, disposables;

  const stateFor = () => manager.states.get(editor);
  const entries = () => [...stateFor().hints.values()];
  const wholeBuffer = () => [0, editor.getBuffer().getLastRow()];

  beforeEach(async () => {
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    disposables = new CompositeDisposable();
    lumine.notifications.clear();

    editor = await lumine.workspace.open(path.join(os.tmpdir(), "inlay-hints-example.js"));
    editor.setText("const sum = add(first, second);\n\nlet x = 5;\n");
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);

    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;
    manager = mainModule.manager;
    lumine.config.set("inlay-hints.enabled", true);
    lumine.config.set("inlay-hints.maxLabelLength", 48);
    await microtasks();
  });

  afterEach(async () => {
    disposables.dispose();
    await lumine.packages.deactivatePackage("inlay-hints");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  // A provider following the inlay-hints.provider contract: `grammarScopes` is
  // a getter, and `inlayHints` answers for the row range it is handed.
  function addProvider({ inlayHints, priority } = {}) {
    const emitter = new Emitter();
    const provider = {
      get grammarScopes() {
        return [editor.getGrammar().scopeName];
      },
      priority,
      inlayHints,
      onDidInvalidate: (fn) => emitter.on("invalidate", fn),
      invalidate: (event) => emitter.emit("invalidate", event),
    };
    disposables.add(mainModule.consumeInlayHints(provider));
    return provider;
  }

  it("renders labels through the CSS custom property, skipping empty lines", async () => {
    addProvider({
      inlayHints: () => [hintAt(0, 11, ": number", { paddingLeft: true }), hintAt(1, 0, "skipped")],
    });
    await microtasks();
    const span = editor.getElement().querySelector(".line .inlay-hints");
    expect(span).not.toBeNull();
    expect(span.style.getPropertyValue("--inlay-hints-text")).toBe('": number"');
    expect(span.classList.contains("inlay-hints-pad-left")).toBe(true);
    expect(span.classList.contains("inlay-hints-pad-right")).toBe(false);
    // The hint on the empty line cannot span a character and is dropped.
    expect(stateFor().hints.size).toBe(1);
  });

  it("uses the ::after variant for hints at the end of a line", async () => {
    addProvider({ inlayHints: () => [hintAt(2, 10, " -> int")] });
    await microtasks();
    const span = editor.getElement().querySelector(".line .inlay-hints-after");
    expect(span).not.toBeNull();
    expect(span.style.getPropertyValue("--inlay-hints-text")).toBe('" -> int"');
    expect(entries()[0].marker.getBufferRange().toString()).toBe("[(2, 9) - (2, 10)]");
  });

  it("truncates labels beyond maxLabelLength", async () => {
    lumine.config.set("inlay-hints.maxLabelLength", 5);
    addProvider({ inlayHints: () => [hintAt(0, 6, "abcdefgh")] });
    await microtasks();
    expect(entries()[0].properties.style["--inlay-hints-text"]).toBe(JSON.stringify("abcde…"));
  });

  it("reuses markers and decoration properties across identical refetches", async () => {
    const calls = [];
    const provider = addProvider({
      inlayHints: (fetchEditor, range) => {
        calls.push(range);
        return [hintAt(0, 11, ": number"), hintAt(2, 4, "x:")];
      },
    });
    await microtasks();
    const state = stateFor();
    const before = new Map(state.hints);
    expect(before.size).toBe(2);
    provider.invalidate();
    await microtasks();
    expect(calls.length).toBe(2);
    expect(state.hints.size).toBe(2);
    for (const [key, entry] of state.hints) {
      expect(entry).toBe(before.get(key));
      expect(entry.marker.isDestroyed()).toBe(false);
    }
  });

  it("destroys stale hints inside the fetched range only", async () => {
    let hints = [hintAt(0, 11, ": number"), hintAt(2, 4, "x:")];
    addProvider({ inlayHints: () => hints });
    await microtasks();
    const state = stateFor();
    const keep = entries().find((entry) => entry.marker.getStartBufferPosition().row === 2);
    hints = [];
    // What the viewport tracker calls once only the first rows are on screen.
    manager.fetch(state, [0, 1]);
    await microtasks();
    expect(state.hints.size).toBe(1);
    expect(entries()[0]).toBe(keep);
  });

  it("drops every hint of a provider that declines, wherever it sits", async () => {
    let hints = [hintAt(0, 11, ": number"), hintAt(2, 4, "x:")];
    addProvider({ inlayHints: () => hints });
    await microtasks();
    expect(stateFor().hints.size).toBe(2);
    hints = null;
    manager.fetch(stateFor(), [0, 1]);
    await microtasks();
    expect(stateFor().hints.size).toBe(0);
  });

  it("keeps the hints on screen when a provider fails transiently", async () => {
    let fail = false;
    const provider = addProvider({
      inlayHints: () => {
        if (fail) return Promise.reject(new Error("reindexing"));
        return [hintAt(0, 11, ": number")];
      },
    });
    await microtasks();
    const before = entries()[0];
    fail = true;
    provider.invalidate();
    await microtasks();
    expect(entries().length).toBe(1);
    expect(entries()[0]).toBe(before);
    expect(before.marker.isDestroyed()).toBe(false);
  });

  it("merges the hints of every provider, rendering a duplicate once", async () => {
    addProvider({ inlayHints: () => [hintAt(0, 11, ": number"), hintAt(0, 16, "first:")] });
    const second = addProvider({
      priority: 2,
      inlayHints: () => [hintAt(0, 11, ": number"), hintAt(2, 4, "x:")],
    });
    await microtasks();
    const state = stateFor();
    expect(state.hints.size).toBe(3);
    // The higher-priority provider is asked first, so it owns the shared hint.
    const shared = [...state.hints].find(([key]) => key.startsWith("0:11:"))[1];
    expect(shared.provider).toBe(second);
  });

  it("fetches for a provider registered after the editor was open", async () => {
    expect(stateFor().hints.size).toBe(0);
    addProvider({ inlayHints: () => [hintAt(0, 11, ": number")] });
    await microtasks();
    expect(stateFor().hints.size).toBe(1);
  });

  it("drops the hints of a provider whose subscription is disposed", async () => {
    const subscription = mainModule.consumeInlayHints({
      get grammarScopes() {
        return [editor.getGrammar().scopeName];
      },
      inlayHints: () => [hintAt(0, 11, ": number")],
    });
    await microtasks();
    expect(stateFor().hints.size).toBe(1);
    subscription.dispose();
    await microtasks();
    expect(stateFor().hints.size).toBe(0);
  });

  it("honors a per-language scoped disable without asking the provider", async () => {
    const rootScope = editor.getRootScopeDescriptor().getScopesArray()[0];
    lumine.config.set("inlay-hints.enabled", false, { scopeSelector: `.${rootScope}` });
    const calls = [];
    addProvider({
      inlayHints: (...args) => {
        calls.push(args);
        return [hintAt(0, 11, ": n")];
      },
    });
    await microtasks();
    expect(calls.length).toBe(0);
    expect(stateFor().hints.size).toBe(0);
  });

  describe("the commands", () => {
    it("toggles the global setting and refetches", async () => {
      addProvider({ inlayHints: () => [hintAt(0, 11, ": number")] });
      await microtasks();
      expect(stateFor().hints.size).toBe(1);
      lumine.commands.dispatch(lumine.workspace.getElement(), "inlay-hints:toggle");
      await microtasks();
      expect(lumine.config.get("inlay-hints.enabled")).toBe(false);
      expect(stateFor().hints.size).toBe(0);
    });

    it("warns when the language keeps a setting of its own", async () => {
      const rootScope = editor.getRootScopeDescriptor().getScopesArray()[0];
      lumine.config.set("inlay-hints.enabled", true, { scopeSelector: `.${rootScope}` });
      lumine.commands.dispatch(lumine.workspace.getElement(), "inlay-hints:toggle");
      await microtasks();
      const [notification] = lumine.notifications.getNotifications();
      expect(notification.getType()).toBe("warning");
      expect(notification.getMessage()).toContain("stay on for this language");
    });

    it("refreshes the active editor", async () => {
      const calls = [];
      addProvider({
        inlayHints: () => {
          calls.push(true);
          return [];
        },
      });
      await microtasks();
      const before = calls.length;
      lumine.commands.dispatch(lumine.workspace.getElement(), "inlay-hints:refresh");
      await microtasks();
      expect(calls.length).toBe(before + 1);
    });
  });

  // The renderer resolves a point on a label to the column the label decorates
  // all by itself: `screenPositionForPixelPosition` asks `caretRangeFromPoint`,
  // which lands in a real text node on the line. So this package installs no
  // mousedown handling of its own, and pressing on a label starts an ordinary
  // drag-selection like pressing anywhere else does.
  it("leaves a press on a hint label to the renderer, which resolves it to the anchor", async () => {
    // The labels are pseudo-element content and occupy no space until this
    // package's own stylesheet is loaded.
    const styles = lumine.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "main.css"),
    );
    try {
      addProvider({ inlayHints: () => [hintAt(0, 11, ": number"), hintAt(2, 10, " -> int")] });
      await microtasks();
      const element = editor.getElement();
      const { component } = element;
      const linesRect = component.refs.lineTiles.getBoundingClientRect();
      const cases = [
        { selector: ".inlay-hints", row: 0, column: 11, atEnd: false },
        { selector: ".inlay-hints-after", row: 2, column: 10, atEnd: true },
      ];
      for (const { selector, row, column, atEnd } of cases) {
        const span = element.querySelector(`.line ${selector}`);
        expect(span).not.toBeNull();
        // The label occupies the side of the decorated span the character does
        // not: ::before runs from the span's left edge up to the character,
        // ::after from the character's right edge to the span's.
        const spanRect = span.getBoundingClientRect();
        const anchor = component.pixelPositionForScreenPosition({ row, column });
        const charEdge = linesRect.left + anchor.left;
        const from = atEnd ? charEdge : spanRect.left;
        const to = atEnd ? spanRect.right : charEdge;
        const clientY = linesRect.top + anchor.top + component.getLineHeight() / 2;
        // Pixels the label draws that no character occupies...
        expect(to - from).toBeGreaterThan(component.getBaseCharacterWidth());
        // ...every one of which names the column the hint is anchored to.
        for (const clientX of [from + 1, (from + to) / 2, to - 1]) {
          const pixelPosition = component.pixelPositionForMouseEvent({ clientX, clientY });
          expect(component.screenPositionForPixelPosition(pixelPosition).toArray()).toEqual([
            row,
            column,
          ]);
        }

        editor.setCursorBufferPosition([1, 0]);
        const event = new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 1,
          clientX: (from + to) / 2,
          clientY,
        });
        span.dispatchEvent(event);
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        expect(editor.getCursorBufferPosition().toArray()).toEqual([row, column]);
        // Nothing swallows the press, so it still begins a drag-selection.
        expect(event.defaultPrevented).toBe(false);
      }
    } finally {
      styles.dispose();
    }
  });

  it("asks for the rows the viewport tracker reports", async () => {
    const calls = [];
    addProvider({
      inlayHints: (fetchEditor, range) => {
        calls.push(range);
        return [];
      },
    });
    await microtasks();
    expect(calls[calls.length - 1]).toEqual(wholeBuffer());
  });
});

describe("ViewportTracker", () => {
  let editor, viewportTracker;

  beforeEach(async () => {
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    editor = await lumine.workspace.open(path.join(os.tmpdir(), "viewport-tracker-example.js"));
    editor.setText("x\n".repeat(300));
  });

  afterEach(() => {
    viewportTracker?.dispose();
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  it("emits a clamped buffer-row range once scrolling settles", async () => {
    viewportTracker = new ViewportTracker();
    const events = [];
    viewportTracker.onDidBecomeStale((event) => events.push(event));
    const element = editor.getElement();
    element.setScrollTop(100 * element.component.getLineHeight());
    expect(events.length).toBe(0);
    advanceClock(150);
    expect(events.length).toBe(1);
    expect(events[0].editor).toBe(editor);
    const [start, end] = events[0].range;
    expect(start).toBe(Math.max(0, editor.getFirstVisibleScreenRow() - 50));
    expect(end).toBe(Math.min(300, editor.getLastVisibleScreenRow() + 50));
    expect(start).toBeGreaterThan(0);
  });

  it("reports the top of the buffer for an editor that has never been rendered", async () => {
    viewportTracker = new ViewportTracker();
    // An editor opened in a background tab reports no visible rows, and
    // converting that to a screen position throws on an invalid Point.
    const hidden = await lumine.workspace.buildTextEditor();
    hidden.setText("x\n".repeat(300));
    expect(hidden.getFirstVisibleScreenRow()).not.toBeGreaterThan(0);
    const [start, end] = viewportTracker.rangeForEditor(hidden);
    expect(start).toBe(0);
    expect(Number.isFinite(end)).toBe(true);
    expect(end).toBeGreaterThan(0);
    hidden.destroy();
  });

  it("emits when the buffer stops changing", async () => {
    viewportTracker = new ViewportTracker();
    const events = [];
    viewportTracker.onDidBecomeStale((event) => events.push(event));
    editor.setTextInBufferRange(
      [
        [0, 0],
        [0, 0],
      ],
      "y",
    );
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    expect(events.length).toBe(1);
    expect(events[0].range[0]).toBe(0);
  });
});
