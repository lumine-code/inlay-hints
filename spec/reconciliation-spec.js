const os = require("os");
const path = require("path");
const { CompositeDisposable, Emitter } = require("lumine");

const packageRoot = path.join(__dirname, "..");

async function microtasks(count = 40) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

const hintAt = (row, column, label, extra = {}) => ({ position: [row, column], label, ...extra });

// Computed content is a CSS string, including hexadecimal escapes for control
// characters. Decode it to check what the pseudo-element actually displays.
function textForContent(content) {
  return content
    .slice(1, -1)
    .replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?|\\([\s\S])/gi, (_match, hex, character) =>
      hex ? String.fromCodePoint(parseInt(hex, 16)) : character,
    );
}

describe("inlay-hints reconciliation", () => {
  let editor, mainModule, manager, disposables;

  const stateFor = () => manager.states.get(editor);
  const entries = () => [...stateFor().hints.values()];
  const contentAt = (span, side) => textForContent(getComputedStyle(span, side).content);

  beforeEach(async () => {
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    disposables = new CompositeDisposable();
    editor = await lumine.workspace.open(path.join(os.tmpdir(), "inlay-hints-reconciliation.js"));
    editor.setText("const sum = add(first, second);\n\nlet x = 5;\n");
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);

    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;
    manager = mainModule.manager;
    lumine.config.set("inlay-hints.enabled", true);
    lumine.config.set("inlay-hints.maxLabelLength", 48);
    disposables.add(lumine.themes.requireStylesheet(path.join(packageRoot, "styles", "main.css")));
    await microtasks();
  });

  afterEach(async () => {
    disposables.dispose();
    await lumine.packages.deactivatePackage("inlay-hints");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  function addProvider(inlayHints) {
    const emitter = new Emitter();
    const provider = {
      get grammarScopes() {
        return [editor.getGrammar().scopeName];
      },
      inlayHints,
      onDidInvalidate: (fn) => emitter.on("invalidate", fn),
      invalidate: () => emitter.emit("invalidate"),
    };
    const subscription = mainModule.consumeInlayHints(provider);
    provider.dispose = () => subscription.dispose();
    disposables.add(emitter, subscription);
    return provider;
  }

  it("replaces a touched marker when the provider returns the same hint", async () => {
    const provider = addProvider(() => [hintAt(0, 11, ": number")]);
    await microtasks();
    const oldMarker = entries()[0].marker;
    editor.setTextInBufferRange(
      [
        [0, 11],
        [0, 12],
      ],
      "x",
    );
    expect(oldMarker.isValid()).toBe(false);
    provider.invalidate();
    await microtasks();

    expect(entries()[0].marker.isValid()).toBe(true);
    expect(entries()[0].marker).not.toBe(oldMarker);
    expect(entries()[0].marker.getBufferRange().toString()).toBe("[(0, 11) - (0, 12)]");
    expect(editor.getElement().querySelector(".line .inlay-hints")).not.toBeNull();
  });

  it("does not reuse a moved marker for a hint at its old position", async () => {
    const provider = addProvider(() => [hintAt(0, 11, ": number")]);
    await microtasks();
    editor.setTextInBufferRange(
      [
        [0, 0],
        [0, 0],
      ],
      "x",
    );
    provider.invalidate();
    await microtasks();

    expect(entries()[0].marker.getBufferRange().toString()).toBe("[(0, 11) - (0, 12)]");
  });

  it("reuses a valid moved marker when the returned anchor moved with it", async () => {
    let column = 11;
    const provider = addProvider(() => [hintAt(0, column, ": number")]);
    await microtasks();
    const oldMarker = entries()[0].marker;
    editor.setTextInBufferRange(
      [
        [0, 0],
        [0, 0],
      ],
      "x",
    );
    column = 12;
    provider.invalidate();
    await microtasks();

    expect(entries()[0].marker).toBe(oldMarker);
    expect(oldMarker.isValid()).toBe(true);
    expect(oldMarker.getBufferRange().toString()).toBe("[(0, 12) - (0, 13)]");
  });

  it("rejects an async response as soon as the buffer changes", async () => {
    let resolve;
    addProvider(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await microtasks();
    editor.setTextInBufferRange(
      [
        [0, 0],
        [0, 0],
      ],
      "x",
    );
    resolve([hintAt(0, 11, ": stale")]);
    // Do not advance the stopped-changing debounce: stale data must already
    // be rejected while the user is still typing.
    await microtasks();

    expect(stateFor().hints.size).toBe(0);
  });

  it("refetches path-dependent hints after a rename with unchanged text and grammar", async () => {
    const oldPath = editor.getPath();
    const newPath = path.join(os.tmpdir(), "inlay-hints-reconciliation-renamed.js");
    const text = editor.getText();
    const grammar = editor.getGrammar();
    const calls = [];
    addProvider((fetchEditor) => {
      calls.push(fetchEditor.getPath());
      return [hintAt(0, 11, fetchEditor.getPath() === oldPath ? "before:" : "after:")];
    });
    await microtasks();
    editor.getBuffer().setPath(newPath);
    await microtasks();

    expect(editor.getText()).toBe(text);
    expect(editor.getGrammar()).toBe(grammar);
    expect(calls).toContain(newPath);
    expect(contentAt(editor.getElement().querySelector(".line .inlay-hints"), "::before")).toBe(
      "after:",
    );
  });

  it("rejects a response requested for the old path after the renamed file's response arrives", async () => {
    const oldPath = editor.getPath();
    const newPath = path.join(os.tmpdir(), "inlay-hints-reconciliation-pending-renamed.js");
    const requests = [];
    addProvider(
      (fetchEditor) =>
        new Promise((resolve) => {
          requests.push({ path: fetchEditor.getPath(), resolve });
        }),
    );
    await microtasks();
    const previous = requests.find((request) => request.path === oldPath);
    editor.getBuffer().setPath(newPath);
    await microtasks();
    const current = requests.findLast((request) => request.path === newPath);
    expect(current).toBeDefined();
    if (!current) return;
    current.resolve([hintAt(0, 11, "current:")]);
    await microtasks();
    previous.resolve([hintAt(0, 11, "stale:")]);
    await microtasks();

    expect(contentAt(editor.getElement().querySelector(".line .inlay-hints"), "::before")).toBe(
      "current:",
    );
  });

  it("ignores hints outside the requested row range", async () => {
    let hints = [];
    addProvider(() => hints);
    await microtasks();
    hints = [hintAt(0, 11, ": number"), hintAt(2, 4, "x:")];
    await manager.fetch(stateFor(), [0, 0]);
    await microtasks();

    expect(entries().length).toBe(1);
    expect(entries()[0].marker.getStartBufferPosition().row).toBe(0);
  });

  it("renders distinct labels supplied at the same anchor", async () => {
    addProvider(() => [hintAt(0, 11, "type:"), hintAt(0, 11, "parameter:")]);
    await microtasks();
    const spans = [...editor.getElement().querySelectorAll(".line .inlay-hints")];
    const visibleText = spans.map((span) => contentAt(span, "::before")).join("");

    expect(visibleText).toContain("type:");
    expect(visibleText).toContain("parameter:");
  });

  it("retains a failed provider's grouped label while the other provider changes or removes its label", async () => {
    let fail = false;
    const first = addProvider(() => {
      if (fail) return Promise.reject(new Error("reindexing"));
      return [hintAt(0, 11, "type:")];
    });
    let hints = [hintAt(0, 11, "old:")];
    addProvider(() => hints);
    await microtasks();
    fail = true;
    hints = [hintAt(0, 11, "new:")];
    first.invalidate();
    await microtasks();

    let span = editor.getElement().querySelector(".line .inlay-hints");
    expect(contentAt(span, "::before")).toBe("type:new:");
    hints = [];
    first.invalidate();
    await microtasks();
    span = editor.getElement().querySelector(".line .inlay-hints");
    expect(contentAt(span, "::before")).toBe("type:");
  });

  it("removes a disposed provider's grouped label while the remaining provider has a pending request", async () => {
    const first = addProvider(() => [hintAt(0, 11, "removed:")]);
    let pending = false;
    const resolves = [];
    addProvider(() =>
      pending ? new Promise((resolve) => resolves.push(resolve)) : [hintAt(0, 11, "kept:")],
    );
    await microtasks();
    pending = true;
    first.invalidate();
    await microtasks();
    first.dispose();
    await microtasks();

    const span = editor.getElement().querySelector(".line .inlay-hints");
    expect(contentAt(span, "::before")).toBe("kept:");
    for (const resolve of resolves) resolve([hintAt(0, 11, "kept:")]);
    await microtasks();
    expect(contentAt(editor.getElement().querySelector(".line .inlay-hints"), "::before")).toBe(
      "kept:",
    );
  });

  it("keeps labels before the last character and after the line distinct", async () => {
    const lineLength = editor.getBuffer().lineLengthForRow(0);
    addProvider(() => [hintAt(0, lineLength - 1, "before:"), hintAt(0, lineLength, ":after")]);
    await microtasks();
    const span = editor.getElement().querySelector(".line .inlay-hints.inlay-hints-after");

    expect(span).not.toBeNull();
    expect(contentAt(span, "::before")).toBe("before:");
    expect(contentAt(span, "::after")).toBe(":after");
  });

  it("applies padding independently before the last character and after the line", async () => {
    const lineLength = editor.getBuffer().lineLengthForRow(0);
    addProvider(() => [
      hintAt(0, lineLength - 1, "before:", { paddingLeft: true }),
      hintAt(0, lineLength, ":after", { paddingRight: true }),
    ]);
    await microtasks();
    const span = editor.getElement().querySelector(".line .inlay-hints.inlay-hints-after");
    const before = getComputedStyle(span, "::before");
    const after = getComputedStyle(span, "::after");

    expect(parseFloat(before.marginLeft)).toBeGreaterThan(1);
    expect(parseFloat(before.marginRight)).toBe(1);
    expect(parseFloat(after.marginLeft)).toBe(1);
    expect(parseFloat(after.marginRight)).toBeGreaterThan(1);
  });

  it("truncates labels without splitting an emoji's surrogate pair", async () => {
    lumine.config.set("inlay-hints.maxLabelLength", 2);
    addProvider(() => [hintAt(0, 11, "x😀y")]);
    await microtasks();
    const span = editor.getElement().querySelector(".line .inlay-hints");

    expect(contentAt(span, "::before")).toBe("x😀…");
  });

  it("preserves CSS control characters, quotes and backslashes in labels", async () => {
    const label = 'first\nsecond\rthird\fend "quoted" \\path';
    addProvider(() => [hintAt(0, 11, label)]);
    await microtasks();
    const span = editor.getElement().querySelector(".line .inlay-hints");

    expect(contentAt(span, "::before")).toBe(label);
  });

  it("does not render a pending response after the package is deactivated", async () => {
    let resolve;
    addProvider(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await microtasks();
    const state = stateFor();
    const render = spyOn(manager, "render").and.callThrough();
    await lumine.packages.deactivatePackage("inlay-hints");
    resolve([hintAt(0, 11, ": late")]);
    await microtasks();

    expect(render).not.toHaveBeenCalled();
    expect(state.hints.size).toBe(0);
    expect(manager.states.size).toBe(0);
    expect(editor.getElement().querySelector(".line .inlay-hints")).toBeNull();
  });
});
