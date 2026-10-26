const path = require("node:path");
const { CompositeDisposable } = require("lumine");

describe("inlay hints without a grammar", () => {
  let editor, grammar, mainModule, manager, disposables;
  const settle = async () => {
    for (let index = 0; index < 40; index++) await Promise.resolve();
  };
  const labels = () => [...manager.states.get(editor).hints.values()].map((hint) => hint.label);
  const hint = (label) => [{ position: [0, 1], label }];
  const register = (inlayHints) => {
    disposables.add(mainModule.consumeInlayHints({ inlayHints }));
  };

  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
    editor = await lumine.workspace.open();
    grammar = editor.getGrammar();
    editor.setText("example");
    editor.setGrammar(lumine.grammars.nullGrammar);
    lumine.config.set("inlay-hints.enabled", true);
    const pack = await lumine.packages.activatePackage(path.join(__dirname, ".."));
    mainModule = pack.mainModule;
    manager = mainModule.manager;
    disposables = new CompositeDisposable();
  });

  afterEach(async () => {
    disposables.dispose();
    await lumine.packages.deactivatePackage("inlay-hints");
    editor.destroy();
  });

  it("does not ask providers for a newly attached None editor or its edits", async () => {
    const analyze = jasmine.createSpy("analyze source").and.callFake(() => {
      editor.getText();
      return hint("active");
    });
    register(analyze);
    editor.insertText("more");
    advanceClock(editor.getBuffer().stoppedChangingDelay + 200);
    await settle();
    expect(analyze).not.toHaveBeenCalled();
    expect(labels()).toEqual([]);

    editor.setGrammar(grammar);
    await settle();
    expect(analyze).toHaveBeenCalled();
    expect(labels()).toEqual(["active"]);
  });

  it("resumes before an older request resolves and rejects that request's late hints", async () => {
    let resolveOld;
    const oldRequest = new Promise((resolve) => (resolveOld = resolve));
    const analyze = jasmine.createSpy("analyze").and.returnValues(oldRequest, hint("new"));
    register(analyze);
    editor.setGrammar(grammar);
    expect(analyze.calls.count()).toBe(1);
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(labels()).toEqual([]);
    editor.setGrammar(grammar);
    await settle();
    expect(analyze.calls.count()).toBe(2);
    expect(labels()).toEqual(["new"]);
    resolveOld(hint("old"));
    await settle();
    expect(labels()).toEqual(["new"]);
  });

  it("stops a provider batch when an earlier provider selects None synchronously", async () => {
    let suspend = true;
    const first = jasmine.createSpy("first provider").and.callFake(() => {
      if (suspend) {
        suspend = false;
        editor.setGrammar(lumine.grammars.nullGrammar);
      }
      return hint("first");
    });
    const second = jasmine.createSpy("second provider").and.returnValue([]);
    register(first);
    register(second);
    editor.setGrammar(grammar);
    await settle();
    expect(first.calls.count()).toBe(1);
    expect(second).not.toHaveBeenCalled();
    expect(labels()).toEqual([]);

    editor.setGrammar(grammar);
    await settle();
    expect(first.calls.count()).toBe(2);
    expect(second.calls.count()).toBe(1);
    expect(labels()).toEqual(["first"]);
  });

  it("retires a hint created while a decoration callback selects None", async () => {
    const decorate = editor.decorateMarker.bind(editor);
    let retired;
    let suspend = true;
    spyOn(editor, "decorateMarker").and.callFake((marker, properties) => {
      const decoration = decorate(marker, properties);
      if (suspend && properties.class?.startsWith("inlay-hints")) {
        suspend = false;
        retired = marker;
        editor.setGrammar(lumine.grammars.nullGrammar);
      }
      return decoration;
    });
    register(() => hint("active"));
    editor.setGrammar(grammar);
    await settle();
    expect(retired).toBeDefined();
    expect(retired.isDestroyed()).toBeTrue();
    expect(labels()).toEqual([]);
    editor.setGrammar(grammar);
    await settle();
    expect(labels()).toEqual(["active"]);
  });
});
