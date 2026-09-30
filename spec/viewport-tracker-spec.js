const os = require("node:os");
const path = require("node:path");

describe("ViewportTracker layout changes", () => {
  let editor, tracker, events, intersections, resizes, styles;

  beforeEach(async () => {
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    editor = await lumine.workspace.open(path.join(os.tmpdir(), "inlay-hints-layout.js"));
    editor.getElement().setUpdatedSynchronously(true);
    editor.setText("x\n".repeat(300));
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    intersections = [];
    resizes = [];
    for (const [name, instances] of [
      ["IntersectionObserver", intersections],
      ["ResizeObserver", resizes],
    ]) {
      spyOn(window, name).and.callFake(function (callback) {
        this.callback = callback;
        this.observe = jasmine.createSpy("observe");
        this.disconnect = jasmine.createSpy("disconnect");
        instances.push(this);
      });
    }
    events = [];
  });

  afterEach(() => {
    styles?.dispose();
    styles = null;
    tracker?.dispose();
    tracker = null;
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  function track() {
    // Package unloads can discard the previous module generation.
    const ViewportTracker = require("../lib/viewport-tracker");
    tracker = new ViewportTracker();
    tracker.onDidBecomeStale((event) => events.push(event));
  }

  it("refetches newly exposed rows after folding without scrolling", () => {
    track();
    const before = tracker.rangeForEditor(editor);
    editor.foldBufferRange([
      [0, 1],
      [200, 1],
    ]);
    expect(editor.getElement().getScrollTop()).toBe(0);
    expect(events.length).toBe(0);
    advanceClock(150);
    expect(events.length).toBe(1);
    expect(events[0].range).toEqual(tracker.rangeForEditor(editor));
    expect(events[0].range[1]).toBeGreaterThan(before[1]);
  });

  it("refetches when unwrapping exposes a different row range", () => {
    editor.setText(`${"x".repeat(400)}\n`.repeat(300));
    editor.setSoftWrapped(true);
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    track();
    const before = tracker.rangeForEditor(editor);
    editor.setSoftWrapped(false);
    expect(editor.getElement().getScrollTop()).toBe(0);
    advanceClock(150);
    expect(events.length).toBe(1);
    expect(events[0].range[1]).toBeGreaterThan(before[1]);
  });

  it("refetches when resizing changes the visible range without scrolling", () => {
    track();
    const before = tracker.rangeForEditor(editor);
    const component = editor.getElement().component;
    component.refs.clientContainer.style.height = "2000px";
    component.didResize();
    resizes[0].callback([]);
    expect(editor.getElement().getScrollTop()).toBe(0);
    advanceClock(150);
    expect(events.length).toBe(1);
    expect(events[0].range[1]).toBeGreaterThan(before[1]);
  });

  it("coalesces simultaneous resize and scroll notifications into one fetch", () => {
    track();
    resizes[0].callback([]);
    const element = editor.getElement();
    element.setScrollTop(100 * element.component.getLineHeight());
    advanceClock(150);
    expect(events.length).toBe(1);
    expect(events[0].range).toEqual(tracker.rangeForEditor(editor));
  });

  it("refetches when a font stylesheet exposes more unwrapped rows", () => {
    track();
    const before = tracker.rangeForEditor(editor);
    styles = lumine.styles.addStyleSheet("lumine-text-editor { font-size: 8px; line-height: 1; }", {
      priority: 1000,
    });
    editor.getElement().component.updateSync();
    expect(editor.getElement().getScrollTop()).toBe(0);
    advanceClock(150);
    expect(events.length).toBe(1);
    expect(events[0].range[1]).toBeGreaterThan(before[1]);
  });

  it("waits for reveal measurements even when its observer runs first", () => {
    track();
    intersections[0].callback([{ intersectionRect: { width: 0, height: 0 } }]);
    intersections[0].callback([{ intersectionRect: { width: 800, height: 400 } }]);
    // Reveal measurements happen after the package's intersection callback.
    spyOn(editor, "getFirstVisibleScreenRow").and.returnValue(150);
    spyOn(editor, "getLastVisibleScreenRow").and.returnValue(170);
    expect(events.length).toBe(0);
    advanceClock(150);
    expect(events.length).toBe(1);
    expect(events[0].range).toEqual([100, 220]);
  });

  it("checks the initial reveal against measurements from before attachment", () => {
    spyOn(editor, "getFirstVisibleScreenRow").and.returnValue(Number.NaN);
    spyOn(editor, "getLastVisibleScreenRow").and.returnValue(Number.NaN);
    track();
    intersections[0].callback([{ intersectionRect: { width: 800, height: 400 } }]);
    editor.getFirstVisibleScreenRow.and.returnValue(150);
    editor.getLastVisibleScreenRow.and.returnValue(170);
    advanceClock(150);
    expect(events.length).toBe(1);
    expect(events[0].range).toEqual([100, 220]);
  });

  it("keeps the stopped-changing debounce for ordinary edits", () => {
    track();
    editor.setTextInBufferRange(
      [
        [0, 0],
        [0, 0],
      ],
      "y",
    );
    advanceClock(150);
    expect(events.length).toBe(0);
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    expect(events.length).toBe(1);
  });

  it("disposes pending layout checks and both browser observers", () => {
    track();
    resizes[0].callback([]);
    tracker.dispose();
    advanceClock(150);
    expect(events.length).toBe(0);
    expect(intersections[0].disconnect).toHaveBeenCalled();
    expect(resizes[0].disconnect).toHaveBeenCalled();
  });
});
