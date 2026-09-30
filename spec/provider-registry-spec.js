const { Emitter } = require("lumine");
const ProviderRegistry = require("../lib/provider-registry");

describe("ProviderRegistry", () => {
  let registry, emitter;

  beforeEach(() => {
    registry = new ProviderRegistry();
    emitter = new Emitter();
  });

  afterEach(() => {
    registry.dispose();
    emitter.dispose();
  });

  const editorFor = (scopeName) => ({ getGrammar: () => ({ scopeName }) });

  it("keeps duplicate registrations independent while exposing and subscribing once", () => {
    const provider = {
      inlayHints: () => [],
      onDidInvalidate: jasmine
        .createSpy("subscribe")
        .and.callFake((fn) => emitter.on("invalidate", fn)),
    };
    const changed = jasmine.createSpy("changed");
    const invalidated = jasmine.createSpy("invalidated");
    registry.onDidChange(changed);
    registry.onDidInvalidate(invalidated);

    const first = registry.addProvider(provider);
    const second = registry.addProvider(provider);
    expect(registry.getAllProvidersForEditor(editorFor("source.js"))).toEqual([provider]);
    expect(provider.onDidInvalidate.calls.count()).toBe(1);
    expect(changed.calls.count()).toBe(1);

    const editor = editorFor("source.js");
    emitter.emit("invalidate", { editor });
    expect(invalidated.calls.count()).toBe(1);
    expect(invalidated.calls.mostRecent().args[0]).toEqual({ provider, editor });

    first.dispose();
    first.dispose();
    expect(registry.getAllProvidersForEditor(editor)).toEqual([provider]);
    expect(changed.calls.count()).toBe(1);
    emitter.emit("invalidate", {});
    expect(invalidated.calls.count()).toBe(2);

    second.dispose();
    expect(registry.getAllProvidersForEditor(editor)).toEqual([]);
    expect(changed.calls.count()).toBe(2);
    emitter.emit("invalidate", {});
    expect(invalidated.calls.count()).toBe(2);
  });

  it("releases a duplicate provider's subscription when the registry is disposed", () => {
    const subscription = emitter.on("invalidate", () => {});
    spyOn(subscription, "dispose").and.callThrough();
    const provider = { inlayHints: () => [], onDidInvalidate: () => subscription };
    const first = registry.addProvider(provider);
    const second = registry.addProvider(provider);

    registry.dispose();
    expect(subscription.dispose.calls.count()).toBe(1);
    first.dispose();
    second.dispose();
    expect(subscription.dispose.calls.count()).toBe(1);
  });

  it("reads changing grammar scopes and keeps equal priorities in registration order", () => {
    let scopes = ["source.js"];
    const first = {
      inlayHints: () => [],
      priority: 2,
      get grammarScopes() {
        return scopes;
      },
    };
    const second = { inlayHints: () => [], priority: 2, grammarScopes: new Set(["source.js"]) };
    const fallback = { inlayHints: () => [] };
    registry.addProvider(fallback);
    registry.addProvider(first);
    registry.addProvider(second);

    expect(registry.getAllProvidersForEditor(editorFor("source.js"))).toEqual([
      first,
      second,
      fallback,
    ]);
    scopes = ["source.python"];
    expect(registry.getAllProvidersForEditor(editorFor("source.js"))).toEqual([second, fallback]);
    expect(registry.getAllProvidersForEditor(editorFor("source.python"))).toEqual([
      first,
      fallback,
    ]);
  });
});
