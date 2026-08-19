# inlay-hints.provider

Supplies the labels rendered inline between the characters they annotate.

|             |                                                             |
| ----------- | ----------------------------------------------------------- |
| Version     | `1.0.0`                                                     |
| Provided by | `provideInlayHints()` returning one provider                |
| Consumed by | `consumeInlayHints(provider)` returning a `Disposable`      |
| Owner       | [`inlay-hints`](https://github.com/lumine-code/inlay-hints) |

If your hints come from a language server, register an adapter with `ide-client` instead — it already provides this service on every adapter's behalf. Implement this directly only for a source that is not LSP: a type inferencer of your own, a profiler annotating call sites, a spreadsheet of measured values.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "inlay-hints.provider": {
      "versions": { "1.0.0": "provideInlayHints" }
    }
  }
}
```

## Contract

```ts
type InlayHintsProvider = {
  inlayHints(
    editor: TextEditor,
    range: [number, number],
  ): Promise<InlayHint[] | null> | InlayHint[] | null;
  onDidInvalidate?(callback: (event: { editor?: TextEditor }) => void): Disposable;
  grammarScopes?: string[] | Set<string>;
  priority?: number;
};

type InlayHint = {
  position: Point | [number, number];
  label: string;
  paddingLeft?: boolean;
  paddingRight?: boolean;
};
```

Required members:

| Member                      | Description                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `inlayHints(editor, range)` | The hints inside the row range, or `null` to decline this editor. See Range and Return outcomes. |

Optional members:

| Member                      | Description                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `onDidInvalidate(callback)` | Announce that your hints went stale. Pass `{editor}` to refetch one, nothing to refetch all.     |
| `grammarScopes`             | Scope names you serve. **Omitting it means every grammar.** May be a getter — see Behavior.      |
| `priority`                  | Decides who wins when two providers offer the same hint. Defaults to `0`; `ide-client` uses `2`. |

`position` is a **buffer** position, and the label is drawn immediately before the character there. A column past the end of its line anchors the label after the line's last character instead. A hint on an empty line is dropped: a label needs a character to hang from.

`label` is the finished text, however your source spells it — the `: number` of an inferred type, the `count:` of a named argument. It is truncated for display when it runs past the `inlay-hints.maxLabelLength` setting, so return the whole thing and let the setting decide. An empty label drops the hint.

`paddingLeft` and `paddingRight` ask for a space's worth of room on that side, for a label that would otherwise read as part of the code beside it.

## Range

`range` is `[startBufferRow, endBufferRow]`, **inclusive at both ends**, and covers the rows on screen plus a margin. Hints outside it are ignored, so a provider that finds it cheaper to answer for the whole buffer may — the extra work is simply discarded.

The consequence worth knowing: the rows outside the range are not being asked about, so whatever was rendered there **stays**. Only the answered rows are reconciled. This is what lets scrolling through a long file cost one small request per screen rather than a full-document pass.

## Return outcomes

Three answers, and each says something different about what is already on screen:

| Return             | Meaning                                                              | What happens to your hints                        |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------- |
| An array           | This is the answer for those rows.                                   | Reconciled: stale hints inside the range go.      |
| `null`             | You cannot serve this editor now — no session, no support, disabled. | All of yours are dropped, in and out of range.    |
| A rejected promise | Something failed transiently: a server reindexing, a timeout.        | All of yours stay untouched until the next fetch. |

The distinction matters when a source is momentarily unavailable. Returning `null` there would blank every label and repaint them a moment later; rejecting keeps the screen still. Reserve `null` for "there is genuinely nothing here".

## Minimal example

```js
module.exports = {
  provideInlayHints() {
    return {
      grammarScopes: ["source.mylang"],
      async inlayHints(editor, [startRow, endRow]) {
        const types = await inferTypes(editor.getText());
        return types
          .filter(({ row }) => row >= startRow && row <= endRow)
          .map(({ row, column, name }) => ({
            position: [row, column],
            label: `: ${name}`,
            paddingLeft: false,
          }));
      },
    };
  },
};
```

## Behavior

Every provider serving the editor's grammar is asked with the same range, and all of their hints are shown together. Two providers returning the identical hint — same position, same label, same padding — render it once, and the higher-priority provider owns it. Priority breaks a tie; it does not silence anyone.

Hints are fetched for the visible rows when an editor is opened or revealed, when scrolling settles, and when the buffer stops changing. Between fetches they ride anchored markers, so they keep pace with edits around them.

A refetch reconciles in place. A hint that reappears unchanged keeps its marker and its decoration untouched, which is what lets the renderer skip rebuilding that line at all. Return your hints the same way each time and a steady file costs nothing to redraw.

`grammarScopes` is **read through on every call, never snapshotted**. That is deliberate: a hub provider exposes it as a getter whose value changes as language server sessions come and go. A plain array is fine for a fixed set of grammars, but do not assume the registry cached it.

Rendering is gated by the scoped `inlay-hints.enabled` setting — on by default, so a user can switch it off for one language and not for the rest. While it is off no provider is asked at all — `inlayHints` is never called, so an expensive provider costs nothing where nobody wants it.

## Teardown

`consumeInlayHints` returns a `Disposable` that removes the provider from the registry and drops whatever it had rendered. Return it from your own consumer method or add it to your collection; nothing else is held on your behalf.

The `Disposable` returned by `onDidInvalidate` is disposed for you when the provider is removed.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
