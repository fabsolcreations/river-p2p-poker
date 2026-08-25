# Print files — Drop 001

Upload the **.png** files to Printful. They're transparent-background, 300 DPI,
sized to standard print areas. The **.svg** twins are the editable originals.

| File | Size | DPI area | Use on |
|---|---|---|---|
| `gambling-is-easy.png` | 3600x4800 | 12x16in | Hoodie front (white ink, dark garment) |
| `coming-2029.png` | 3600x4800 | 12x16in | Tee front (dark garment) |
| `duel-cow.png` | 3600x4800 | 12x16in | Tee front (**light** garment — art is dark) |
| `duelmerch-wordmark.png` | 3600x4800 | 12x16in | Longsleeve chest (dark garment) |
| `sleeve-any-day-now.png` | 4200x1050 | 14x3.5in | Longsleeve sleeves (run one on each arm) |
| `cap-lore.png` | 1500x750 | 5x2.5in | Cap front — embroidery |
| `beanie-ev.png` | 1050x525 | 3.5x1.75in | Beanie patch |
| `lousy-tee-SAMPLE-4000.png` | 3600x4800 | 12x16in | **Sample only** — see below |

## Things to know before uploading

- **Ink colour vs garment.** Everything except `duel-cow` is white/bright art
  meant for dark garments. `duel-cow` is dark art and needs a light garment.
  Putting either on the wrong colour makes it invisible.
- **The Lousy T-Shirt can't be a fixed file.** Every buyer prints their own
  number, so that one needs Printful's personalisation/text layer, with the
  amount fed per order (the checkout already sends it as `custom_text`). The
  SAMPLE file is there to show the layout and to test one physical print.
- **Cap and beanie are embroidery, not DTG.** Printful will likely want the
  artwork re-supplied as vector or will digitise it themselves; the `.svg` is
  the file to hand over. Embroidery also can't do fine detail — if `LORE` at
  that weight gives them trouble, it can be thickened.
- **Fonts are rasterised in the PNGs**, so the printer needs nothing installed.
  The SVGs use Inter and Tinos (Times New Roman substitutes fine); if you edit
  the SVGs, convert text to outlines before sending them anywhere.

## Regenerating

The generator script lives in the scratchpad (`print-files.mjs`) — sizes,
colours and copy are all near the top. Ask and I'll rebuild any of them at a
different size or placement.
