# inlay-hints

Show inferred types and parameter names as inline labels.

Hints come from provider packages — typically language-server backends — and are drawn between the characters they annotate, printing what the code leaves implicit without ever changing the file.

## Features

- **Inline labels**: renders each hint as a small label inside the line, so an inferred type or an argument name reads where it belongs.
- **Viewport-driven**: asks only for the rows on screen, and catches up when scrolling settles or a background editor is revealed.
- **Label reuse**: reconciles a refetch hint by hint, so labels that survive keep their decoration and the line is never rebuilt.
- **Every source at once**: merges the hints of all providers claiming the editor's grammar, and renders a duplicate once.
- **Per language**: on everywhere by default, and can be switched off for one language and not the rest through scoped settings.
- **Truncation**: cuts a long label with an ellipsis at a length you choose, so a wide generic type cannot push the code off screen.

## Installation

To install `inlay-hints` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/inlay-hints`.

## Commands

Commands available in `lumine-workspace`:

- `inlay-hints:toggle`: show or hide the inline type and parameter-name labels,
- `inlay-hints:refresh`: ask the providers for the active file's hints again.

## Customization

The labels can be adjusted in the `styles.css` file, e.g. draw them without a background:

```css
.inlay-hints::before,
.inlay-hints-after::after {
  background-color: transparent;
  font-style: italic;
}
```

## Services

- [`inlay-hints.provider`](docs/inlay-hints.provider.md): consumed to collect the labels rendered inside the code, from providers such as IDE backend packages.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
